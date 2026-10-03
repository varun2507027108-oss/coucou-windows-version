// Window activation for agent sessions: Antigravity, VS Code, and Terminal/OpenCode.
// Enumerates top-level windows to find and bring the target application to the front.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow,
    ShowWindow, SW_RESTORE, SW_SHOW,
};

#[link(name = "user32")]
extern "system" {
    fn AttachThreadInput(idattach: u32, idattachto: u32, fattach: BOOL) -> BOOL;
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct WindowMatch {
    hwnd: HWND,
    score: u32,
    title: String,
    proc_name: String,
}

/// Folder basenames too generic to identify a project on their own. `C:\proj\src`
/// and `C:\other\src` both end in "src", so a window titled "src" proves nothing;
/// the parent name has to show up too before it counts fully.
fn is_generic_basename(name: &str) -> bool {
    matches!(
        name,
        "src" | "app" | "project" | "projects" | "test" | "tests" | "main" | "code" | "home"
            | "user" | "documents" | "desktop" | "downloads" | "new" | "tmp" | "temp"
            | "repo" | "repos" | "git" | "work" | "workspace" | "dir" | "folder"
    )
}

/// Splits a session folder into match tokens: the basename, plus the parent when
/// the basename is too generic to mean anything. Everything lowercased, because
/// window titles have their own ideas about capitalisation.
fn folder_parts(cwd: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(dir) = cwd else { return (None, None) };
    let path = Path::new(dir);
    let Some(base) = path.file_name().map(|s| s.to_string_lossy().to_lowercase()) else {
        return (None, None);
    };
    if base.is_empty() {
        return (None, None);
    }
    let parent = if is_generic_basename(&base) {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_lowercase())
            .filter(|s| !s.is_empty())
    } else {
        None
    };
    (Some(base), parent)
}

fn normalize_agent(raw_agent: &str) -> &'static str {
    let lower = raw_agent.to_lowercase();
    if lower.contains("antigravity") {
        "antigravity"
    } else if lower.contains("claude") || lower.contains("vscode") {
        "claude"
    } else if lower.contains("opencode") || lower.contains("terminal") {
        "opencode"
    } else {
        "unknown"
    }
}

struct Classified {
    is_term: bool,
    is_vscode: bool,
    is_antigravity: bool,
    is_opencode: bool,
}

/// What kind of window this is, from its process and title (both lowercased).
/// Non-exclusive on purpose: a VS Code window titled "opencode" is both a
/// `is_vscode` host and an `is_opencode` signal, and the scorer decides.
fn classify(proc_name: &str, title: &str) -> Classified {
    // `opencode.exe` contains "code", so the vscode test must exclude it —
    // otherwise every OpenCode process also counts as an editor.
    let proc_is_opencode = proc_name.contains("opencode");
    let is_vscode = !proc_is_opencode
        && (proc_name == "code.exe"
            || proc_name.contains("code")
            || proc_name.contains("cursor")
            || title.contains("visual studio code")
            || title.contains("vscode"));
    Classified {
        is_term: proc_name == "windowsterminal.exe"
            || proc_name == "wt.exe"
            || proc_name == "powershell.exe"
            || proc_name == "pwsh.exe"
            || proc_name == "cmd.exe"
            || proc_name.contains("alacritty")
            || proc_name.contains("wezterm")
            || title.contains("terminal")
            || title.contains("powershell"),
        is_vscode,
        is_antigravity: proc_name.contains("antigravity") || title.contains("antigravity"),
        is_opencode: proc_is_opencode || title.contains("opencode"),
    }
}

/// Only activate on a real signal. The bar is strict (`>`): a score sitting
/// exactly on it is a coincidence, not a match. Below it we fall back to
/// launching, because focusing somebody's unrelated `cmd.exe` is worse than
/// opening the right app.
const MIN_ACTIVATE_SCORE: u32 = 15;

/// Scores one window for an agent. Pure: no Win32, so it is unit-testable.
/// `agent` is normalized, `folder`/`parent`/`file`/`title`/`proc` lowercased.
pub fn score_window(
    agent: &str,
    folder: Option<&str>,
    parent: Option<&str>,
    file: Option<&str>,
    title: &str,
    proc: &str,
) -> u32 {
    let c = classify(proc, title);

    let folder_hit = folder.is_some_and(|f| !f.is_empty() && title.contains(f));
    // A generic basename only counts at all, and only with its parent beside it.
    let generic_hit = folder.is_some_and(|f| {
        is_generic_basename(f) && title.contains(f) && parent.is_some_and(|p| title.contains(p))
    });
    let strong_folder = folder_hit
        && (generic_hit || !folder.is_some_and(is_generic_basename));
    let folder_score = if strong_folder {
        25
    } else if folder_hit {
        10
    } else {
        0
    };
    let file_hit = file.is_some_and(|f| !f.is_empty() && title.contains(f));

    let mut score = 0u32;
    match agent {
        "antigravity" => {
            if c.is_antigravity {
                score += 45;
            }
            score += folder_score;
            if file_hit {
                score += 8;
            }
            if (c.is_term || c.is_vscode) && folder_score >= 25 {
                score += 10;
            }
            if (c.is_term || c.is_vscode) && folder_score == 0 {
                score += 3;
            }
        }
        "claude" => {
            if c.is_vscode && folder_score >= 25 {
                score += 35;
            } else if c.is_vscode {
                score += 8;
            }
            if c.is_term && folder_score >= 25 {
                score += 25;
            } else if c.is_term {
                score += 3;
            }
            score += folder_score.min(12);
            if file_hit {
                score += if c.is_vscode { 14 } else { 8 };
            }
        }
        "opencode" => {
            if c.is_opencode {
                score += 40;
            }
            // A terminal or editor showing the project folder is where a TUI
            // session lives. A bare terminal with no folder signal is +5: never
            // enough on its own, so an unrelated cmd.exe can no longer win.
            if (c.is_term || c.is_vscode) && folder_score >= 25 {
                score += 30;
            } else if c.is_term || c.is_vscode {
                score += 5;
            }
            score += folder_score.min(12);
            if file_hit {
                score += 8;
            }
        }
        _ => {
            // Third-party agents: the folder (and file) is all we know.
            score += folder_score.min(20);
            if file_hit {
                score += 15;
            }
        }
    }
    score
}

struct SearchContext<'a> {
    agent: &'a str,
    folder: Option<String>,
    parent: Option<String>,
    file: Option<String>,
    self_pid: u32,
    best: Option<WindowMatch>,
}

unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }

    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return true.into();
    }

    let mut title_buf = vec![0u16; (len + 1) as usize];
    let read_len = GetWindowTextW(hwnd, &mut title_buf);
    if read_len <= 0 {
        return true.into();
    }
    let title = String::from_utf16_lossy(&title_buf[..read_len as usize]);
    let title_lower = title.to_lowercase();

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let ctx = &mut *(lparam.0 as *mut SearchContext);
    // Never target our own island, settings window, or anything else we own.
    if pid == 0 || pid == ctx.self_pid {
        return true.into();
    }
    let proc_name = get_process_name(pid).unwrap_or_default().to_lowercase();

    let score = score_window(
        ctx.agent,
        ctx.folder.as_deref(),
        ctx.parent.as_deref(),
        ctx.file.as_deref(),
        &title_lower,
        &proc_name,
    );
    // Strictly greater, so the first (topmost — EnumWindows walks z-order) of
    // equally good windows wins instead of the last.
    if score > 0 && ctx.best.as_ref().is_none_or(|b| score > b.score) {
        ctx.best = Some(WindowMatch {
            hwnd,
            score,
            title,
            proc_name,
        });
    }

    true.into()
}

unsafe fn get_process_name(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = vec![0u16; 1024];
    let mut size = buf.len() as u32;
    let success = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_FORMAT(0),
        PWSTR(buf.as_mut_ptr()),
        &mut size,
    )
    .is_ok();
    let _ = windows::Win32::Foundation::CloseHandle(handle);

    if !success || size == 0 {
        return None;
    }

    let full_path = String::from_utf16_lossy(&buf[..size as usize]);
    let file_name = Path::new(&full_path)
        .file_name()?
        .to_string_lossy()
        .to_string();
    Some(file_name)
}

/// Brings the specified window to the foreground, bypassing Windows focus-stealing prevention.
unsafe fn activate_hwnd(hwnd: HWND) {
    if IsIconic(hwnd).as_bool() {
        let _ = ShowWindow(hwnd, SW_RESTORE);
    } else {
        let _ = ShowWindow(hwnd, SW_SHOW);
    }

    let fore_hwnd = GetForegroundWindow();
    let mut fore_pid = 0u32;
    let fore_thread = if fore_hwnd.0 as usize != 0 {
        GetWindowThreadProcessId(fore_hwnd, Some(&mut fore_pid))
    } else {
        0
    };

    let mut target_pid = 0u32;
    let target_thread = GetWindowThreadProcessId(hwnd, Some(&mut target_pid));
    let cur_thread = GetCurrentThreadId();

    if cur_thread != target_thread {
        let _ = AttachThreadInput(cur_thread, target_thread, true.into());
    }
    if fore_thread != 0 && fore_thread != cur_thread {
        let _ = AttachThreadInput(fore_thread, cur_thread, true.into());
    }

    let _ = BringWindowToTop(hwnd);
    let _ = SetForegroundWindow(hwnd);

    if cur_thread != target_thread {
        let _ = AttachThreadInput(cur_thread, target_thread, false.into());
    }
    if fore_thread != 0 && fore_thread != cur_thread {
        let _ = AttachThreadInput(fore_thread, cur_thread, false.into());
    }
}

/// Attempts to find and activate the window corresponding to the running session.
/// `file` is the session's active file name when the island knows one ("activate.rs");
/// VS Code titles usually read "<file> — <folder> — Visual Studio Code", so it is
/// a second, independent signal alongside the folder.
///
/// Only a confident match is activated (see MIN_ACTIVATE_SCORE). Anything weaker
/// falls through to launching, because focusing an unrelated window is worse
/// than opening the right app.
pub fn activate_target_app(raw_agent: &str, cwd: Option<&str>, file: Option<&str>) -> bool {
    let agent = normalize_agent(raw_agent);
    let (folder, parent) = folder_parts(cwd);
    let file_name = file
        .map(Path::new)
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().to_lowercase())
        .filter(|s| !s.is_empty());

    // Our own PID, so the island and the settings window can never be "found".
    let self_pid = unsafe { GetCurrentProcessId() };

    let mut ctx = SearchContext {
        agent,
        folder: folder.clone(),
        parent,
        file: file_name,
        self_pid,
        best: None,
    };

    unsafe {
        let _ = EnumWindows(Some(enum_window_proc), LPARAM(&mut ctx as *mut _ as isize));
    }

    if let Some(best) = ctx.best.filter(|m| m.score > MIN_ACTIVATE_SCORE) {
        crate::log::line(format!(
            "open {}: activating '{}' ({}, score {})",
            agent, best.title, best.proc_name, best.score
        ));
        unsafe {
            activate_hwnd(best.hwnd);
        }
        return true;
    }

    crate::log::line(format!(
        "open {}: no confident window (folder {:?}), falling back to launch",
        agent, folder
    ));
    // Fallback launches if window was not found
    launch_target_fallback(agent, cwd)
}

fn launch_target_fallback(agent: &str, cwd: Option<&str>) -> bool {
    let native_dir = cwd.map(|p| p.replace('/', "\\"));

    match agent {
        "antigravity" => {
            // Check for Antigravity executable on PATH or local program files
            if let Some(exe) = find_antigravity_exe() {
                let mut cmd = Command::new(exe);
                if let Some(ref d) = native_dir {
                    cmd.arg(d);
                }
                if cmd.creation_flags(CREATE_NO_WINDOW).spawn().is_ok() {
                    return true;
                }
            }
            // Fall back to the editor, then the folder: an Antigravity session's
            // project usually has a VS Code window nearby, which beats a bare
            // Explorer view of the folder.
            if let Some(code) = crate::find_on_path("code") {
                let mut cmd = Command::new(code);
                if let Some(ref d) = native_dir {
                    cmd.arg(d);
                }
                if cmd.creation_flags(CREATE_NO_WINDOW).spawn().is_ok() {
                    return true;
                }
            }
            if let Some(ref d) = native_dir {
                let _ = Command::new("explorer").arg(d).spawn();
                return true;
            }
            false
        }
        "claude" | "claudeCode" | "vscode" => {
            if let Some(code) = crate::find_on_path("code") {
                let mut cmd = Command::new(code);
                if let Some(ref d) = native_dir {
                    cmd.arg(d);
                }
                if cmd.creation_flags(CREATE_NO_WINDOW).spawn().is_ok() {
                    return true;
                }
            }
            if let Some(ref d) = native_dir {
                let _ = Command::new("explorer").arg(d).spawn();
                return true;
            }
            false
        }
        "opencode" | "terminal" => {
            // An OpenCode session is a TUI inside a terminal or an editor, so a
            // fresh terminal is only the last resort. VS Code first: it is the
            // likeliest host, and `code <folder>` focuses the project window.
            if let Some(code) = crate::find_on_path("code") {
                let mut cmd = Command::new(code);
                if let Some(ref d) = native_dir {
                    cmd.arg(d);
                }
                if cmd.creation_flags(CREATE_NO_WINDOW).spawn().is_ok() {
                    return true;
                }
            }
            if let Some(wt) = crate::find_on_path("wt") {
                let mut cmd = Command::new(wt);
                if let Some(ref d) = native_dir {
                    cmd.args(["-d", d]);
                }
                if cmd.spawn().is_ok() {
                    return true;
                }
            }
            if let Some(ref d) = native_dir {
                // Passed as its own argv element, so it stays a path — but
                // `-Command` still parses it as code, and a `'` in a folder name
                // would break out of the quoting. Doubling quotes is PowerShell's
                // escape, and keeps `C:\o'brien\proj` a single literal.
                let mut cmd = Command::new("powershell.exe");
                cmd.args(["-NoExit", "-Command", &format!("Set-Location -LiteralPath '{}'", d.replace('\'', "''"))]);
                if cmd.spawn().is_ok() {
                    return true;
                }
            }
            false
        }
        _ => {
            if let Some(ref d) = native_dir {
                let _ = Command::new("explorer").arg(d).spawn();
                return true;
            }
            false
        }
    }
}

fn find_antigravity_exe() -> Option<PathBuf> {
    if let Some(p) = crate::find_on_path("antigravity") {
        return Some(p);
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let p = Path::new(&local_app_data)
            .join("Programs")
            .join("Antigravity")
            .join("Antigravity.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score(
        agent: &str,
        folder: Option<&str>,
        parent: Option<&str>,
        file: Option<&str>,
        title: &str,
        proc: &str,
    ) -> u32 {
        score_window(agent, folder, parent, file, &title.to_lowercase(), &proc.to_lowercase())
    }

    #[test]
    fn opencode_tui_process_wins_outright() {
        let s = score("opencode", Some("coucou"), None, None, "opencode", "opencode.exe");
        assert!(s >= MIN_ACTIVATE_SCORE, "opencode TUI must activate (got {s})");
    }

    #[test]
    fn an_unrelated_cmd_window_never_wins_for_opencode() {
        // The reported bug: clicking "Open OpenCode" focused a random cmd.exe.
        // A bare terminal with no folder or file signal must stay under the bar.
        assert!(score("opencode", Some("coucou"), None, None, "C:\\Windows\\System32\\cmd.exe", "cmd.exe") < MIN_ACTIVATE_SCORE);
        assert!(score("opencode", None, None, None, "Windows PowerShell", "powershell.exe") < MIN_ACTIVATE_SCORE);
    }

    #[test]
    fn opencode_in_vscode_beats_an_unrelated_terminal() {
        let vscode = score(
            "opencode",
            Some("coucou"),
            None,
            Some("activate.rs"),
            "activate.rs — coucou — Visual Studio Code",
            "code.exe",
        );
        let stray = score("opencode", Some("coucou"), None, None, "cmd", "cmd.exe");
        assert!(vscode >= MIN_ACTIVATE_SCORE);
        assert!(vscode > stray);
    }

    #[test]
    fn opencode_exe_is_not_mistaken_for_an_editor() {
        // "opencode.exe" contains "code": the old classifier counted it as VS Code.
        let c = classify("opencode.exe", "opencode");
        assert!(c.is_opencode);
        assert!(!c.is_vscode);
    }

    #[test]
    fn claude_prefers_vscode_with_the_folder() {
        let s = score(
            "claude",
            Some("coucou"),
            None,
            None,
            "coucou — Visual Studio Code",
            "code.exe",
        );
        assert!(s >= MIN_ACTIVATE_SCORE, "VS Code with the folder must win (got {s})");
    }

    #[test]
    fn claude_ignores_a_random_terminal() {
        assert!(score("claude", Some("coucou"), None, None, "cmd", "cmd.exe") < MIN_ACTIVATE_SCORE);
    }

    #[test]
    fn antigravity_app_window_wins() {
        let s = score("antigravity", Some("coucou"), None, None, "coucou — Antigravity", "antigravity.exe");
        assert!(s >= MIN_ACTIVATE_SCORE, "Antigravity app must win (got {s})");
        assert!(s > score("antigravity", Some("coucou"), None, None, "coucou — Visual Studio Code", "code.exe"));
    }

    #[test]
    fn a_generic_basename_needs_its_parent() {
        // "src" alone proves nothing: C:\a\src and C:\b\src are different projects.
        // A lone generic hit lands exactly on the bar, which is strict — it must
        // stay below to avoid focusing an unrelated window.
        assert!(score("opencode", Some("src"), Some("coucou"), None, "src", "cmd.exe") <= MIN_ACTIVATE_SCORE);
        assert!(
            score("opencode", Some("src"), Some("coucou"), None, "coucou\\src — opencode", "windowsterminal.exe")
                >= MIN_ACTIVATE_SCORE
        );
    }

    #[test]
    fn unknown_agents_match_on_folder_and_file_only() {
        assert!(score("unknown", Some("coucou"), None, None, "coucou", "explorer.exe") >= MIN_ACTIVATE_SCORE);
        assert!(score("unknown", None, None, None, "cmd", "cmd.exe") < MIN_ACTIVATE_SCORE);
    }

    #[test]
    fn folder_parts_splits_basename_and_generic_parent() {
        assert_eq!(
            folder_parts(Some("C:/Users/varun/coucou")),
            (Some("coucou".into()), None)
        );
        assert_eq!(
            folder_parts(Some("C:/proj/src")),
            (Some("src".into()), Some("proj".into()))
        );
        assert_eq!(folder_parts(None), (None, None));
        assert_eq!(folder_parts(Some("")), (None, None));
    }

    #[test]
    fn normalize_agent_handles_aliases() {
        assert_eq!(normalize_agent("opencode"), "opencode");
        assert_eq!(normalize_agent("terminal"), "opencode");
        assert_eq!(normalize_agent("claude"), "claude");
        assert_eq!(normalize_agent("vscode"), "claude");
        assert_eq!(normalize_agent("Antigravity IDE"), "antigravity");
        assert_eq!(normalize_agent("cursor"), "unknown");
    }
}
