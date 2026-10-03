// Preferences, stored as plain JSON in %APPDATA%\Coucou\settings.json.
// No secret ever lands here — API keys live in the Windows Credential Manager.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Preferences, stored as plain JSON in %APPDATA%\Coucou\settings.json.
/// No secret ever lands here — API keys live in the Windows Credential Manager.
///
/// `#[serde(default)]` on the struct is load-bearing, not decoration: without it
/// one missing or renamed field makes the whole file fail to deserialize, `load`
/// silently returns `Settings::default()`, and the next preference the user
/// touches writes those defaults over everything they had. It also means adding
/// a field in a later version cannot wipe anyone's settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    pub model: String,
    /// Clipboard history. Off unless the user turns it on: a clipboard history
    /// that starts recording before anyone asked for one is a surprise, not a
    /// feature, and it is the kind of thing people only find out about later.
    pub clipboard_enabled: bool,
    /// Minutes a clipboard entry is kept. 0 means "until the cap evicts it".
    pub clipboard_retention_minutes: u32,
    /// How many entries to keep at most.
    pub clipboard_max_entries: u32,
    /// Never record a string that looks like a credential. Best-effort: there is
    /// no way to ask Windows "was this copied by a password manager", so this
    /// matches on shape and can be wrong in both directions.
    pub clipboard_skip_secrets: bool,
    /// File shelf: keep dropped files in the shelf instead of the 7-day inbox.
    pub shelf_enabled: bool,
    /// Now-playing from the OS media session. Off until turned on: like the
    /// clipboard, watching what you play before anyone asked is a surprise.
    pub media_enabled: bool,
    /// Lyrics from lrclib.net. Separate toggle because it is the only part of
    /// the player that touches the network — and only when online (see media.rs).
    pub media_lyrics: bool,
    /// Spotify client ID for the optional link (mood + artwork). Public
    /// identifier, not a secret — tokens live in the Credential Manager.
    pub spotify_client_id: String,
    /// How the collapsed bar shows the album's colour: "corner", "wide",
    /// "pulse" or "off". A string rather than an enum because this file is
    /// hand-editable JSON, and an unknown value has to degrade to the default
    /// rather than refuse to load the whole file.
    pub media_glow: String,
    /// Stop the island waking when the pointer crosses the top of the screen.
    ///
    /// Off by default, because that hover is how the island is summoned at all.
    /// It is a preference rather than a session flag on purpose: somebody who
    /// turns it on has usually been irritated by it repeatedly, and a flag that
    /// silently reset on the next restart would just come back.
    pub quiet_hover: bool,
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            clipboard_enabled: false,
            clipboard_retention_minutes: 60,
            clipboard_max_entries: 100,
            clipboard_skip_secrets: true,
            shelf_enabled: false,
            media_enabled: false,
            media_lyrics: false,
            spotify_client_id: String::new(),
            media_glow: "corner".into(),
            quiet_hover: false,
        }
    }
}

/// %APPDATA%\Coucou
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Coucou")
}

/// %LOCALAPPDATA%\Coucou — where coucou-hook.exe and the log live.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Coucou")
}

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join("coucou-hook.exe")
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

/// Strips a UTF-8 BOM. `settings.json` is the one file here a user (or any
/// PowerShell 5.1 script — `Set-Content` included) is likely to edit by hand, and
/// a BOM makes `from_slice` fail, which silently fell back to the defaults: every
/// preference read as "off" while the file plainly said otherwise. Same guard the
/// agent config files already use.
fn strip_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        bytes
    }
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(strip_bom(&bytes)).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bom_in_the_settings_file_does_not_wipe_the_preferences() {
        // `settings.json` is the file a user is most likely to hand-edit, and
        // PowerShell 5.1's Set-Content writes a BOM. Reading it as UTF-8 without
        // stripping made every preference read as its default — silently, because
        // `load` falls back rather than reporting an error.
        let mut json = serde_json::to_vec(&Settings {
            clipboard_enabled: true,
            shelf_enabled: true,
            ..Settings::default()
        })
        .unwrap();
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.append(&mut json);

        let parsed: Settings = serde_json::from_slice(strip_bom(&with_bom)).unwrap_or_default();
        assert!(parsed.clipboard_enabled, "a BOM reset the stored preferences");
        assert!(parsed.shelf_enabled);
    }

    #[test]
    fn an_unknown_glow_style_falls_back_instead_of_wiping_the_file() {
        // `media_glow` is a string so this file stays hand-editable, which means a
        // typo is possible. `#[serde(default)]` has to absorb it the same way it
        // absorbs a missing key — one bad value must not cost the other
        // preferences, because `load` cannot report an error, it just defaults.
        let json = br#"{"mediaGlow":"sparkly","quietHover":true,"clipboardEnabled":true}"#;
        let parsed: Settings = serde_json::from_slice(json).unwrap_or_default();
        assert_eq!(parsed.media_glow, "sparkly", "the raw value is kept as-is");
        assert!(parsed.quiet_hover, "a bad sibling value reset a good one");
        assert!(parsed.clipboard_enabled);
    }

    #[test]
    fn quiet_hover_defaults_off_so_the_pointer_still_wakes_the_island() {
        // Off is the only safe default: with it on and nobody having asked, the
        // island would be unreachable except by hotkey.
        assert!(!Settings::default().quiet_hover);
        // And a file written before the preference existed must not gain it.
        let parsed: Settings = serde_json::from_slice(br#"{"soundEnabled":true}"#).unwrap();
        assert!(!parsed.quiet_hover);
    }
}
