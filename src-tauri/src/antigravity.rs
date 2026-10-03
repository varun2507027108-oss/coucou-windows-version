// Antigravity hook installation (global `hooks.json`).
//
// Antigravity 2.0 / CLI / IDE discover command hooks in
// `%USERPROFILE%\.gemini\config\hooks.json` (global) and `.agents/hooks.json`
// (per workspace); see https://antigravity.google/docs/hooks. Coucou installs
// its entries globally under the `coucou` key — the workspace varies per
// project, so that half is a documented copy-paste and the settings hint
// shows the snippet.
//
// Entry shape per event:
// * `PreToolUse` / `PostToolUse` take the matcher form
//   `[{"matcher":"*","hooks":[{...}]}]`;
// * `PreInvocation` / `Stop` take the bare handler list `[{...}]`.
// `PreToolUse` gates on a human, so it gets the decision timeout + 10 s;
// everything else is fire-and-forget.
//
// Same safety rules as every other installer here: dated backup, merge
// without touching anyone else's hooks, diff preview, fingerprint check,
// explicit click only.

use std::path::PathBuf;

use serde_json::{json, Map, Value};

use crate::configfile::{self, AgentHookPreview, AgentHookStatus};
use crate::settings;

pub const AGENT: &str = "antigravity";

/// Our key inside hooks.json. Replaced wholesale on install — the diff preview
/// shows exactly that — but never removed unless it carries our marker.
const KEY: &str = "coucou";
/// Marker that identifies a Coucou entry. Matches the relay exe name, so any
/// hook command pointing at it counts as ours.
const MARKER: &str = "coucou-hook";

/// Every event the island reacts to, with the hook timeout written to
/// hooks.json. `PreToolUse` waits for a human, so it gets the decision
/// timeout + 10 s.
pub const HOOK_ENTRIES: &[(&str, u64)] = &[
    ("PreToolUse", 120),
    ("PostToolUse", 10),
    ("PreInvocation", 10),
    ("Stop", 10),
];

/// Tool-gating events take `{matcher, hooks}`; lifecycle events take the bare
/// handler list. Anything else would be rejected at load time with a clear
/// error instead of running — and a hook that never runs is worse than none.
fn uses_matcher(event: &str) -> bool {
    matches!(event, "PreToolUse" | "PostToolUse")
}

pub fn hooks_path() -> PathBuf {
    configfile::home()
        .join(".gemini")
        .join("config")
        .join("hooks.json")
}

fn hook_command(event: &str) -> String {
    // Quoted exe path in forward slashes plus the event name and our agent
    // tag — the same Git-Bash-safe form the Claude Code installer uses.
    let exe = settings::hook_exe_path().to_string_lossy().replace('\\', "/");
    format!("\"{exe}\" {event} antigravity")
}

fn handler(event: &str, timeout: u64) -> Value {
    json!({
        "type": "command",
        "command": hook_command(event),
        "timeout": timeout,
    })
}

fn entry_is_ours(entry: &Value) -> bool {
    let text = serde_json::to_string(entry).unwrap_or_default();
    text.contains(MARKER)
}

/// hooks.json with Coucou's entries added; everything else is left untouched.
fn merged(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();

    let mut ours = Map::new();
    for (event, timeout) in HOOK_ENTRIES {
        let value = if uses_matcher(event) {
            json!([{ "matcher": "*", "hooks": [handler(event, *timeout)] }])
        } else {
            json!([handler(event, *timeout)])
        };
        ours.insert((*event).to_string(), value);
    }
    root.insert(KEY.into(), Value::Object(ours));
    Value::Object(root)
}

/// hooks.json with Coucou's key removed — but only if it is actually ours. A
/// foreign `coucou` key is left alone; the preview says so.
fn without_ours(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let ours = root.get(KEY).map(entry_is_ours).unwrap_or(false);
    if ours {
        root.remove(KEY);
    }
    Value::Object(root)
}

fn is_installed(root: &Value) -> bool {
    root.get(KEY).map(entry_is_ours).unwrap_or(false)
}

pub fn status() -> AgentHookStatus {
    let current = configfile::read_json(&hooks_path()).unwrap_or_else(|_| json!({}));
    let hook_path = settings::hook_exe_path();
    AgentHookStatus {
        agent: AGENT.into(),
        installed: is_installed(&current),
        settings_path: hooks_path().to_string_lossy().to_string(),
        hook_ready: hook_path.exists(),
        hook_path: hook_path.to_string_lossy().to_string(),
    }
}

pub fn preview(install: bool) -> Result<AgentHookPreview, String> {
    let current = configfile::read_json(&hooks_path())?;
    if install {
        if let Some(existing) = current.get(KEY) {
            if !entry_is_ours(existing) {
                return Err("hooks.json already has a \"coucou\" key that isn't ours — rename it first; Coucou won't overwrite it.".into());
            }
        }
    }
    let next = if install { merged(&current) } else { without_ours(&current) };
    let mut before = configfile::pretty(&current);
    before.push('\n');
    let mut after = configfile::pretty(&next);
    after.push('\n');
    Ok(AgentHookPreview {
        diff: configfile::unified_diff(&before, &after),
        backup: configfile::backup_path_for(&hooks_path()).to_string_lossy().to_string(),
        settings_path: hooks_path().to_string_lossy().to_string(),
        fingerprint: configfile::current_fingerprint(&hooks_path()),
    })
}

/// Writes the merged (or cleaned) hooks.json after taking a dated backup.
///
/// `fingerprint` is the one the preview was computed from. If the file
/// changed in between we stop and make the user look at a fresh diff.
pub fn write(install: bool, fingerprint: &str) -> Result<String, String> {
    let path = hooks_path();
    let current = configfile::read_json(&path)?;
    if configfile::current_fingerprint(&path) != fingerprint {
        return Err(format!(
            "{} changed since the preview. Nothing was written — review the new diff.",
            path.display()
        ));
    }

    let backup = configfile::take_backup(&path)?;

    let next = if install { merged(&current) } else { without_ours(&current) };
    let mut text = configfile::pretty(&next);
    text.push('\n');
    configfile::atomic_write(&path, &text)?;
    Ok(backup.map(|b| b.to_string_lossy().to_string()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_events_use_matchers_lifecycle_events_do_not() {
        let after = merged(&json!({}));
        let ours = &after[KEY];
        assert!(ours["PreToolUse"][0].get("matcher").is_some());
        assert!(ours["PostToolUse"][0].get("matcher").is_some());
        assert!(ours["PreInvocation"][0].get("matcher").is_none());
        assert!(ours["Stop"][0].get("matcher").is_none());
        for (event, timeout) in HOOK_ENTRIES {
            let text = serde_json::to_string(&ours[*event]).unwrap();
            assert!(text.contains("coucou-hook"), "no relay in {event}");
            assert!(text.contains(&timeout.to_string()), "no timeout in {event}");
            assert!(text.contains("antigravity"), "no agent tag in {event}");
        }
    }

    #[test]
    fn merging_keeps_foreign_hooks_and_removal_restores_them() {
        let existing = json!({
            "my-linter-hook": {
                "PostToolUse": [{ "matcher": "run_command", "hooks": [{ "type": "command", "command": "./lint.sh" }] }]
            }
        });
        let after = merged(&existing);
        assert!(after.get("my-linter-hook").is_some(), "foreign hook dropped");
        assert!(is_installed(&after));

        let cleaned = without_ours(&after);
        assert_eq!(cleaned, existing);
    }

    #[test]
    fn a_foreign_coucou_key_is_never_removed() {
        let existing = json!({ "coucou": { "Stop": [{ "command": "./mine.sh" }] } });
        assert!(!is_installed(&existing));
        assert_eq!(without_ours(&existing), existing);
    }
}
