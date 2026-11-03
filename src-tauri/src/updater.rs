// Auto-update (round 7).
//
// The renderer asks `update_check` on startup and every 6 hours; when the
// signed release feed (`plugins.updater.endpoints` in tauri.conf.json) has a
// newer version, the renderer shows a non-invasive banner. Nothing is ever
// downloaded or installed until the user clicks "Update", which calls
// `update_install`: download, minisign verification against the pubkey
// embedded in the app, install, relaunch.
//
// The update found by the last check is kept here so the install uses
// exactly the release the banner announced (the renderer never sends a URL
// or a version: nothing to tamper with over IPC).
//
// Debug builds (`tauri dev`) skip the check unless
// HELMCODE_DESKTOP_UPDATER_IN_DEV=1: a dev build must not offer to replace
// itself with a release.

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

/// The user's click on "Update": download + verify + install the update the
/// last check found, then relaunch. Never called without that click.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let update = state.take()?;
    if let Err(err) = update.download_and_install(|_, _| {}, || {}).await {
        state.restore(update);
        return Err(err.to_string());
    }
    app.restart()
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
}
