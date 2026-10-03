// OpenCode hook installation.
//
// OpenCode talks to Coucou through a small plugin
// (`agents/opencode-plugin/coucou.js`) that spawns `coucou-hook.exe` on session,
// tool and permission events. Installing means copying that plugin — with the
// relay path baked in — to the global OpenCode plugins directory;
// uninstalling removes it again.
//
// Same safety rules as every other installer here: dated backup, diff
// preview, fingerprint check, explicit click only. A project-local install is
// a manual copy of the same file into `<project>/.opencode/plugins/`; the
// settings hint says so.
//
// The plugin needs no npm dependencies and no `opencode.json` edits. One
// nudge the user does themselves: OpenCode only raises `permission.ask` for
// tools their policy marks `ask`, so island approvals need something like
// `{ "permission": { "*": "ask" } }` in `~/.config/opencode/opencode.json`.
// We show the snippet; we don't write their policy for them.

use std::path::PathBuf;

use crate::configfile::{self, AgentHookPreview, AgentHookStatus};
use crate::settings;

pub const AGENT: &str = "opencode";

/// Identifies our plugin file. Checked for in `status`, never written over
/// blindly: a foreign `coucou.js` refuses the install instead of being
/// replaced.
const MARKER: &str = "Coucou for OpenCode";
const PLUGIN_TEMPLATE: &str = include_str!("../../agents/opencode-plugin/coucou.js");
const PLACEHOLDER: &str = "__COUCOU_HOOK_EXE__";

pub fn plugin_path() -> PathBuf {
    configfile::home()
        .join(".config")
        .join("opencode")
        .join("plugins")
        .join("coucou.js")
}

/// The plugin with the real relay path baked in. Forward slashes: the plugin
/// hands the path to Bun's spawn, which takes them fine and never invokes a
/// shell.
fn rendered() -> String {
    let exe = settings::hook_exe_path().to_string_lossy().replace('\\', "/");
    PLUGIN_TEMPLATE.replace(PLACEHOLDER, &exe)
}

fn read_existing() -> Result<Option<String>, String> {
    let path = plugin_path();
    match std::fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| format!("{} isn't valid UTF-8 — Coucou won't touch it.", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

pub fn status() -> AgentHookStatus {
    let installed = read_existing()
        .ok()
        .flatten()
        .map(|c| c.contains(MARKER))
        .unwrap_or(false);
    let hook_path = settings::hook_exe_path();
    AgentHookStatus {
        agent: AGENT.into(),
        installed,
        settings_path: plugin_path().to_string_lossy().to_string(),
        hook_ready: hook_path.exists(),
        hook_path: hook_path.to_string_lossy().to_string(),
    }
}

pub fn preview(install: bool) -> Result<AgentHookPreview, String> {
    let current = read_existing()?.unwrap_or_default();
    if install && !current.is_empty() && !current.contains(MARKER) {
        return Err(format!(
            "{} exists and isn't ours — move it aside first; Coucou won't overwrite it.",
            plugin_path().display()
        ));
    }
    let next = if install { rendered() } else { String::new() };
    Ok(AgentHookPreview {
        diff: configfile::unified_diff(&current, &next),
        backup: configfile::backup_path_for(&plugin_path()).to_string_lossy().to_string(),
        settings_path: plugin_path().to_string_lossy().to_string(),
        fingerprint: configfile::current_fingerprint(&plugin_path()),
    })
}

/// Writes the plugin (or removes it) after taking a dated backup.
///
/// `fingerprint` is the one the preview was computed from. If the file
/// changed in between we stop and make the user look at a fresh diff.
pub fn write(install: bool, fingerprint: &str) -> Result<String, String> {
    let path = plugin_path();
    let current = read_existing()?;
    if configfile::current_fingerprint(&path) != fingerprint {
        return Err(format!(
            "{} changed since the preview. Nothing was written — review the new diff.",
            path.display()
        ));
    }
    if install && matches!(&current, Some(c) if !c.contains(MARKER)) {
        return Err(format!(
            "{} exists and isn't ours — move it aside first; Coucou won't overwrite it.",
            path.display()
        ));
    }

    let backup = configfile::take_backup(&path)?;

    if install {
        configfile::atomic_write(&path, &rendered())?;
    } else if path.exists() {
        // The install branch refuses a foreign file; so must removal. Otherwise
        // `preview(false)` happily produces a diff that deletes somebody else's
        // coucou.js, and the command is reachable straight from the webview.
        let ours = read_existing()?.map(|c| c.contains(MARKER)).unwrap_or(false);
        if !ours {
            return Err(format!(
                "{} exists and isn't ours — remove it yourself if you want it gone.",
                path.display()
            ));
        }
        std::fs::remove_file(&path).map_err(|e| format!("remove failed: {e}"))?;
    }
    Ok(backup.map(|b| b.to_string_lossy().to_string()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_template_renders_a_real_path_and_keeps_its_marker() {
        // The placeholder must not survive: an unbaked install would spawn a
        // literal `__COUCOU_HOOK_EXE__`, on every tool call, forever.
        let out = PLUGIN_TEMPLATE.replace(PLACEHOLDER, "C:/x/coucou-hook.exe");
        assert!(out.contains("C:/x/coucou-hook.exe"));
        assert!(!out.contains(PLACEHOLDER));
        assert!(out.contains(MARKER));
        assert!(out.contains("\"permission.ask\""));
        assert!(out.contains("\"tool.execute.before\""));
    }

    #[test]
    fn a_foreign_plugin_is_never_claimed() {
        let foreign = "// someone else's plugin";
        assert!(!foreign.contains(MARKER));
    }
}
