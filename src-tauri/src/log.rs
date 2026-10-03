// Small append-only log at %LOCALAPPDATA%\Coucou\coucou.log — the Windows
// equivalent of nbLog() in HookServer.swift. Nothing leaves the machine.

use std::io::Write;
use std::sync::OnceLock;

use windows::Win32::System::SystemInformation::GetLocalTime;

use crate::settings;

/// The log file is opened per line (hook events, poll results) and re-checked
/// for size each time; `create_dir_all` and `metadata` on every call is pure
/// waste once the path is known and the file exists. The size guard stays on
/// every call — it is what keeps the file from growing forever.
fn path() -> &'static std::path::PathBuf {
    static PATH: OnceLock<std::path::PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let dir = settings::local_dir();
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir.join("coucou.log");
        }
        dir.join("coucou.log")
    })
}

pub fn line(message: impl AsRef<str>) {
    let t = unsafe { GetLocalTime() };
    let stamp = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    );
    let path = path();
    if path.parent().is_some_and(|d| !d.exists()) {
        let _ = std::fs::create_dir_all(path.parent().unwrap());
    }
    // Keep it from growing forever: start fresh past ~1 MB.
    if std::fs::metadata(path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::remove_file(path);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{stamp} {}", message.as_ref());
    }
}
