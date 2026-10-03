// Optional Spotify link: mood + artwork enrichment for the Now-playing view.
//
// The OS session stays the transport truth (play/pause/skip on the Brave tab).
// This only *enriches*: when the linked account plays the same track, the
// snapshot gains a mood (from audio-features) and fallback art. Different track
// on a different device → ignored for that track, never fought over.
//
// Auth is PKCE Authorization Code flow against a loopback listener, so there is
// no client secret anywhere: the client ID is public configuration, the tokens
// live in the Credential Manager. Scopes stay read-only — controls go through
// the OS session, never the API.

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use base64::Engine as _;

use crate::island::WINDOW_LABEL;

const AUTH_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const SCOPE: &str = "user-read-playback-state";

const KEY_ACCESS: &str = "spotify-access-token";
const KEY_REFRESH: &str = "spotify-refresh-token";
const KEY_EXPIRES_AT: &str = "spotify-token-expires-at";

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .user_agent(concat!("Coucou/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    });
    &CLIENT
}

/// 32 random bytes via the OS CSPRNG. `rand` would be a new dependency for one
/// call; BCryptGenRandom is the same `windows` crate we already depend on.
fn random_hex(nbytes: usize) -> Option<String> {
    use windows::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };
    let mut buf = vec![0u8; nbytes];
    let ok = unsafe {
        BCryptGenRandom(None, &mut buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG).is_ok()
    };
    if !ok {
        return None;
    }
    Some(buf.iter().map(|b| format!("{:02x}", b)).collect())
}

fn pkce_verifier() -> Option<String> {
    // 48 bytes → 96 hex chars of [0-9a-f], all PKCE-legal, no padding issues.
    random_hex(48)
}

fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
}

#[derive(serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyStatus {
    pub linked: bool,
    pub has_client_id: bool,
}

fn client_id(app: &AppHandle) -> String {
    app.try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().spotify_client_id.clone())
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[tauri::command]
pub fn spotify_status(app: AppHandle) -> SpotifyStatus {
    SpotifyStatus {
        linked: crate::secrets::present(KEY_REFRESH),
        has_client_id: !client_id(&app).is_empty(),
    }
}

/// Fixed loopback port. Spotify matches redirect URIs exactly, so a random port
/// would force the user to register a new URI on every link — one stable port,
/// registered once in the Spotify dashboard as
/// `http://127.0.0.1:17863/callback`, instead.
const LOOPBACK_PORT: u16 = 17863;

/// Starts the link flow. Returns the URL to open; the loopback listener runs in
/// the background and the island learns the result through the `spotify` event.
#[tauri::command]
pub async fn spotify_begin(app: AppHandle) -> Result<String, String> {
    let id = client_id(&app);
    if id.is_empty() {
        return Err("paste a Spotify client ID first (Spotify Dashboard → your app)".into());
    }
    let verifier = pkce_verifier().ok_or("could not read randomness")?;
    let state = random_hex(16).ok_or("could not read randomness")?;

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{LOOPBACK_PORT}"))
        .await
        .map_err(|_| {
            format!("port {LOOPBACK_PORT} is busy — close whatever holds it and try again")
        })?;
    let redirect = format!("http://127.0.0.1:{LOOPBACK_PORT}/callback");

    let url = format!(
        "{AUTH_URL}?response_type=code&client_id={}&scope={}&redirect_uri={}&state={}&code_challenge_method=S256&code_challenge={}",
        urlencode(&id),
        urlencode(SCOPE),
        urlencode(&redirect),
        urlencode(&state),
        pkce_challenge(&verifier),
    );

    tauri::async_runtime::spawn(async move {
        if let Err(e) = loopback_once(listener, id, redirect, verifier, state).await {
            crate::log::line(format!("spotify link failed: {e}"));
        }
    });
    Ok(url)
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Serves exactly one callback, then stops. Anything else (favicon, probes,
/// a second browser tab) gets a 400 and is ignored.
async fn loopback_once(
    listener: tokio::net::TcpListener,
    client_id: String,
    redirect: String,
    verifier: String,
    state: String,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (mut stream, _) = tokio::time::timeout(std::time::Duration::from_secs(180), listener.accept())
        .await
        .map_err(|_| "timed out waiting for Spotify — try linking again".to_string())
        .and_then(|r| r.map_err(|e| e.to_string()))?;
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    // Minimal query parse: `code` and `state` are the only parameters we send.
    let mut code: Option<String> = None;
    let mut got_state: Option<String> = None;
    if let Some(q) = path.split_once('?').map(|(_, q)| q) {
        for pair in q.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "code" {
                    code = Some(v.to_string());
                } else if k == "state" {
                    got_state = Some(v.to_string());
                }
            }
        }
    }
    let ok_body = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<h1>Spotify linked — you can close this tab.</h1>";
    let bad_body = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nNot a Spotify callback.";
    match (code, got_state) {
        (Some(code), Some(s)) if s == state => {
            exchange(&client_id, &redirect, &verifier, &code).await?;
            let _ = stream.write_all(ok_body.as_bytes()).await;
            Ok(())
        }
        _ => {
            let _ = stream.write_all(bad_body.as_bytes()).await;
            Err("that was not a Spotify callback (wrong tab?)".into())
        }
    }
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

fn store_tokens(access: &str, refresh: Option<&str>, expires_in: u64) {
    let _ = crate::secrets::set(KEY_ACCESS, access);
    if let Some(r) = refresh {
        // A refresh without a new token keeps working: only overwrite when the
        // server actually rotates it.
        let _ = crate::secrets::set(KEY_REFRESH, r);
    }
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().saturating_add(expires_in))
        .unwrap_or(0);
    let _ = crate::secrets::set(KEY_EXPIRES_AT, &at.to_string());
}

async fn exchange(client_id: &str, redirect: &str, verifier: &str, code: &str) -> Result<(), String> {
    let reply: TokenReply = client()
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect),
            ("client_id", client_id),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let access = reply.access_token.ok_or("Spotify returned no access token")?;
    store_tokens(&access, reply.refresh_token.as_deref(), reply.expires_in.unwrap_or(3600));
    crate::log::line("spotify linked");
    Ok(())
}

/// A working access token, refreshing first when expired (60 s skew). `None`
/// means unlinked, revoked, or the network said no — all handled the same way.
async fn access_token(client_id: &str) -> Option<String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let exp: u64 = crate::secrets::get(KEY_EXPIRES_AT)?.parse().ok()?;
    if exp.saturating_sub(60) > now {
        return crate::secrets::get(KEY_ACCESS);
    }
    let refresh = crate::secrets::get(KEY_REFRESH)?;
    let reply: TokenReply = client()
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("client_id", client_id),
        ])
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    let access = reply.access_token?;
    store_tokens(&access, reply.refresh_token.as_deref(), reply.expires_in.unwrap_or(3600));
    Some(access)
}

#[derive(Deserialize)]
struct NowPlaying {
    item: Option<Track>,
}

#[derive(Deserialize)]
struct Track {
    id: Option<String>,
    name: Option<String>,
    artists: Option<Vec<Artist>>,
    album: Option<Album>,
}

#[derive(Deserialize)]
struct Artist {
    name: Option<String>,
}

#[derive(Deserialize)]
struct Album {
    images: Option<Vec<ArtImage>>,
}

#[derive(Deserialize)]
struct ArtImage {
    url: Option<String>,
    width: Option<u32>,
}

#[derive(Deserialize)]
struct AudioFeatures {
    energy: Option<f64>,
    valence: Option<f64>,
}

/// Spotify's enrichment for one OS snapshot: mood plus fallback art. `None`
/// when unlinked, on another device, or on any failure — the player degrades to
/// the OS data, which is always the truth about what you hear.
///
/// Takes the client ID explicitly so the sync poller thread never needs Tauri
/// state: the caller (a command, on tokio) reads settings and passes it in.
pub async fn enrich(client_id: &str, title: &str, artist: &str) -> Option<Enrichment> {
    if client_id.is_empty() {
        return None;
    }
    let token = access_token(client_id).await?;
    let np: NowPlaying = client()
        .get("https://api.spotify.com/v1/me/player/currently-playing")
        .bearer_auth(&token)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    let track = np.item?;
    let track_id = track.id.clone()?;
    let name = track.name.clone().unwrap_or_default();
    if !same_track(&name, &artists_of(&track), title, artist) {
        return None;
    }
    let id = track_id;
    let features: AudioFeatures = client()
        .get(format!("https://api.spotify.com/v1/audio-features/{id}"))
        .bearer_auth(&token)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    let art: Option<String> = match track
        .album
        .and_then(|a| a.images)
        .and_then(|imgs| {
            // Mid-size: the 640 px original is wasted on a 40 px thumb.
            imgs.into_iter()
                .filter_map(|i| Some((i.width.unwrap_or(640), i.url?)))
                .min_by_key(|(w, _)| (*w as i32 - 300).abs())
                .map(|(_, url)| url)
        }) {
        Some(url) => fetch_art(&url).await,
        None => None,
    };
    Some(Enrichment {
        mood: mood_for(features.energy.unwrap_or(0.5), features.valence.unwrap_or(0.5)),
        art,
    })
}

fn artists_of(track: &Track) -> String {
    track
        .artists
        .as_ref()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.name.clone())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

/// Same song on both sides? Compared loosely — "feat." credits and remaster tags
/// differ between the OS session and Spotify constantly — but both directions
/// must contain, so "Love" never matches "I Love You".
fn same_track(a_title: &str, a_artist: &str, b_title: &str, b_artist: &str) -> bool {
    fn norm(s: &str) -> String {
        s.to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == ' ')
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }
    let (at, aa, bt, ba) = (norm(a_title), norm(a_artist), norm(b_title), norm(b_artist));
    if at.is_empty() || bt.is_empty() {
        return false;
    }
    (at.contains(&bt) || bt.contains(&at))
        && (aa.is_empty() || ba.is_empty() || aa.contains(&ba) || ba.contains(&aa))
}

async fn fetch_art(url: &str) -> Option<String> {
    let bytes = client()
        .get(url)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .bytes()
        .await
        .ok()?;
    if bytes.len() > 512 * 1024 || bytes.is_empty() {
        return None;
    }
    let mime = if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else {
        return None;
    };
    Some(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

pub struct Enrichment {
    pub mood: crate::media::Mood,
    pub art: Option<String>,
}

/// Energy/valence → Mochi's face. Boundaries are inclusive on the high side so
/// exactly-0.75 energy reads fiery, not "just below fiery".
pub fn mood_for(energy: f64, valence: f64) -> crate::media::Mood {
    if energy >= 0.75 && valence >= 0.5 {
        "fiery"
    } else if valence >= 0.6 {
        "bright"
    } else if energy <= 0.35 && valence <= 0.45 {
        "blue"
    } else {
        "mellow"
    }
}

/// Drops every Spotify credential. The client ID in settings stays — it is not
/// a secret — but without tokens it does nothing.
#[tauri::command]
pub fn spotify_unlink(app: AppHandle) -> SpotifyStatus {
    let _ = crate::secrets::clear(KEY_ACCESS);
    let _ = crate::secrets::clear(KEY_REFRESH);
    let _ = crate::secrets::clear(KEY_EXPIRES_AT);
    let status = SpotifyStatus {
        linked: false,
        has_client_id: !client_id(&app).is_empty(),
    };
    let _ = app.emit_to(WINDOW_LABEL, "spotify", status.clone());
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mood_boundaries_read_high_side_inclusive() {
        assert_eq!(mood_for(0.75, 0.5), "fiery");
        assert_eq!(mood_for(0.9, 0.9), "fiery");
        assert_eq!(mood_for(0.5, 0.6), "bright");
        assert_eq!(mood_for(0.2, 0.2), "blue");
        assert_eq!(mood_for(0.5, 0.5), "mellow");
    }

    #[test]
    fn same_track_matches_loosely_but_not_casually() {
        assert!(same_track("Blinding Lights", "The Weeknd", "blinding lights", "the weeknd"));
        // Remaster tags and feat. credits differ across sources constantly.
        assert!(same_track(
            "Bohemian Rhapsody - 2011 Remaster",
            "Queen",
            "Bohemian Rhapsody",
            "Queen"
        ));
        assert!(!same_track("Love", "A", "I Love You", "B"));
        assert!(!same_track("", "Queen", "Bohemian Rhapsody", "Queen"));
        // Same title, different artist: not the same song.
        assert!(!same_track("Hurt", "Johnny Cash", "Hurt", "Nine Inch Nails"));
    }

    #[test]
    fn urlencode_leaves_unreserved_chars_alone() {
        assert_eq!(urlencode("abcXYZ019-_.~"), "abcXYZ019-_.~");
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
    }
}
