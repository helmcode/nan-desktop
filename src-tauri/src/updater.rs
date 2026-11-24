// Auto-update (round 7).
//
// The renderer asks `update_check` on startup, every 2 hours and when the
// window comes back after more than 2 hours away (never more than once per
// 30 minutes; src/updateSchedule.ts); when the signed release feed
// (`plugins.updater.endpoints` in tauri.conf.json) has a newer version,
// the renderer shows a non-invasive banner. Nothing is ever downloaded or
// installed until the user clicks "Update", which calls `update_install`:
// download, minisign verification against the pubkey embedded in the app,
// install, relaunch.
//
// The update found by the last check is kept here so the install uses
// exactly the release the banner announced (the renderer never sends a URL
// or a version: nothing to tamper with over IPC).
//
// Debug builds (`tauri dev`) skip the check unless
// HELMCODE_DESKTOP_UPDATER_IN_DEV=1: a dev build must not offer to replace
// itself with a release.

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Opt-in for running the check from a debug build (manual testing only).
pub const DEV_OPT_IN_ENV: &str = "HELMCODE_DESKTOP_UPDATER_IN_DEV";

/// What the banner needs to know. Mirrors `UpdateInfo` in src/core.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
}

/// One-slot holder for the update found by the last check.
pub struct Pending<T>(Mutex<Option<T>>);

impl<T> Default for Pending<T> {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

impl<T> Pending<T> {
    /// Store the latest check result (`None` clears a stale update).
    fn replace(&self, value: Option<T>) -> Result<(), String> {
        *self
            .0
            .lock()
            .map_err(|_| "updater state poisoned".to_string())? = value;
        Ok(())
    }

    /// Take the pending update out for installing.
    fn take(&self) -> Result<T, String> {
        self.0
            .lock()
            .map_err(|_| "updater state poisoned".to_string())?
            .take()
            .ok_or_else(|| "no_update".to_string())
    }

    /// Put an update back after a failed install so "Update" can be
    /// retried, unless a newer check already stored another one.
    fn restore(&self, value: T) {
        if let Ok(mut guard) = self.0.lock() {
            // Only fills an empty slot: a newer check result wins.
            let _ = guard.get_or_insert(value);
        }
    }
}

pub type UpdaterState = Pending<Update>;

fn checks_enabled(debug_build: bool, dev_opt_in: Option<&str>) -> bool {
    !debug_build || dev_opt_in == Some("1")
}

/// Ask the release feed for a newer version. Downloads nothing.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let opt_in = std::env::var(DEV_OPT_IN_ENV).ok();
    if !checks_enabled(cfg!(debug_assertions), opt_in.as_deref()) {
        return Ok(None);
    }
    let found = app
        .updater()
        .map_err(|err| err.to_string())?
        .check()
        .await
        .map_err(|err| err.to_string())?;
    let info = found.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
    });
    app.state::<UpdaterState>().replace(found)?;
    Ok(info)
}

/// The user's click on "Update": download + verify, then install and
/// relaunch on the MAIN thread. Never called without that click.
///
/// Field reports (0.2.18 -> 0.2.19, every OS): the app hung after the
/// install and had to be force-quit; on reopening it was updated. So the
/// install itself works and the exit/relaunch is what stalls. Hardening:
/// - the old `app.restart()` ran on a tokio worker, parked it forever and
///   relied on an event-loop exit request; now install + relaunch run on the
///   main thread (Tauri's direct path: cleanup, relaunch, exit), and on
///   Windows the updater's own `exit(0)` also runs there instead of on a
///   worker while WebView2 is alive;
/// - telemetry is flushed BEFORE the install (no exit-time flush needed);
/// - a watchdog ends the process if it is still alive [`WATCHDOG_AFTER`]
///   later, relaunching the new version first when nothing did;
/// - `update_install` / `update_applied` / `update_not_applied` events (a
///   marker file bridges the two launches) show in the data where an update
///   stops.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let update = state.take()?;
    let (from, to) = (update.current_version.clone(), update.version.clone());
    crate::telemetry::record(None, crate::telemetry::update_install(&from, &to));
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(err) => {
            state.restore(update);
            return Err(err.to_string());
        }
    };
    let data_dir = app.path().app_data_dir().ok();
    if let Some(dir) = &data_dir {
        write_marker(dir, &PendingUpdate::new(&from, &to, unix_now()));
    }
    crate::telemetry::flush_before_update().await;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let handle = app.clone();
    let scheduled = app.run_on_main_thread(move || {
        watchdog::arm(handle.env());
        // Windows: runs the installer and exits the process from here.
        if let Err(err) = update.install(&bytes) {
            watchdog::disarm();
            handle.state::<UpdaterState>().restore(update);
            let _ = tx.send(err.to_string());
            return;
        }
        // macOS / Linux: the new version is in place.
        watchdog::mark_relaunching();
        handle.restart()
    });
    let failed = match scheduled {
        Ok(()) => rx.await.ok(),
        Err(err) => Some(err.to_string()),
    };
    match failed {
        // The process normally ends before this: a closed channel means the
        // relaunch is under way.
        None => Ok(()),
        Some(message) => {
            if let Some(dir) = &data_dir {
                remove_marker(dir);
            }
            Err(message)
        }
    }
}

/// How long the old process may take to end after the install before the
/// watchdog ends it.
pub const WATCHDOG_AFTER: std::time::Duration = std::time::Duration::from_secs(20);

/// Last resort when the post-install exit stalls: relaunch the installed
/// version if the app never got to, then end this process without running
/// exit handlers (whatever stalled the normal exit cannot stall this).
mod watchdog {
    use std::sync::atomic::{AtomicU8, Ordering};

    const IDLE: u8 = 0;
    const ARMED: u8 = 1;
    const RELAUNCHING: u8 = 2;

    static STATE: AtomicU8 = AtomicU8::new(IDLE);

    /// What the watchdog does when it fires in `state`.
    #[derive(Debug, PartialEq, Eq)]
    pub enum Action {
        Nothing,
        /// The relaunch was never started (Windows: the installer
        /// relaunches; elsewhere the exit stalled before it).
        RelaunchThenExit,
        ExitOnly,
    }

    pub fn decide(state: u8, windows: bool) -> Action {
        match state {
            IDLE => Action::Nothing,
            RELAUNCHING => Action::ExitOnly,
            _ if windows => Action::ExitOnly,
            _ => Action::RelaunchThenExit,
        }
    }

    pub fn arm(env: tauri::Env) {
        if STATE.swap(ARMED, Ordering::SeqCst) != IDLE {
            return;
        }
        std::thread::spawn(move || {
            std::thread::sleep(super::WATCHDOG_AFTER);
            match decide(STATE.load(Ordering::SeqCst), cfg!(windows)) {
                Action::Nothing => {}
                Action::RelaunchThenExit => {
                    relaunch(&env);
                    hard_exit();
                }
                Action::ExitOnly => hard_exit(),
            }
        });
    }

    pub fn disarm() {
        STATE.store(IDLE, Ordering::SeqCst);
    }

    pub fn mark_relaunching() {
        STATE.store(RELAUNCHING, Ordering::SeqCst);
    }

    fn relaunch(env: &tauri::Env) {
        let Ok(exe) = tauri::process::current_binary(env) else {
            return;
        };
        #[cfg(target_os = "macos")]
        {
            // Contents/MacOS/<bin> -> the .app bundle, opened as a new
            // instance through LaunchServices (as Tauri's own relaunch).
            if let Some(bundle) = exe.ancestors().nth(3)
                && bundle.extension().is_some_and(|ext| ext == "app")
            {
                let _ = crate::process::hidden_command("/usr/bin/open")
                    .arg("-n")
                    .arg(bundle)
                    .stdin(std::process::Stdio::null())
                    .output();
                return;
            }
        }
        let _ = crate::process::hidden_command(exe)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }

    fn hard_exit() -> ! {
        #[cfg(unix)]
        unsafe {
            libc::_exit(0)
        }
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
            let _ = TerminateProcess(GetCurrentProcess(), 0);
            std::process::abort()
        }
        #[cfg(not(any(unix, windows)))]
        std::process::abort()
    }
}

/// The marker written right before installing, read by the next launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct PendingUpdate {
    pub from: String,
    pub to: String,
    pub started_at: u64,
}

impl PendingUpdate {
    pub fn new(from: &str, to: &str, started_at: u64) -> Self {
        Self {
            from: from.to_string(),
            to: to.to_string(),
            started_at,
        }
    }
}

const MARKER_FILE: &str = "pending-update.json";
/// A marker older than this is stale (an update abandoned long ago).
const MARKER_MAX_AGE_S: u64 = 7 * 24 * 3600;

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_marker(dir: &Path, pending: &PendingUpdate) {
    if let Ok(text) = serde_json::to_string(pending) {
        let _ = std::fs::write(dir.join(MARKER_FILE), text);
    }
}

fn remove_marker(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(MARKER_FILE));
}

/// The telemetry event for a marker found at launch (`None`: no event).
pub fn outcome_event(
    pending: &PendingUpdate,
    running: &str,
    now: u64,
) -> Option<crate::telemetry::EventSpec> {
    let age = now.saturating_sub(pending.started_at);
    if age > MARKER_MAX_AGE_S {
        return None;
    }
    Some(if running == pending.to {
        crate::telemetry::update_applied(&pending.from, &pending.to, age)
    } else {
        crate::telemetry::update_not_applied(&pending.from, &pending.to, running)
    })
}

/// At launch (after telemetry init): report how the last update ended and
/// clear the marker. Never fails.
pub fn report_pending_update(dir: &Path, running: &str) {
    let path = dir.join(MARKER_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    if let Ok(pending) = serde_json::from_str::<PendingUpdate>(&text)
        && let Some(event) = outcome_event(&pending, running, unix_now())
    {
        crate::telemetry::record(None, event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_builds_always_check_and_dev_builds_only_on_opt_in() {
        assert!(checks_enabled(false, None));
        assert!(checks_enabled(false, Some("0")));
        assert!(!checks_enabled(true, None));
        assert!(!checks_enabled(true, Some("true")));
        assert!(checks_enabled(true, Some("1")));
    }

    #[test]
    fn install_without_a_found_update_is_refused() {
        let pending: Pending<u32> = Pending::default();
        assert_eq!(pending.take(), Err("no_update".to_string()));
    }

    #[test]
    fn the_install_uses_the_update_the_last_check_found() {
        let pending: Pending<u32> = Pending::default();
        pending.replace(Some(1)).unwrap();
        pending.replace(Some(2)).unwrap();
        assert_eq!(pending.take(), Ok(2));
        // Taken: a second click cannot install twice.
        assert!(pending.take().is_err());
        // A check that finds nothing clears a stale update.
        pending.replace(Some(3)).unwrap();
        pending.replace(None).unwrap();
        assert!(pending.take().is_err());
    }

    #[test]
    fn a_failed_install_can_be_retried_but_never_hides_a_newer_check() {
        let pending: Pending<u32> = Pending::default();
        pending.replace(Some(1)).unwrap();
        let taken = pending.take().unwrap();
        pending.restore(taken);
        assert_eq!(pending.take(), Ok(1));

        pending.replace(Some(1)).unwrap();
        let taken = pending.take().unwrap();
        pending.replace(Some(2)).unwrap();
        pending.restore(taken);
        assert_eq!(pending.take(), Ok(2));
    }

    #[test]
    fn update_info_matches_the_renderer_shape() {
        let info = UpdateInfo {
            version: "0.3.0".into(),
            current_version: "0.2.0".into(),
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({ "version": "0.3.0", "current_version": "0.2.0" })
        );
    }

    #[test]
    fn the_watchdog_only_acts_once_armed_and_never_relaunches_twice() {
        use watchdog::{Action, decide};
        assert_eq!(decide(0, false), Action::Nothing);
        assert_eq!(decide(0, true), Action::Nothing);
        // Armed, the install never reached the relaunch: start the new version.
        assert_eq!(decide(1, false), Action::RelaunchThenExit);
        // Windows: the installer relaunches the app itself.
        assert_eq!(decide(1, true), Action::ExitOnly);
        // The relaunch already started: only end the stalled process.
        assert_eq!(decide(2, false), Action::ExitOnly);
        assert_eq!(decide(2, true), Action::ExitOnly);
    }

    #[test]
    fn the_next_launch_reports_whether_the_update_applied() {
        let pending = PendingUpdate::new("0.2.19", "0.2.20", 1_000);
        let applied = outcome_event(&pending, "0.2.20", 1_045).unwrap();
        assert_eq!(applied.name, "update_applied");
        assert_eq!(
            serde_json::Value::Object(applied.props),
            serde_json::json!({ "from": "0.2.19", "to": "0.2.20", "seconds": 45 })
        );
        let not = outcome_event(&pending, "0.2.19", 1_045).unwrap();
        assert_eq!(not.name, "update_not_applied");
        assert_eq!(
            serde_json::Value::Object(not.props),
            serde_json::json!({ "from": "0.2.19", "to": "0.2.20", "running": "0.2.19" })
        );
        // A marker from an update abandoned long ago says nothing.
        assert!(outcome_event(&pending, "0.2.20", 1_000 + 8 * 24 * 3600).is_none());
    }

    #[test]
    fn the_marker_is_reported_once_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        write_marker(
            dir.path(),
            &PendingUpdate::new("0.2.19", "0.2.20", unix_now()),
        );
        assert!(dir.path().join(MARKER_FILE).exists());
        report_pending_update(dir.path(), "0.2.20");
        assert!(!dir.path().join(MARKER_FILE).exists());
        // Garbage never fails the launch and is cleared too.
        std::fs::write(dir.path().join(MARKER_FILE), "not json").unwrap();
        report_pending_update(dir.path(), "0.2.20");
        assert!(!dir.path().join(MARKER_FILE).exists());
    }
}
