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

use std::ffi::OsStr;
use std::process::Command;

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

#[cfg(test)]
mod tests {
    use super::*;

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
