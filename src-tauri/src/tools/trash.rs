//! OS trash for `delete_path` (S15).
//!
//! Deletes go to the user's trash whenever one is reachable on the SAME
//! volume as the target (a rename, so nothing is copied and nothing is lost
//! on failure):
//! - macOS: `~/.Trash` (no Finder "Put Back" metadata, but the item is in
//!   the Trash and recoverable from Finder);
//! - other Unix: the freedesktop.org home trash (`$XDG_DATA_HOME/Trash`,
//!   default `~/.local/share/Trash`) with its `.trashinfo` record;
//! - Windows: the Recycle Bin through the .NET `Microsoft.VisualBasic`
//!   FileSystem API in a PowerShell child (the path travels in an
//!   environment variable, never in the script text).
//!
//! When no trash is reachable (another volume, no home folder) the caller
//! deletes PERMANENTLY and must say so in the proposal summary and approval
//! text. A delete that was approved as "to the trash" never falls back to a
//! permanent delete at execute time: it fails closed instead.
//!
//! Tests never touch the real trash: [`trash_home`] is `None` under
//! `cfg(test)` and the unit tests below inject a tempdir home.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::Rejection;

/// The home folder whose trash is used. `None` under `cfg(test)` so that
/// tool-level tests delete permanently inside their tempdirs and never move
/// anything into the developer's real trash.
pub fn trash_home() -> Option<PathBuf> {
    if cfg!(test) {
        None
    } else {
        std::env::home_dir()
    }
}

/// The trash folder for `home` on this platform (it may not exist yet on
/// freedesktop systems; it is created on first use).
pub fn trash_dir(home: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(home.join(".Trash"))
    } else if cfg!(unix) {
        // Tests pin the default layout under their tempdir home: a
        // developer's XDG_DATA_HOME must never be written by a test.
        let xdg = if cfg!(test) {
            None
        } else {
            std::env::var_os("XDG_DATA_HOME")
        };
        let data_home = xdg
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".local").join("share"));
        Some(data_home.join("Trash"))
    } else {
        None
    }
}

/// Whether `path` can be moved into the trash of `home` (same volume).
pub fn available_for(home: Option<&Path>, path: &Path) -> bool {
    let Some(home) = home else {
        return false;
    };
    if cfg!(windows) {
        return true;
    }
    let Some(trash) = trash_dir(home) else {
        return false;
    };
    if cfg!(target_os = "macos") && !trash.is_dir() {
        return false;
    }
    same_volume(&nearest_existing(&trash), path)
}

/// Deepest existing ancestor (or the path itself).
fn nearest_existing(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    while !current.exists() {
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => break,
        }
    }
    current
}

#[cfg(unix)]
fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::symlink_metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_volume(_a: &Path, _b: &Path) -> bool {
    false
}

/// `name`, then `name 2`, `name 3`… (before the extension for files), then
/// a random suffix: the first candidate that does not exist in `dir`.
/// A stat error other than NotFound (macOS restricts peeking into the
/// Trash) counts as taken.
pub fn free_name(dir: &Path, name: &std::ffi::OsStr) -> OsString {
    let taken = |candidate: &std::ffi::OsStr| {
        !matches!(
            std::fs::symlink_metadata(dir.join(candidate)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound
        )
    };
    if !taken(name) {
        return name.to_os_string();
    }
    let as_path = Path::new(name);
    let stem = as_path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string_lossy().into_owned());
    let extension = as_path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    for counter in 2..100 {
        let candidate = OsString::from(format!("{stem} {counter}{extension}"));
        if !taken(candidate.as_os_str()) {
            return candidate;
        }
    }
    OsString::from(format!(
        "{stem} {}{extension}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ))
}

/// Percent-encode an absolute path for a `.trashinfo` `Path=` line
/// (RFC 2396 escaping of everything but unreserved chars and `/`).
pub fn percent_encode_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn trash_io(what: &str, err: std::io::Error) -> Rejection {
    Rejection::new("io", format!("cannot move to the trash ({what}): {err}"))
}

/// Move `path` into the trash of `home`. Returns where it landed (Unix) or
/// the original path (Windows Recycle Bin). Never deletes permanently.
pub fn move_to_trash(home: Option<&Path>, path: &Path) -> Result<PathBuf, Rejection> {
    let Some(home) = home else {
        return Err(Rejection::new(
            "io",
            "no trash is available; nothing was deleted",
        ));
    };
    if cfg!(windows) {
        return recycle_windows(path).map(|_| path.to_path_buf());
    }
    let trash = trash_dir(home)
        .ok_or_else(|| Rejection::new("io", "no trash on this platform; nothing was deleted"))?;
    let name = path
        .file_name()
        .ok_or_else(|| Rejection::new("protocol", "cannot trash a path without a name"))?;
    if cfg!(target_os = "macos") {
        let target = trash.join(free_name(&trash, name));
        std::fs::rename(path, &target).map_err(|err| trash_io("rename", err))?;
        return Ok(target);
    }
    // freedesktop.org home trash: files/ + info/<name>.trashinfo.
    let files = trash.join("files");
    let info = trash.join("info");
    std::fs::create_dir_all(&files).map_err(|err| trash_io("create files", err))?;
    std::fs::create_dir_all(&info).map_err(|err| trash_io("create info", err))?;
    let chosen = free_name(&files, name);
    let info_path = info.join(format!("{}.trashinfo", chosen.to_string_lossy()));
    let deleted_at = super::audit::timestamp_now_rfc3339();
    let record = format!(
        "[Trash Info]\nPath={}\nDeletionDate={}\n",
        percent_encode_path(path),
        deleted_at.trim_end_matches('Z')
    );
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&info_path)
            .map_err(|err| trash_io("write trashinfo", err))?;
        file.write_all(record.as_bytes())
            .map_err(|err| trash_io("write trashinfo", err))?;
    }
    let target = files.join(&chosen);
    if let Err(err) = std::fs::rename(path, &target) {
        let _ = std::fs::remove_file(&info_path);
        return Err(trash_io("rename", err));
    }
    Ok(target)
}

#[cfg(windows)]
fn recycle_windows(path: &Path) -> Result<(), Rejection> {
    let raw = path.display().to_string();
    // The .NET API does not accept verbatim (\\?\) paths.
    let plain = raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string();
    let method = if path.is_dir() {
        "DeleteDirectory"
    } else {
        "DeleteFile"
    };
    let script = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; \
         [Microsoft.VisualBasic.FileIO.FileSystem]::{method}($env:HELMCODE_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')"
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .env("HELMCODE_TRASH_PATH", plain)
        .stdin(std::process::Stdio::null())
        .status()
        .map_err(|err| trash_io("start powershell", err))?;
    if status.success() && !path.exists() {
        Ok(())
    } else {
        Err(Rejection::new(
            "io",
            "the Recycle Bin refused the item; nothing was deleted",
        ))
    }
}

#[cfg(not(windows))]
fn recycle_windows(_path: &Path) -> Result<(), Rejection> {
    Err(Rejection::new("io", "the Recycle Bin is Windows-only"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // Unix-only tests below exercise the ~/.Trash move; on Windows the
    // Recycle-Bin path is untested this round, so the helper goes dead
    // there and clippy denies it.
    #[cfg(unix)]
    fn layout() -> (PathBuf, PathBuf, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let base = fs::canonicalize(tmp.path()).expect("canon");
        let home = base.join("home");
        let work = home.join("work");
        fs::create_dir_all(&work).expect("work");
        if cfg!(target_os = "macos") {
            fs::create_dir_all(home.join(".Trash")).expect("trash");
        }
        (home, work, tmp)
    }

    #[test]
    fn trash_home_is_disabled_in_tests() {
        assert_eq!(trash_home(), None, "tests must never use the real trash");
        assert!(!available_for(None, Path::new("/tmp/x")));
        assert_eq!(
            move_to_trash(None, Path::new("/tmp/x"))
                .expect_err("no home")
                .kind,
            "io"
        );
    }

    #[test]
    fn free_name_numbers_collisions_before_the_extension() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        assert_eq!(free_name(dir, "a.txt".as_ref()), OsString::from("a.txt"));
        fs::write(dir.join("a.txt"), "x").expect("a");
        assert_eq!(free_name(dir, "a.txt".as_ref()), OsString::from("a 2.txt"));
        fs::write(dir.join("a 2.txt"), "x").expect("a2");
        assert_eq!(free_name(dir, "a.txt".as_ref()), OsString::from("a 3.txt"));
        fs::create_dir(dir.join("folder")).expect("folder");
        assert_eq!(
            free_name(dir, "folder".as_ref()),
            OsString::from("folder 2")
        );
    }

    #[test]
    fn trashinfo_paths_are_percent_encoded() {
        assert_eq!(
            percent_encode_path(Path::new("/home/u/Mis informes/año 1.txt")),
            "/home/u/Mis%20informes/a%C3%B1o%201.txt"
        );
    }

    #[cfg(unix)]
    #[test]
    fn files_and_folders_land_in_the_trash_and_nothing_is_lost() {
        let (home, work, _guard) = layout();
        fs::write(work.join("informe.txt"), "datos").expect("file");
        fs::create_dir_all(work.join("carpeta/sub")).expect("dir");
        fs::write(work.join("carpeta/sub/x.md"), "x").expect("nested");
        assert!(available_for(Some(&home), &work.join("informe.txt")));

        let landed = move_to_trash(Some(&home), &work.join("informe.txt")).expect("trash file");
        assert!(!work.join("informe.txt").exists(), "gone from the folder");
        assert_eq!(fs::read_to_string(&landed).expect("in trash"), "datos");

        let landed_dir = move_to_trash(Some(&home), &work.join("carpeta")).expect("trash dir");
        assert!(!work.join("carpeta").exists());
        assert!(landed_dir.join("sub/x.md").exists(), "tree moved intact");

        // A second item with the same name never overwrites the first.
        fs::write(work.join("informe.txt"), "v2").expect("again");
        let second = move_to_trash(Some(&home), &work.join("informe.txt")).expect("again");
        assert_ne!(second, landed);
        assert_eq!(fs::read_to_string(&landed).expect("first kept"), "datos");

        if !cfg!(target_os = "macos") {
            let info = trash_dir(&home)
                .expect("dir")
                .join("info")
                .join("informe.txt.trashinfo");
            let record = fs::read_to_string(info).expect("trashinfo");
            assert!(record.starts_with("[Trash Info]\nPath=/"));
            assert!(record.contains("DeletionDate="));
        }
    }
}
