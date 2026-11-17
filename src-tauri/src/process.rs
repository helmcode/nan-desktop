//! Child processes the app spawns (run_command, the Windows Recycle Bin,
//! the macOS signature read).
//!
//! Every spawn goes through [`hidden_command`]: on Windows a console child
//! (cmd, powershell) started from a GUI app opens its own console window,
//! which flashes on screen and steals focus for every command the
//! assistant runs. `CREATE_NO_WINDOW` keeps it invisible. Other platforms
//! never open a window for a child, so the helper is a plain
//! `Command::new` there.
//!
//! A source scan in the tests keeps `Command::new` out of every other
//! module, so a new spawn site cannot forget the flag.

use std::cell::Cell;
use std::ffi::OsStr;
use std::process::Command;
use std::sync::Mutex;

/// Win32 process creation flag: the child gets no console window.
/// <https://learn.microsoft.com/windows/win32/procthread/process-creation-flags>
#[cfg_attr(not(windows), allow(dead_code))]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `std::process::Command` that never opens a console window on Windows.
pub fn hidden_command<S: AsRef<OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Force-end a process and every process it started.
///
/// Unix: SIGKILL the process GROUP `pid` (run_command children lead their
/// own group, `process_group(0)`). Windows: `taskkill /T /F`, which walks
/// the tree from `pid` (it must still be alive to anchor the tree).
pub fn kill_tree(pid: u32) {
    #[cfg(unix)]
    {
        if let Ok(pgid) = i32::try_from(pid)
            && pgid > 0
        {
            // SAFETY: kill(2) with a negative pid signals a process group;
            // SIGKILL cannot be caught. pgid > 0, so never -0 / -1.
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = hidden_command("taskkill")
            .args(windows_tree_kill_args(pid))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// `taskkill` arguments that force-end a process and all its descendants.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_tree_kill_args(pid: u32) -> [String; 4] {
    ["/PID".into(), pid.to_string(), "/T".into(), "/F".into()]
}

// ---------------------------------------------------------------------------
// Commands running for a conversation (Stop ends them)
// ---------------------------------------------------------------------------

/// Commands running right now, by conversation: `(conversation_id, pid)`.
static RUNNING: Mutex<Vec<(i64, u32)>> = Mutex::new(Vec::new());

thread_local! {
    /// The conversation whose tool action this thread is executing.
    static SCOPE: Cell<Option<i64>> = const { Cell::new(None) };
}

/// While alive, commands spawned on this thread belong to
/// `conversation_id` (so Stop can end them). Restores the previous scope.
pub struct ConversationScope(Option<i64>);

impl ConversationScope {
    pub fn enter(conversation_id: Option<i64>) -> Self {
        Self(SCOPE.with(|scope| scope.replace(conversation_id)))
    }
}

impl Drop for ConversationScope {
    fn drop(&mut self) {
        SCOPE.with(|scope| scope.set(self.0));
    }
}

/// Registration of one running command; dropping it unregisters.
pub struct RunningCommand(Option<(i64, u32)>);

/// Register `pid` under this thread's conversation scope (no scope: not
/// registered, nothing can stop it but its timeout).
pub fn register_running(pid: u32) -> RunningCommand {
    let entry = SCOPE
        .with(Cell::get)
        .map(|conversation_id| (conversation_id, pid));
    if let Some(entry) = entry
        && let Ok(mut running) = RUNNING.lock()
    {
        running.push(entry);
    }
    RunningCommand(entry)
}

impl Drop for RunningCommand {
    fn drop(&mut self) {
        if let Some(entry) = self.0
            && let Ok(mut running) = RUNNING.lock()
            && let Some(index) = running.iter().position(|known| *known == entry)
        {
            running.swap_remove(index);
        }
    }
}

/// The pids of the commands running for a conversation.
pub fn running_for(conversation_id: i64) -> Vec<u32> {
    RUNNING
        .lock()
        .map(|running| {
            running
                .iter()
                .filter(|(conversation, _)| *conversation == conversation_id)
                .map(|(_, pid)| *pid)
                .collect()
        })
        .unwrap_or_default()
}

/// Stop: end the process tree of every command running for the
/// conversation (the waiting `run_command` then returns at once instead of
/// running on, invisibly, until its timeout). Returns how many were ended.
pub fn stop_conversation_commands(conversation_id: i64) -> usize {
    let pids = running_for(conversation_id);
    for pid in &pids {
        kill_tree(*pid);
    }
    pids.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_windows_tree_kill_covers_descendants_and_forces() {
        assert_eq!(
            windows_tree_kill_args(4242),
            ["/PID", "4242", "/T", "/F"].map(String::from)
        );
    }

    #[test]
    fn running_commands_are_tracked_per_conversation_scope() {
        let outside = register_running(1);
        assert!(running_for(901).is_empty(), "no scope: not tracked");
        {
            let _scope = ConversationScope::enter(Some(901));
            let first = register_running(11);
            let _second = register_running(12);
            assert_eq!(running_for(901), vec![11, 12]);
            assert!(running_for(902).is_empty());
            drop(first);
            assert_eq!(running_for(901), vec![12]);
        }
        assert!(running_for(901).is_empty(), "guards unregister on drop");
        drop(outside);
        let _scope = ConversationScope::enter(Some(903));
        drop(register_running(13));
        assert!(running_for(903).is_empty());
    }

    #[test]
    fn create_no_window_is_the_win32_value() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[cfg(unix)]
    #[test]
    fn hidden_command_runs_a_normal_child() {
        let output = hidden_command("sh")
            .args(["-c", "echo ok"])
            .output()
            .expect("spawn");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "ok\n");
    }

    /// Every other module must spawn through `hidden_command`: a bare
    /// `Command::new` would flash a console window on Windows.
    #[test]
    fn no_module_spawns_without_the_hidden_helper() {
        fn scan(dir: &std::path::Path, offenders: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).expect("read src") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    scan(&path, offenders);
                } else if path.extension().is_some_and(|ext| ext == "rs")
                    && path.file_name().is_some_and(|name| name != "process.rs")
                {
                    let text = std::fs::read_to_string(&path).expect("read file");
                    let needle = ["Command", "::new("].concat();
                    if text.contains(&needle) {
                        offenders.push(path.display().to_string());
                    }
                }
            }
        }
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        scan(&src, &mut offenders);
        assert!(
            offenders.is_empty(),
            "spawn through process::hidden_command: {offenders:?}"
        );
    }
}
