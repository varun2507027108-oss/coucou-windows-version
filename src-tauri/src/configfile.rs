// Shared file-config helpers for the agent hook installers.
//
// OpenCode (`opencode.rs`) and Antigravity (`antigravity.rs`) follow the same
// safety rules as the Claude Code installer: read the config, take a dated
// backup, merge without touching anything else, show the diff, and write only
// after an explicit click with a fingerprint check. The helpers below are the
// file-shaped half of that; each installer adds its own schema on top.
//
// (`hooks.rs` predates this module and keeps its own copies — working code
// stays untouched.)

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use windows::Win32::System::SystemInformation::GetLocalTime;

/// Status shape for the non-Claude installers. Same fields as the Claude
/// `HookStatus` plus the agent it belongs to, so the settings window can
/// render every harness with one section component.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookStatus {
    pub agent: String,
    pub installed: bool,
    pub settings_path: String,
    pub hook_path: String,
    pub hook_ready: bool,
}

/// The diff the user has to look at before anything is written.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookPreview {
    pub diff: String,
    pub backup: String,
    pub settings_path: String,
    /// Identifies the bytes this diff was computed from; handed back to
    /// `write` so we only ever apply what the user actually looked at.
    pub fingerprint: String,
}

pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Reads a JSON config file.
///
/// The only error that means "start from nothing" is the file not being
/// there. Everything else — a lock, bad permissions, unparseable content — is
/// reported, because treating an unreadable config as empty and writing that
/// back over it is how people lose their settings.
pub fn read_json(path: &Path) -> Result<Value, String> {
    match std::fs::read(path) {
        Ok(bytes) => parse_json(&bytes, &path.display().to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

pub fn parse_json(bytes: &[u8], display: &str) -> Result<Value, String> {
    // PowerShell 5's `Set-Content -Encoding utf8` writes a BOM; serde_json
    // refuses it. Stripping it is safe and well defined.
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{display} isn't a JSON object — Coucou won't touch it.")),
        Err(err) => Err(format!(
            "{display} isn't valid JSON ({err}). Fix or move it, then try again — Coucou won't overwrite it."
        )),
    }
}

pub fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// FNV-1a over the raw bytes: the only question is "is this still the file
/// the user previewed?".
pub fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

pub fn current_fingerprint(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => fingerprint(&bytes),
        Err(_) => fingerprint(b""),
    }
}

/// Down to the second: installing then uninstalling in the same minute must
/// not quietly overwrite the first backup.
fn stamp() -> String {
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

/// `<name>.bak-<stamp>` next to the config file. Shown in the diff preview and
/// used verbatim when the write happens.
pub fn backup_path_for(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".into());
    path.with_file_name(format!("{name}.bak-{}", stamp()))
}

/// Copies `path` to a dated sibling and returns it, or `None` when there was
/// nothing to copy. Returning a path for a backup that was never taken is how
/// the settings window ends up claiming it saved a file that does not exist.
pub fn take_backup(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let backup = backup_path_for(path);
    std::fs::copy(path, &backup).map_err(|e| format!("backup failed: {e}"))?;
    Ok(Some(backup))
}

/// Writes `text` beside the target and renames over it: a crash or a full disk
/// leaves the original file intact rather than half a file. The temp file is
/// removed on every failure path — a bare `map_err(…)?` on the write left
/// `<name>.coucou-<pid>` litter in the user's config folder.
pub fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("write failed: {e}"))?;
    }
    let temp = path.with_extension(format!("coucou-{}", std::process::id()));
    if let Err(e) = std::fs::write(&temp, text.as_bytes()) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {e}"));
    }
    if let Err(err) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    Ok(())
}

/// The LCS table is (n+1)×(m+1) `usize`. These files are meant to be small, and
/// the preview commands run inline on the event loop, so an unexpectedly huge
/// config gets an honest message instead of freezing the whole app. Past this
/// size the diff falls back to "everything replaced", which is still truthful.
const MAX_DIFF_LINES: usize = 2_000;

/// Minimal unified diff (LCS). Configs are short, so plain O(n·m) is the
/// simplest honest diff. Context: three lines around each change.
pub fn unified_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let (n, m) = (a.len(), b.len());

    if n.max(m) > MAX_DIFF_LINES {
        let mut out = String::new();
        for line in &a {
            out.push_str(&format!("- {line}\n"));
        }
        for line in &b {
            out.push_str(&format!("+ {line}\n"));
        }
        out.insert_str(
            0,
            &format!(
                "  … file is too large to diff line by line ({} before, {} after) …\n",
                a.len(),
                b.len()
            ),
        );
        return out;
    }

    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut out: Vec<String> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(format!("  {}", a[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            out.push(format!("- {}", a[i]));
            i += 1;
        } else {
            out.push(format!("+ {}", b[j]));
            j += 1;
        }
    }
    while i < n {
        out.push(format!("- {}", a[i]));
        i += 1;
    }
    while j < m {
        out.push(format!("+ {}", b[j]));
        j += 1;
    }

    let changed: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with('+') || l.starts_with('-'))
        .map(|(i, _)| i)
        .collect();
    if changed.is_empty() {
        return "No change.".into();
    }
    let mut keep = vec![false; out.len()];
    for idx in changed {
        let lo = idx.saturating_sub(3);
        let hi = (idx + 4).min(out.len());
        keep[lo..hi].fill(true);
    }
    let mut result = String::new();
    let mut gap = false;
    for (idx, line) in out.iter().enumerate() {
        if keep[idx] {
            result.push_str(line);
            result.push('\n');
            gap = false;
        } else if !gap {
            result.push_str("  …\n");
            gap = true;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bom_is_stripped_and_garbage_is_refused() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(br#"{"model":"opus"}"#);
        assert_eq!(parse_json(&bytes, "x.json").unwrap()["model"], "opus");
        assert_eq!(parse_json(b"", "x.json").unwrap(), json!({}));
        assert_eq!(parse_json(b"  \n ", "x.json").unwrap(), json!({}));
        // Never an empty object for content we cannot read: that is how a merge
        // ends up writing a file containing nothing but our own keys.
        assert!(parse_json(b"{ broken", "x.json").is_err());
        assert!(parse_json(b"[1,2,3]", "x.json").is_err());
    }

    #[test]
    fn take_backup_reports_nothing_when_there_was_no_file() {
        let dir = std::env::temp_dir().join(format!("coucou-bak-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("settings.json");

        // The settings window prints "Previous settings saved as …" from this.
        // Returning a path for a backup that was never taken is a lie.
        assert!(take_backup(&target).unwrap().is_none());

        std::fs::write(&target, b"{}").unwrap();
        let backup = take_backup(&target).unwrap().expect("a backup is taken");
        assert_eq!(std::fs::read(&backup).unwrap(), b"{}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_replaces_the_file_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("coucou-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let target = dir.join("hooks.json");
        atomic_write(&target, "{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"a\":1}");

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("coucou-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The O(n·m) table runs inline on the event loop, so this guard is the
    /// difference between a message and a frozen app.
    #[test]
    fn an_oversized_file_gets_a_full_replace_instead_of_a_huge_table() {
        let big = "line\n".repeat(5_000);
        let small = "other\n".repeat(3);
        let diff = unified_diff(&big, &small);
        assert!(diff.starts_with("  … file is too large to diff line by line"));
        assert!(diff.contains("- line\n"));
        assert!(diff.contains("+ other\n"));

        // A normal file still gets a real, minimal diff.
        let normal = unified_diff("a\nb\nc\n", "a\nB\nc\n");
        assert!(normal.contains("- b"));
        assert!(normal.contains("+ B"));
        assert!(!normal.contains("too large"));
    }
}
