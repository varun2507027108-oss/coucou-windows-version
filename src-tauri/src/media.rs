// Now-playing from the OS media session (SystemMediaTransportControls).
//
// Brave — like every Chromium — publishes the playing tab to Windows, so this
// needs no Spotify account, no keys and no network: title, artist, album,
// play/pause state, timeline position and the transport buttons all come from
// the OS. Anything the browser plays shows up, which is exactly right for a
// mini player: it controls what you hear, not one particular app.
//
// One dedicated thread pumps a 2 s poll loop. WinRT calls need a COM apartment
// the tokio pool cannot promise (its threads are borrowed, not owned), so the
// thread initializes MTA itself and blocks on each operation with `get()` — no
// async runtime involved at all.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use base64::Engine as _;

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Media::MediaPlaybackType;
use windows::Storage::Streams::{DataReader, IInputStream};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::core::{Interface as _, Result as WinResult};
use windows::Foundation::TimeSpan;

use crate::island::WINDOW_LABEL;

/// Thumbnails are small; anything bigger is a surprise, not art.
const MAX_ART_BYTES: u64 = 512 * 1024;
const POLL_EVERY: Duration = Duration::from_secs(2);

/// Song mood. "neutral" until the Spotify link enriches it with audio-features.
pub type Mood = &'static str;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaSnapshot {
    /// A session exists at all (even paused — a paused track still shows).
    pub active: bool,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub position_secs: f64,
    pub duration_secs: f64,
    /// data: URL (jpeg/png/bmp) or None. Never decoded — the webview renders it.
    pub art: Option<String>,
    pub can_play: bool,
    pub can_pause: bool,
    pub can_next: bool,
    pub can_prev: bool,
    pub mood: Mood,
}

/// Identity key for change detection. Position is deliberately excluded: it moves
/// every second, and emitting on it would wake the island 30× a minute for
/// nothing. The view advances its own progress bar between snapshots.
fn track_key(s: &MediaSnapshot) -> String {
    format!(
        "{}\x00{}\x00{}\x00{}",
        s.title, s.artist, s.album, s.playing
    )
}

/// True when the island needs a refresh: new track, play/pause flip, or a control
/// lighting up or going dark.
fn snapshot_changed(a: &MediaSnapshot, b: &MediaSnapshot) -> bool {
    track_key(a) != track_key(b)
        || a.can_play != b.can_play
        || a.can_pause != b.can_pause
        || a.can_next != b.can_next
        || a.can_prev != b.can_prev
}

/// MIME from magic bytes. The thumbnail stream gives raw bytes with no content
/// type, and guessing wrong renders nothing — so sniff, don't assume.
fn mime_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some("image/png")
    } else if bytes.starts_with(&[0x42, 0x4D]) {
        Some("image/bmp")
    } else {
        None
    }
}

fn secs(ts: WinResult<TimeSpan>) -> f64 {
    ts.map(|t| t.Duration as f64 / 10_000_000.0)
        .unwrap_or(0.0)
        .max(0.0)
}

fn read_snapshot() -> MediaSnapshot {
    let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .ok()
        .and_then(|op| op.get().ok())
    {
        Some(m) => m,
        None => return MediaSnapshot::default(),
    };
    let session: GlobalSystemMediaTransportControlsSession = match manager.GetCurrentSession() {
        Ok(s) => s,
        Err(_) => return MediaSnapshot::default(),
    };

    let props = match session
        .TryGetMediaPropertiesAsync()
        .ok()
        .and_then(|op| op.get().ok())
    {
        Some(p) => p,
        None => return MediaSnapshot::default(),
    };

    // Video sessions (a YouTube tab) are not music: hide them rather than show a
    // video as the "song". Absent type info means accept — most audio apps never
    // set it, including, usually, the Spotify web player.
    if let Ok(t) = props.PlaybackType() {
        if let Ok(v) = t.Value() {
            if v == MediaPlaybackType::Video {
                return MediaSnapshot::default();
            }
        }
    }

    let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
    let album = props
        .AlbumTitle()
        .map(|s| s.to_string())
        .unwrap_or_default();
    if title.is_empty() && artist.is_empty() {
        return MediaSnapshot::default();
    }

    let (mut playing, mut can_play, mut can_pause, mut can_next, mut can_prev) =
        (false, true, true, true, true);
    if let Ok(info) = session.GetPlaybackInfo() {
        if let Ok(status) = info.PlaybackStatus() {
            playing = status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
        }
        if let Ok(controls) = info.Controls() {
            can_play = controls.IsPlayEnabled().unwrap_or(true);
            can_pause = controls.IsPauseEnabled().unwrap_or(true);
            can_next = controls.IsNextEnabled().unwrap_or(true);
            can_prev = controls.IsPreviousEnabled().unwrap_or(true);
        }
    }

    let (mut position_secs, mut duration_secs) = (0.0, 0.0);
    if let Ok(timeline) = session.GetTimelineProperties() {
        position_secs = secs(timeline.Position());
        duration_secs = secs(timeline.EndTime());
    }

    MediaSnapshot {
        active: true,
        playing,
        title,
        artist,
        album,
        position_secs,
        duration_secs,
        art: read_art(&props),
        can_play,
        can_pause,
        can_next,
        can_prev,
        mood: "neutral",
    }
}

/// Best-effort throughout: art is decoration, and a failed read must never
/// take the track info down with it.
fn read_art(
    props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Option<String> {
    let thumb = props.Thumbnail().ok()?;
    let stream = thumb.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > MAX_ART_BYTES {
        return None;
    }
    let input: IInputStream = stream.cast().ok()?;
    let reader = DataReader::CreateDataReader(&input).ok()?;
    reader.LoadAsync(size as u32).ok().and_then(|op| op.get().ok())?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;
    let mime = mime_of(&buf)?;
    Some(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(&buf)
    ))
}

/// Reads the session from the calling thread. The caller must own a COM
/// apartment (the poller initializes MTA once); WinRT activation from an
/// uninitialized tokio worker fails, and silently.
fn snapshot_on_com_thread() -> MediaSnapshot {
    read_snapshot()
}

/// Whether the player is allowed to do anything at all.
///
/// Every entry point — poller, snapshot read, transport, lyrics, Spotify
/// enrichment — goes through this one check. Gating only the poller left the
/// commands answering reads and acting on the session while the switch was off,
/// which is the opposite of what "off" says to someone who turned it off on
/// purpose.
fn media_on(app: &AppHandle) -> bool {
    let on = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().media_enabled)
        .unwrap_or(false);
    on && !crate::integrations::is_paused()
}

/// The poll loop. Emits only on change (see `snapshot_changed`); position ticks
/// are the view's own business between snapshots.
pub fn start(app: AppHandle, last: Arc<Mutex<MediaSnapshot>>) {
    std::thread::Builder::new()
        .name("coucou-media".into())
        .spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            std::thread::sleep(Duration::from_secs(3));
            loop {
                std::thread::sleep(POLL_EVERY);
                if !media_on(&app) {
                    continue;
                }
                let snap = snapshot_on_com_thread();
                let changed = {
                    let mut guard = last.lock().unwrap();
                    let changed = snapshot_changed(&guard, &snap);
                    *guard = snap.clone();
                    changed
                };
                if changed {
                    let _ = app.emit_to(WINDOW_LABEL, "media", snap);
                }
            }
        })
        .ok();
}

fn command_on_com_thread(op: &str) -> bool {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .ok()
        .and_then(|op| op.get().ok())
    {
        Some(m) => m,
        None => return false,
    };
    let session = match manager.GetCurrentSession() {
        Ok(s) => s,
        Err(_) => return false,
    };
    let run = |f: fn(&GlobalSystemMediaTransportControlsSession) -> bool| f(&session);
    match op {
        "play" => run(|s| {
            s.TryPlayAsync()
                .ok()
                .and_then(|o| o.get().ok())
                .unwrap_or(false)
        }),
        "pause" => run(|s| {
            s.TryPauseAsync()
                .ok()
                .and_then(|o| o.get().ok())
                .unwrap_or(false)
        }),
        "toggle" => {
            let playing = session
                .GetPlaybackInfo()
                .ok()
                .and_then(|i| i.PlaybackStatus().ok())
                .map(|s| s == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                .unwrap_or(false);
            run(if playing {
                |s| {
                    s.TryPauseAsync()
                        .ok()
                        .and_then(|o| o.get().ok())
                        .unwrap_or(false)
                }
            } else {
                |s| {
                    s.TryPlayAsync()
                        .ok()
                        .and_then(|o| o.get().ok())
                        .unwrap_or(false)
                }
            })
        }
        "next" => run(|s| {
            s.TrySkipNextAsync()
                .ok()
                .and_then(|o| o.get().ok())
                .unwrap_or(false)
        }),
        "prev" => run(|s| {
            s.TrySkipPreviousAsync()
                .ok()
                .and_then(|o| o.get().ok())
                .unwrap_or(false)
        }),
        _ => false,
    }
}

#[tauri::command]
pub fn media_snapshot(app: AppHandle) -> MediaSnapshot {
    if !media_on(&app) {
        return MediaSnapshot::default();
    }
    // COM initialized here too: commands run on borrowed tokio threads, and
    // WinRT activation from an uninitialized one fails silently.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    snapshot_on_com_thread()
}

#[tauri::command]
pub fn media_command(app: AppHandle, op: String) -> bool {
    if !media_on(&app) {
        return false;
    }
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    command_on_com_thread(&op)
}

/// Spotify enrichment for the current track: mood plus fallback art. Called by
/// the island on track change only — never polled — so an unlinked player costs
/// one cheap no-op per song and a linked one costs two API calls per song.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaEnrichment {
    pub mood: Mood,
    pub art: Option<String>,
}

impl Default for MediaEnrichment {
    // No information is "neutral", not empty: the TS type has no empty case.
    fn default() -> Self {
        Self { mood: "neutral", art: None }
    }
}

#[tauri::command]
pub async fn media_enrich(app: AppHandle, title: String, artist: String) -> MediaEnrichment {
    if !media_on(&app) {
        return MediaEnrichment::default();
    }
    let client_id = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().spotify_client_id.clone())
        .unwrap_or_default();
    match crate::spotify::enrich(client_id.trim(), &title, &artist).await {
        Some(e) => MediaEnrichment {
            mood: e.mood,
            art: e.art,
        },
        None => MediaEnrichment::default(),
    }
}

// ── Lyrics (lrclib.net, opt-in, online only) ────────────────────────────────

/// One cached lookup. Misses are never written: a track without lyrics today
/// might have them tomorrow, and a disk full of "not found" would hide that.
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct LyricCache {
    synced: Option<String>,
    plain: Option<String>,
}

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub synced: Option<String>,
    pub plain: Option<String>,
}

fn lyrics_dir() -> std::path::PathBuf {
    crate::settings::local_dir().join("lyrics")
}

/// Filename-safe key. Artist + title + rounded duration: lrclib matches duration
/// within ±2 s, so rounding to whole seconds is already finer than the match.
fn lyric_key(artist: &str, title: &str, duration_secs: f64) -> String {
    fn clean(s: &str) -> String {
        s.chars()
            .map(|c| {
                if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(60)
            .collect()
    }
    format!(
        "{}__{}__{}.json",
        clean(artist),
        clean(title),
        duration_secs.round() as u64
    )
}

/// True only with real internet access — not a captive portal, not a dead link.
/// The user asked for lyrics exclusively online; a profile merely existing is
/// not enough (hotel wifi has a profile and no internet).
fn online() -> bool {
    use windows::Networking::Connectivity::{
        NetworkConnectivityLevel, NetworkInformation,
    };
    NetworkInformation::GetInternetConnectionProfile()
        .and_then(|p| p.GetNetworkConnectivityLevel())
        .map(|level| level == NetworkConnectivityLevel::InternetAccess)
        .unwrap_or(false)
}

fn lyrics_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .user_agent(concat!("Coucou/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    });
    &CLIENT
}

/// Lyrics for a track. Never throws the network at a disabled toggle, an
/// offline machine, or a paused app — those all return "no lyrics" the same way
/// a 404 does, and the view cannot tell them apart (nor should it need to).
#[tauri::command]
pub async fn media_lyrics(
    app: AppHandle,
    artist: String,
    title: String,
    album: String,
    duration_secs: f64,
) -> Lyrics {
    let empty = Lyrics::default();
    let on = app
        .try_state::<crate::Shared>()
        .map(|s| {
            let settings = s.settings.lock().unwrap();
            settings.media_enabled && settings.media_lyrics
        })
        .unwrap_or(false);
    if !on || crate::integrations::is_paused() {
        return empty;
    }
    if artist.trim().is_empty() || title.trim().is_empty() {
        return empty;
    }

    let dir = lyrics_dir();
    let path = dir.join(lyric_key(&artist, &title, duration_secs));
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(cached) = serde_json::from_slice::<LyricCache>(&bytes) {
            return Lyrics {
                synced: cached.synced,
                plain: cached.plain,
            };
        }
    }
    if !online() {
        return empty;
    }

    // One request per track change, served from disk afterwards: sequential by
    // construction, which is what the rate limits ask for.
    #[derive(serde::Deserialize)]
    struct ApiLyrics {
        #[allow(dead_code)]
        id: Option<i64>,
        #[serde(rename = "syncedLyrics")]
        synced: Option<String>,
        #[serde(rename = "plainLyrics")]
        plain: Option<String>,
    }
    let mut api: Option<ApiLyrics> = None;
    if let Ok(resp) = lyrics_client()
        .get("https://lrclib.net/api/get")
        .query(&[
            ("track_name", title.trim()),
            ("artist_name", artist.trim()),
            ("album_name", album.trim()),
            ("duration", &duration_secs.round().to_string()),
        ])
        .send()
        .await
    {
        if resp.status().is_success() {
            api = resp.json::<ApiLyrics>().await.ok();
        }
    }
    let Some(api) = api else { return empty };
    if api.synced.is_none() && api.plain.is_none() {
        return empty;
    }
    let out = Lyrics {
        synced: api.synced,
        plain: api.plain,
    };
    if std::fs::create_dir_all(&dir).is_ok() {
        let cache = LyricCache {
            synced: out.synced.clone(),
            plain: out.plain.clone(),
        };
        if let Ok(json) = serde_json::to_vec(&cache) {
            let _ = std::fs::write(&path, json);
        }
    }
    out
}

#[cfg(test)]
mod tests {    use super::*;

    fn snap(title: &str, playing: bool) -> MediaSnapshot {
        // Controls default true, like read_snapshot produces: a bool left at
        // Default's false would make every "flip" test a no-op.
        MediaSnapshot {
            active: true,
            playing,
            title: title.into(),
            artist: "a".into(),
            album: "".into(),
            can_play: true,
            can_pause: true,
            can_next: true,
            can_prev: true,
            ..Default::default()
        }
    }

    #[test]
    fn identical_snapshots_do_not_emit() {
        assert!(!snapshot_changed(&snap("x", true), &snap("x", true)));
    }

    #[test]
    fn track_change_and_play_pause_emit() {
        assert!(snapshot_changed(&snap("x", true), &snap("y", true)));
        assert!(snapshot_changed(&snap("x", true), &snap("x", false)));
    }

    #[test]
    fn control_flips_emit() {
        let mut a = snap("x", true);
        let mut b = snap("x", true);
        b.can_next = false;
        assert!(snapshot_changed(&a, &b));
        // Same controls on both sides again: quiet.
        a.can_next = false;
        assert!(!snapshot_changed(&a, &b));
    }

    #[test]
    fn mime_sniffs_jpeg_png_bmp_and_rejects_junk() {
        assert_eq!(mime_of(&[0xFF, 0xD8, 0xFF, 0x00]), Some("image/jpeg"));
        assert_eq!(mime_of(&[0x89, 0x50, 0x4E, 0x47]), Some("image/png"));
        assert_eq!(mime_of(&[0x42, 0x4D, 0x00]), Some("image/bmp"));
        assert_eq!(mime_of(&[0x00, 0x01, 0x02]), None);
        assert_eq!(mime_of(&[]), None);
    }

    #[test]
    fn lyric_keys_are_stable_and_filename_safe() {
        let a = lyric_key("Fleetwood Mac", "The Chain", 271.4);
        let b = lyric_key("Fleetwood Mac", "The Chain", 271.0);
        assert_eq!(a, b, "sub-second durations must not split the cache");
        assert!(
            a.chars()
                .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.')),
            "unsafe filename: {a}"
        );
        // Junk in, junk contained: slashes and colons become underscores.
        let c = lyric_key("AC/DC", "Hells: Bells?", 300.0);
        assert!(!c.contains('/') && !c.contains(':') && !c.contains('?'));
    }
}
