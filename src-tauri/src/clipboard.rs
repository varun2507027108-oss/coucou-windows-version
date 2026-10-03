// Clipboard history: a local ring of what you copied. Click a row to put it back
// on the clipboard; nothing is uploaded and nothing leaves the machine.
//
// A message-only window (HWND_MESSAGE, parent -3) owns the listener, so it never
// appears in the taskbar, Alt-Tab or the Win32 window list. It registers
// AddClipboardFormatListener rather than polling GetClipboardSequenceNumber — the
// signal arrives as a message anyway, and the app must sit at 0 % CPU when idle.
// That needs its own thread: the listener posts to the creating thread's queue,
// so the thread that registers has to be the one that pumps messages.
//
// The store is a JSON array in %LOCALAPPDATA%, newest first, capped and aged out
// on every insert. A database is the wrong shape for a few hundred short strings
// that are all rewritten on every copy.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData,
    IsClipboardFormatAvailable, OpenClipboard, RemoveClipboardFormatListener, SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, PostQuitMessage,
    RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, WM_CLIPBOARDUPDATE, WM_DESTROY,
    WINDOW_EX_STYLE, WINDOW_LONG_PTR_INDEX, WINDOW_STYLE, WNDCLASSW,
};
use windows::core::PCWSTR;

use crate::settings;
use crate::settings::Settings;

/// Longest single entry we keep. A multi-megabyte "copy" is almost always an
/// accident (a whole file, a base64 blob) and would make the history unusable and
/// the JSON rewrite slow.
const MAX_ENTRY_CHARS: usize = 4_000;

/// `CF_UNICODETEXT`. Spelled out once, next to the comment that says why.
const CF_UNICODETEXT: u32 = 13;
/// `CF_DIB` — a raw bitmap with no file header. This is what a screenshot lands
/// as, and it is why a screen capture never showed up in a text-only history.
const CF_DIB: u32 = 8;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipEntry {
    /// Stable key for the UI. Content hash plus a counter, so the same text copied
    /// twice never produces two rows claiming the same id.
    pub id: String,
    pub text: String,
    /// Unix seconds.
    pub at: u64,
    /// Kept regardless of the retention window or the cap. This is the escape
    /// hatch for something you will want back tomorrow and would otherwise lose.
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_image: Option<bool>,
}

pub fn image_dir() -> PathBuf {
    settings::local_dir().join("clipboard_images")
}

pub struct CapturedImage {
    pub dib: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub data_url: String,
}

fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 40 {
        return None;
    }
    let bi_size = u32::from_le_bytes(dib[0..4].try_into().ok()?) as usize;
    if bi_size < 40 || bi_size > dib.len() {
        return None;
    }
    let bi_bit_count = u16::from_le_bytes(dib[14..16].try_into().ok()?);
    let bi_compression = u32::from_le_bytes(dib[16..20].try_into().ok()?);
    let bi_clr_used = u32::from_le_bytes(dib[32..36].try_into().ok()?);

    let colors = if bi_clr_used > 0 {
        bi_clr_used as usize
    } else if bi_bit_count <= 8 {
        1usize << bi_bit_count
    } else {
        0
    };

    let mask_size = if (bi_compression == 3 || bi_compression == 6) && bi_size == 40 {
        12
    } else {
        0
    };

    let off_bits = 14 + bi_size + colors * 4 + mask_size;
    let file_size = 14 + dib.len();

    let mut bmp = Vec::with_capacity(file_size);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&(file_size as u32).to_le_bytes());
    bmp.extend_from_slice(&0u16.to_le_bytes());
    bmp.extend_from_slice(&0u16.to_le_bytes());
    bmp.extend_from_slice(&(off_bits as u32).to_le_bytes());
    bmp.extend_from_slice(dib);
    Some(bmp)
}

/// The history, and the file it lives in.
///
/// The path belongs to the store rather than being a global on purpose: a global
/// would make every test share one file, and they run in parallel.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    entries: Vec<ClipEntry>,
    /// Bumped per insert; feeds the id so repeats stay distinguishable.
    seq: u64,
    /// Never serialised: the on-disk location is a runtime fact, not history.
    #[serde(skip)]
    path: PathBuf,
}

pub type Shared = Arc<Mutex<Store>>;

// ── Persistence ───────────────────────────────────────────────────────────────

/// The real history location, in %LOCALAPPDATA%.
pub fn store_path() -> PathBuf {
    settings::local_dir().join("clipboard.json")
}

/// Reads the history at `path`, starting empty if it is missing or unreadable.
pub fn load(path: &Path) -> Store {
    let entries = match std::fs::read(path) {
        // A corrupt file must not stop the app from starting; worst case the
        // history starts empty rather than the app refusing to launch.
        Ok(bytes) => serde_json::from_slice::<Store>(&bytes).map(|s| s.entries).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    Store { entries, seq: 0, path: path.to_path_buf() }
}

fn write_out(store: &Store) {
    if store.path.as_os_str().is_empty() {
        return;
    }
    if let Some(dir) = store.path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Write-then-rename: a crash mid-write must not leave a half-written file
    // that fails to parse and silently empties the history on the next boot.
    let tmp = store.path.with_extension("json.tmp");
    let Ok(json) = serde_json::to_vec_pretty(store) else { return };
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &store.path);
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// FNV-1a. Not a security primitive — it only has to make equal text produce
/// equal ids cheaply.
fn content_id(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Drops anything past the cap and anything older than the retention window.
/// Newest first, so both cut points are at the end.
///
/// A pin is exempt from the sweep and from the cap — that is the whole point, and
/// a pin the sweep deletes on the next copy is not a pin. To stop the history
/// growing without limit when someone pins hundreds of rows, there is a second
/// ceiling well above the cap that even pins cannot pass.
fn prune(store: &mut Store, max_entries: u32, retention_minutes: u32) {
    if retention_minutes > 0 {
        let cutoff = now_secs().saturating_sub(retention_minutes as u64 * 60);
        store.entries.retain(|e| e.pinned || e.at >= cutoff);
    }
    if max_entries > 0 {
        let cap = max_entries as usize;
        let hard = cap * PIN_CEILING;
        let mut live = 0;
        store.entries.retain(|e| {
            if e.pinned && live < hard {
                live += 1;
                return true;
            }
            if live >= cap {
                return false;
            }
            live += 1;
            true
        });
    }
    clean_orphaned_images(&store.entries);
}

fn clean_orphaned_images(entries: &[ClipEntry]) {
    let dir = image_dir();
    let Ok(read_dir) = std::fs::read_dir(&dir) else { return };
    let live_ids: std::collections::HashSet<&str> = entries
        .iter()
        .filter(|e| e.is_image == Some(true))
        .map(|e| e.id.as_str())
        .collect();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("dib") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if !live_ids.contains(stem) {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

/// How far past the cap pinned rows may go before the oldest pin goes too.
const PIN_CEILING: usize = 4;

// ── Secret filtering ───────────────────────────────────────────────────────────

/// Best-effort "this is a credential" test.
///
/// Windows offers no way to ask who put something on the clipboard, so a password
/// manager's copy is indistinguishable from the user's own. What we can do is
/// refuse the shapes that are almost always secrets. This is a guard rail, not a
/// guarantee: it will let an unusual password through and it will skip a harmless
/// string that happens to look like one. Both failure modes beat silently
/// recording a pasted API key, which is the case that actually bites.
pub fn looks_like_secret(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    // One very long unbroken token: a key with no spaces, no newlines, no dots.
    if t.len() >= 32 && !t.contains(char::is_whitespace) && !t.contains('.') && !t.contains('/') {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    if let Some(head) = lower.lines().next() {
        for marker in [
            "password", "passwd", "secret", "api key", "api_key", "apikey", "token", "bearer ",
            "authorization", "private key", "access key", "client_secret",
        ] {
            if head.contains(marker) {
                return true;
            }
        }
    }
    if lower.starts_with("-----begin") {
        return true;
    }
    false
}

// ── Reading and writing the clipboard ──────────────────────────────────────────

/// The clipboard's current text, or `None` for anything we deliberately keep out:
/// a non-text format (an image, a file drop), an empty string, or a buffer so
/// large it was not meant as a text snippet.
///
/// Never blocks: if another process holds the clipboard open we return `None`
/// rather than wait, because this runs on the listener's message pump.
pub fn read_clipboard_text() -> Option<String> {
    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }
        let result = read_text_locked();
        let _ = CloseClipboard();
        result
    }
}

/// Whether the clipboard currently holds a bitmap (a screenshot, a copied image).
///
/// The history stores text only, so an image copy is silently dropped — which is
/// why a screen capture taken with Ctrl+Shift+S never appeared. The island asks
/// this to say so out loud rather than let the copy vanish without a word.
pub fn clipboard_has_image() -> bool {
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let has = IsClipboardFormatAvailable(CF_DIB).is_ok()
            || IsClipboardFormatAvailable(CF_BITMAP).is_ok()
            || IsClipboardFormatAvailable(CF_DIBV5).is_ok();
        let _ = CloseClipboard();
        has
    }
}

pub fn read_clipboard_image() -> Option<CapturedImage> {
    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }
        let result = read_image_locked();
        let _ = CloseClipboard();
        result
    }
}

unsafe fn read_image_locked() -> Option<CapturedImage> {
    IsClipboardFormatAvailable(CF_DIB).ok()?;
    let handle = GetClipboardData(CF_DIB).ok()?;
    if handle.is_invalid() {
        return None;
    }
    let global = HGLOBAL(handle.0);
    let size = GlobalSize(global);
    if size == 0 || size > 50 * 1024 * 1024 {
        return None;
    }
    let ptr = GlobalLock(global);
    if ptr.is_null() {
        return None;
    }
    let dib_slice = std::slice::from_raw_parts(ptr.cast::<u8>(), size);
    let dib = dib_slice.to_vec();
    let _ = GlobalUnlock(global);

    let bmp = dib_to_bmp(&dib)?;
    let img = image::load_from_memory(&bmp).ok()?;
    let (w, h) = (img.width(), img.height());

    let thumb = img.thumbnail(160, 90);
    let mut png_bytes = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut png_bytes, image::ImageFormat::Png).ok()?;
    use base64::prelude::*;
    let b64 = BASE64_STANDARD.encode(png_bytes.into_inner());
    let data_url = format!("data:image/png;base64,{b64}");

    Some(CapturedImage {
        dib,
        width: w,
        height: h,
        data_url,
    })
}

pub fn write_clipboard_image(dib: &[u8]) -> Result<(), String> {
    unsafe {
        let mut last = "the clipboard is busy".to_string();
        for attempt in 0..5 {
            if OpenClipboard(None).is_err() {
                last = "the clipboard is busy".into();
                std::thread::sleep(Duration::from_millis(40 * (attempt + 1)));
                continue;
            }
            let result = write_image_locked(dib);
            let _ = CloseClipboard();
            return result;
        }
        Err(last)
    }
}

unsafe fn write_image_locked(dib: &[u8]) -> Result<(), String> {
    let handle = GlobalAlloc(GMEM_MOVEABLE, dib.len()).map_err(|e| e.to_string())?;
    let ptr = GlobalLock(handle);
    if ptr.is_null() {
        return Err("out of memory".into());
    }
    std::ptr::copy_nonoverlapping(dib.as_ptr(), ptr.cast::<u8>(), dib.len());
    let _ = GlobalUnlock(handle);

    EmptyClipboard().map_err(|e| e.to_string())?;
    SetClipboardData(CF_DIB, Some(windows::Win32::Foundation::HANDLE(handle.0)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn restore_entry(id: &str, text: &str) -> Result<(), String> {
    let dib_path = image_dir().join(format!("{id}.dib"));
    if dib_path.exists() {
        if let Ok(bytes) = std::fs::read(&dib_path) {
            return write_clipboard_image(&bytes);
        }
    }
    write_clipboard_text(text)
}

/// `CF_BITMAP` and `CF_DIBV5`, next to `CF_DIB`.
const CF_BITMAP: u32 = 2;
const CF_DIBV5: u32 = 17;

unsafe fn read_text_locked() -> Option<String> {
    // Both return `Result<()>` in this crate version: `Err` is the failure.
    IsClipboardFormatAvailable(CF_UNICODETEXT).ok()?;
    // The clipboard APIs hand back a `HANDLE`, but the Global* memory functions
    // want an `HGLOBAL` — the same pointer under its own name.
    let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
    if handle.is_invalid() {
        return None;
    }
    let global = HGLOBAL(handle.0);
    let size = GlobalSize(global);
    if size == 0 || size > (MAX_ENTRY_CHARS + 1) * 2 {
        return None;
    }
    let ptr = GlobalLock(global);
    if ptr.is_null() {
        return None;
    }
    // The buffer is UTF-16 and NUL-terminated, but only its byte size is stored,
    // so the end has to be found by scanning for the terminator.
    let units = size / 2;
    let slice = std::slice::from_raw_parts(ptr.cast::<u16>(), units);
    let len = slice.iter().position(|&u| u == 0).unwrap_or(units);
    let text = String::from_utf16_lossy(&slice[..len]);
    let _ = GlobalUnlock(global);
    Some(text)
}

/// Puts an entry back on the clipboard, so clicking an old row really restores it.
pub fn write_clipboard_text(text: &str) -> Result<(), String> {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0); // the format requires the terminator
    let bytes = wide.len() * 2;

    unsafe {
        // The clipboard is a shared lockable resource. A few quick retries, then
        // give up: this runs under a UI click and failing instantly is worse than
        // waiting a fraction of a second.
        let mut last = "the clipboard is busy".to_string();
        for attempt in 0..5 {
            if OpenClipboard(None).is_err() {
                last = "the clipboard is busy".into();
                std::thread::sleep(Duration::from_millis(40 * (attempt + 1)));
                continue;
            }
            let result = write_text_locked(&wide, bytes);
            let _ = CloseClipboard();
            return result;
        }
        Err(last)
    }
}

unsafe fn write_text_locked(wide: &[u16], bytes: usize) -> Result<(), String> {
    // The clipboard takes ownership of a moveable block: freeing it here after a
    // successful SetClipboardData would leave the clipboard pointing at freed
    // memory, which is the classic way to corrupt someone's clipboard.
    let handle = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|e| e.to_string())?;
    let ptr = GlobalLock(handle);
    if ptr.is_null() {
        return Err("out of memory".into());
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr.cast::<u16>(), wide.len());
    let _ = GlobalUnlock(handle);

    EmptyClipboard().map_err(|e| e.to_string())?;
    // Hand the block over rather than freeing it: after a successful
    // SetClipboardData the clipboard owns it, and freeing it here is the classic
    // way to leave the clipboard pointing at released memory.
    // `SetClipboardData` wants a `HANDLE` and `GlobalAlloc` hands back an
    // `HGLOBAL`: the same pointer under the name this API was declared with.
    SetClipboardData(CF_UNICODETEXT, Some(windows::Win32::Foundation::HANDLE(handle.0)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Recording ──────────────────────────────────────────────────────────────────

/// Records one copy. Returns the entry only if it was actually kept, so the caller
/// can skip waking the island for a duplicate or a skipped secret.
pub fn record(store: &Shared, prefs: &Settings, text: String) -> Option<ClipEntry> {
    if !prefs.clipboard_enabled {
        return None;
    }
    if prefs.clipboard_skip_secrets && looks_like_secret(&text) {
        return None;
    }
    let text = normalize(&text, MAX_ENTRY_CHARS);

    let mut guard = store.lock().unwrap();
    guard.seq += 1;
    let seq = guard.seq;

    let at = now_secs();

    // An identical copy moves to the top instead of adding a second row.
    //
    // Scanned across the whole list, not just the head: re-copying something you
    // copied a while ago should bring that one row up, not leave the old copy
    // sitting there as a duplicate of itself.
    //
    // The existing row **keeps its id**. Minting a fresh id here is what put two
    // copies of the same text on screen: the listener recorded the copy and
    // emitted it, then opening the view re-read the clipboard and recorded the
    // same text again — and with a new id each time, neither the front end nor the
    // store could tell the two rows were the same one.
    if let Some(idx) = guard.entries.iter().position(|e| e.text == text) {
        let entry = ClipEntry {
            id: guard.entries[idx].id.clone(),
            pinned: guard.entries[idx].pinned,
            text,
            at,
            data_url: None,
            is_image: None,
        };
        guard.entries.remove(idx);
        guard.entries.insert(0, entry.clone());
        prune(&mut guard, prefs.clipboard_max_entries, prefs.clipboard_retention_minutes);
        write_out(&guard);
        return Some(entry);
    }

    let entry = ClipEntry {
        id: next_id(&text, seq),
        pinned: false,
        text,
        at,
        data_url: None,
        is_image: None,
    };
    guard.entries.insert(0, entry.clone());

    prune(&mut guard, prefs.clipboard_max_entries, prefs.clipboard_retention_minutes);
    write_out(&guard);
    Some(entry)
}

pub fn record_image(store: &Shared, prefs: &Settings, img: CapturedImage) -> Option<ClipEntry> {
    if !prefs.clipboard_enabled {
        return None;
    }

    let mut guard = store.lock().unwrap();
    guard.seq += 1;
    let seq = guard.seq;
    let at = now_secs();

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for chunk in img.dib.chunks(64) {
        if let Some(&first) = chunk.first() {
            hash ^= first as u64;
            hash = hash.wrapping_mul(0x1000_0000_01b3);
        }
    }
    hash ^= (img.dib.len() as u64).wrapping_mul(0x1000_0000_01b3);
    hash ^= (((img.width as u64) << 32) | (img.height as u64)).wrapping_mul(0x1000_0000_01b3);

    let text = format!("Image ({} × {})", img.width, img.height);
    let id_prefix = format!("{hash:016x}");

    if let Some(idx) = guard.entries.iter().position(|e| e.is_image == Some(true) && e.id.starts_with(&id_prefix)) {
        let old = guard.entries[idx].clone();
        let entry = ClipEntry {
            id: old.id.clone(),
            pinned: old.pinned,
            text: old.text,
            at,
            data_url: old.data_url,
            is_image: Some(true),
        };
        guard.entries.remove(idx);
        guard.entries.insert(0, entry.clone());
        prune(&mut guard, prefs.clipboard_max_entries, prefs.clipboard_retention_minutes);
        write_out(&guard);
        return Some(entry);
    }

    let id = format!("{id_prefix}-{seq}");

    let img_dir = image_dir();
    let _ = std::fs::create_dir_all(&img_dir);
    let _ = std::fs::write(img_dir.join(format!("{id}.dib")), &img.dib);

    let entry = ClipEntry {
        id,
        pinned: false,
        text,
        at,
        data_url: Some(img.data_url),
        is_image: Some(true),
    };

    guard.entries.insert(0, entry.clone());
    prune(&mut guard, prefs.clipboard_max_entries, prefs.clipboard_retention_minutes);
    write_out(&guard);
    Some(entry)
}

fn next_id(text: &str, seq: u64) -> String {
    format!("{}-{}", content_id(text), seq)
}

/// Puts two copies of "the same thing" into the same form, so the de-dupe below
/// actually recognises them.
///
/// This is the whole fix for the duplicate rows: copying a *selection* out of a
/// terminal or editor brings its own trailing newline, and the very next copy of
/// the same selection may not. Comparing the raw strings therefore missed, and
/// every re-copy added another identical row. Trailing whitespace is dropped and
/// CRLF is folded to LF; the text is otherwise left exactly as copied, because a
/// code snippet's leading indentation is the point.
fn normalize(text: &str, max_chars: usize) -> String {
    let folded = text.replace("\r\n", "\n");
    let trimmed = folded.trim_end();
    truncate_chars(trimmed.to_string(), max_chars)
}

fn truncate_chars(mut s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    let cut = s.char_indices().nth(max).map(|(i, _)| i).unwrap_or(s.len());
    s.truncate(cut);
    s
}

/// Newest first, pruned against the current preferences.
pub fn list(shared: &Shared, prefs: &Settings) -> Vec<ClipEntry> {
    let mut guard = shared.lock().unwrap();
    prune(&mut guard, prefs.clipboard_max_entries, prefs.clipboard_retention_minutes);
    write_out(&guard);
    guard.entries.clone()
}

pub fn remove(shared: &Shared, id: &str) {
    let mut guard = shared.lock().unwrap();
    guard.entries.retain(|e| e.id != id);
    let _ = std::fs::remove_file(image_dir().join(format!("{id}.dib")));
    write_out(&guard);
}

/// Marks a row kept or not. Returns whether it is now pinned.
pub fn set_pinned(shared: &Shared, id: &str, pinned: bool) -> bool {
    let mut guard = shared.lock().unwrap();
    match guard.entries.iter_mut().find(|e| e.id == id) {
        Some(entry) => {
            entry.pinned = pinned;
            let now = pinned;
            write_out(&guard);
            now
        }
        None => false,
    }
}

/// Replaces a row's text, for the transforms. Keeps the id and the pin so a
/// transformed row is still the same row.
pub fn replace_text(shared: &Shared, id: &str, text: String) -> Result<(), String> {
    let text = normalize(&text, MAX_ENTRY_CHARS);
    // Checked after normalizing, not before: a transform can hand back something
    // that is only whitespace ("   "), and storing that would blank a real row.
    if text.is_empty() {
        return Err("nothing left to copy".into());
    }
    let mut guard = shared.lock().unwrap();
    match guard.entries.iter_mut().find(|e| e.id == id) {
        Some(entry) => {
            entry.text = text;
            write_out(&guard);
            Ok(())
        }
        None => Err("that entry is gone".into()),
    }
}

pub fn clear(shared: &Shared) {
    let mut guard = shared.lock().unwrap();
    guard.entries.clear();
    let _ = std::fs::remove_dir_all(image_dir());
    write_out(&guard);
}

/// The process-wide history, loaded from disk on first use.
pub fn shared() -> Shared {
    static SHARED: OnceLock<Shared> = OnceLock::new();
    SHARED.get_or_init(|| Arc::new(Mutex::new(load(&store_path())))).clone()
}

// ── The listener ───────────────────────────────────────────────────────────────

struct ListenerCtx {
    app: AppHandle,
    store: Shared,
    prefs: Arc<Mutex<Settings>>,
}

const CLASS_NAME: &[u16] = &[
    b'C' as u16, b'o' as u16, b'u' as u16, b'c' as u16, b'o' as u16, b'u' as u16, b'C' as u16,
    b'l' as u16, b'p' as u16, 0,
];

/// Wakes the island so an open clipboard view updates itself. Fire-and-forget:
/// nothing here may block the message loop.
fn notify(app: &AppHandle, entry: &ClipEntry) {
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "clipboard", entry);
}

/// Handles one copy: read, filter, record, notify. Shared by the message handler
/// and the manual retry so both paths behave identically.
fn capture(ctx: &ListenerCtx) {
    let prefs = ctx.prefs.lock().unwrap().clone();
    if !prefs.clipboard_enabled {
        return;
    }
    if let Some(text) = read_clipboard_text() {
        if let Some(entry) = record(&ctx.store, &prefs, text) {
            notify(&ctx.app, &entry);
        }
    } else if let Some(img) = read_clipboard_image() {
        if let Some(entry) = record_image(&ctx.store, &prefs, img) {
            notify(&ctx.app, &entry);
        }
    }
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, _lparam: LPARAM) -> LRESULT {
    match msg {
        WM_CLIPBOARDUPDATE => {
            // The context address is stashed in the window's own user data, so
            // there is nothing to keep alive by hand and nothing to free.
            let ctx = get_ctx(hwnd);
            if let Some(ctx) = ctx {
                capture(ctx);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, _lparam) },
    }
}

/// `GWL_USERDATA`. The window's own user-data slot is where the context pointer
/// lives, so there is nothing to keep alive or free by hand.
const GWL_USERDATA: WINDOW_LONG_PTR_INDEX = WINDOW_LONG_PTR_INDEX(-21);

unsafe fn set_ctx(hwnd: HWND, ctx: *const ListenerCtx) {
    let _ = windows::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(hwnd, GWL_USERDATA, ctx as isize);
}

unsafe fn get_ctx(hwnd: HWND) -> Option<&'static ListenerCtx> {
    let raw = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(hwnd, GWL_USERDATA);
    if raw == 0 {
        return None;
    }
    Some(&*(raw as *const ListenerCtx))
}

/// Starts the clipboard listener on its own thread. Calling it twice is a no-op:
/// a second listener on the same clipboard would double-record everything.
pub fn start(app: AppHandle, store: Shared, prefs: Arc<Mutex<Settings>>) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("coucou-clipboard".into())
        .spawn(move || {
            // Leaked on purpose: the message-only window lives until the process
            // exits, and the window procedure dereferences this every message.
            let ctx: &'static ListenerCtx = Box::leak(Box::new(ListenerCtx { app, store, prefs }));
            unsafe { run_listener(ctx) };
        })
        .ok();
}

unsafe fn run_listener(ctx: &'static ListenerCtx) {
    let class = WNDCLASSW {
        lpfnWndProc: Some(wnd_proc),
        // `GetModuleHandleW` hands back an `HMODULE`; the class wants the
        // `HINSTANCE` spelling of the same handle.
        hInstance: GetModuleHandleW(None).unwrap_or_default().into(),
        lpszClassName: PCWSTR(CLASS_NAME.as_ptr()),
        ..Default::default()
    };
    // A duplicate registration is harmless: the second `start` never gets here.
    let _ = unsafe { RegisterClassW(&class) };

    // HWND_MESSAGE is a message-only window (parent -3): no presence on screen.
    let hwnd = match CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        PCWSTR(CLASS_NAME.as_ptr()),
        PCWSTR::null(),
        WINDOW_STYLE::default(),
        0,
        0,
        0,
        0,
        Some(HWND_MESSAGE),
        None,
        None,
        None,
    ) {
        Ok(h) => h,
        Err(e) => {
            crate::log::line(format!("clipboard listener window failed: {e}"));
            return;
        }
    };
    set_ctx(hwnd, ctx as *const ListenerCtx);

    // Registering before the first loop iteration is what makes a copy that
    // happened while the app was starting show up: the first WM_CLIPBOARDUPDATE
    // after registration reads the clipboard as it is *now*, so anything copied
    // during boot is captured rather than missed.
    if AddClipboardFormatListener(hwnd).is_err() {
        crate::log::line("clipboard listener could not register");
        let _ = DestroyWindow(hwnd);
        return;
    }
    capture(ctx);
    crate::log::line("clipboard listener started");

    let mut msg = MSG::default();
    loop {
        // GetMessageW: TRUE a message, FALSE WM_QUIT, negative an error.
        if !unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
            break;
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    let _ = RemoveClipboardFormatListener(hwnd);
    let _ = DestroyWindow(hwnd);
}

/// Re-reads the clipboard on demand. The listener misses a copy whenever another
/// process holds the clipboard open at that moment, so the island calls this when
/// it opens the history view: whatever is on the clipboard right now is almost
/// always something the user just copied and expects to see.
pub fn recapture(shared: &Shared, prefs: &Settings) -> Option<ClipEntry> {
    if !prefs.clipboard_enabled {
        return None;
    }
    if let Some(text) = read_clipboard_text() {
        record(shared, prefs, text)
    } else if let Some(img) = read_clipboard_image() {
        record_image(shared, prefs, img)
    } else {
        None
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A store backed by its own temp file, so a test can never touch the real
    /// %LOCALAPPDATA%\Coucou\clipboard.json and can never collide with another
    /// test running in parallel.
    ///
    /// Removes the directory on drop. Every test writes a real file, and leaving
    /// 26 of them behind in %TEMP% on each run is its own kind of mess.
    struct Sandbox {
        store: Shared,
        dir: PathBuf,
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn sandbox(tag: &str) -> Sandbox {
        let dir = std::env::temp_dir()
            .join(format!("coucou-clip-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clipboard.json");
        Sandbox {
            store: Arc::new(Mutex::new(load(&path))),
            dir,
        }
    }

    fn prefs() -> Settings {
        Settings { clipboard_enabled: true, ..Settings::default() }
    }

    #[test]
    fn recording_is_off_until_the_user_turns_it_on() {
        let sb = sandbox("off");
        let store = sb.store.clone();
        let mut p = prefs();
        p.clipboard_enabled = false;
        assert!(record(&store, &p, "hello".into()).is_none());
        assert!(store.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn newest_copy_is_first_and_a_repeat_moves_instead_of_duplicating() {
        let sb = sandbox("order");
        let store = sb.store.clone();
        let p = prefs();
        record(&store, &p, "first".into()).unwrap();
        record(&store, &p, "second".into()).unwrap();
        {
            let g = store.lock().unwrap();
            assert_eq!(g.entries[0].text, "second");
            assert_eq!(g.entries.len(), 2);
        }
        record(&store, &p, "second".into()).unwrap();
        let g = store.lock().unwrap();
        assert_eq!(g.entries.len(), 2, "an identical copy duplicated the row");
        assert_eq!(g.entries[0].text, "second");
    }

    #[test]
    fn the_cap_evicts_the_oldest() {
        let sb = sandbox("cap");
        let store = sb.store.clone();
        let mut p = prefs();
        p.clipboard_max_entries = 3;
        for i in 0..10 {
            record(&store, &p, format!("copy {i}")).unwrap();
        }
        let g = store.lock().unwrap();
        assert_eq!(g.entries.len(), 3);
        assert_eq!(g.entries[0].text, "copy 9");
        assert_eq!(g.entries[2].text, "copy 7");
    }

    #[test]
    fn retention_drops_what_is_too_old() {
        let sb = sandbox("retention");
        let store = sb.store.clone();
        let mut p = prefs();
        p.clipboard_retention_minutes = 10;
        store.lock().unwrap().entries.push(ClipEntry {
            id: "old".into(),
            pinned: false,
            text: "stale".into(),
            at: now_secs().saturating_sub(60 * 60),
            data_url: None,
            is_image: None,
        });
        record(&store, &p, "fresh".into()).unwrap();
        let g = store.lock().unwrap();
        assert_eq!(g.entries.len(), 1);
        assert_eq!(g.entries[0].text, "fresh");
    }

    #[test]
    fn retention_zero_keeps_everything() {
        let sb = sandbox("keep");
        let store = sb.store.clone();
        let mut p = prefs();
        p.clipboard_retention_minutes = 0;
        store.lock().unwrap().entries.push(ClipEntry {
            id: "old".into(),
            pinned: false,
            text: "ancient".into(),
            at: 1,
            data_url: None,
            is_image: None,
        });
        record(&store, &p, "fresh".into()).unwrap();
        assert_eq!(store.lock().unwrap().entries.len(), 2);
    }

    #[test]
    fn secrets_are_skipped_when_the_guard_is_on() {
        let sb = sandbox("secrets");
        let store = sb.store.clone();
        let mut p = prefs();
        p.clipboard_skip_secrets = true;
        assert!(record(&store, &p, "password: hunter2".into()).is_none());
        assert!(record(&store, &p, format!("ghp_{}", "a".repeat(40))).is_none());
        assert!(record(&store, &p, "-----BEGIN RSA PRIVATE KEY-----".into()).is_none());
        // Ordinary text still lands.
        assert!(record(&store, &p, "https://example.com/docs".into()).is_some());
    }

    #[test]
    fn the_secret_guard_can_be_turned_off() {
        let sb = sandbox("noguard");
        let store = sb.store.clone();
        let mut p = prefs();
        p.clipboard_skip_secrets = false;
        assert!(record(&store, &p, "password: hunter2".into()).is_some());
    }

    #[test]
    fn long_entries_are_truncated_rather_than_dropped() {
        let sb = sandbox("long");
        let store = sb.store.clone();
        let mut p = prefs();
        p.clipboard_skip_secrets = false;
        let entry = record(&store, &p, "x".repeat(MAX_ENTRY_CHARS * 2)).unwrap();
        assert_eq!(entry.text.chars().count(), MAX_ENTRY_CHARS);
    }

    #[test]
    fn a_repeat_copy_keeps_the_original_id() {
        let sb = sandbox("stable-id");
        let store = sb.store.clone();
        let p = prefs();
        // The listener records a copy and emits it; opening the view then re-reads
        // the clipboard and records the same text again. Minting a fresh id on the
        // second pass made the front end stack two rows for one Ctrl+C.
        // Recorded twice in a row, the way the listener and the view's re-read do.
        let first = record(&store, &p, "hello".into()).unwrap();
        let again = record(&store, &p, "hello".into()).unwrap();
        assert_eq!(
            first.id, again.id,
            "a repeat copy changed the row id, so the front end could not match it"
        );
    }

    #[test]
    fn ids_differ_for_two_genuinely_different_copies_of_the_same_text() {
        let sb = sandbox("ids");
        let store = sb.store.clone();
        let p = prefs();
        let first = record(&store, &p, "same".into()).unwrap();
        // Clearing the list takes the "not a repeat" branch, where the sequence
        // counter advances and a fresh id is minted. Two rows holding the same text
        // in the same list still get distinct keys.
        store.lock().unwrap().entries.clear();
        let second = record(&store, &p, "same".into()).unwrap();
        assert_ne!(first.id, second.id, "two copies shared a row id");
    }

    #[test]
    fn remove_and_clear_take_rows_out() {
        let sb = sandbox("remove");
        let store = sb.store.clone();
        let p = prefs();
        let entry = record(&store, &p, "bye".into()).unwrap();
        remove(&store, &entry.id);
        assert!(store.lock().unwrap().entries.is_empty());
        record(&store, &p, "again".into()).unwrap();
        clear(&store);
        assert!(store.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn the_history_survives_a_reload() {
        let sb = sandbox("persist");
        let store = sb.store.clone();
        let p = prefs();
        record(&store, &p, "kept".into()).unwrap();
        // A fresh process would read the file rather than inherit the memory, so
        // this is the one test that has to go back to the file rather than the
        // `Store` it just wrote through.
        let reloaded = load(&store.lock().unwrap().path);
        assert_eq!(reloaded.entries.len(), 1);
        assert_eq!(reloaded.entries[0].text, "kept");
    }

    #[test]
    fn a_corrupt_history_file_starts_empty_instead_of_failing() {
        let dir = std::env::temp_dir()
            .join(format!("coucou-clip-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clipboard.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(load(&path).entries.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_recopy_of_the_same_selection_does_not_add_a_second_row() {
        let sb = sandbox("recopy");
        let store = sb.store.clone();
        let p = prefs();
        // Copying a selection out of a terminal or editor brings a trailing
        // newline, and the next copy of the same selection may bring a different
        // one (or CRLF instead of LF). Comparing raw text missed that and every
        // re-copy added another identical row — which is exactly what two
        // Ctrl+Shift+S presses in a row produced.
        record(&store, &p, "npm run build\r\n".into()).unwrap();
        record(&store, &p, "npm run build".into()).unwrap();
        let g = store.lock().unwrap();
        assert_eq!(g.entries.len(), 1, "an identical copy added a duplicate row");
        assert_eq!(g.entries[0].text, "npm run build");
    }

    #[test]
    fn recopying_something_older_moves_that_row_up_instead_of_duplicating_it() {
        let sb = sandbox("recopy-old");
        let store = sb.store.clone();
        let p = prefs();
        record(&store, &p, "one".into()).unwrap();
        record(&store, &p, "two".into()).unwrap();
        record(&store, &p, "three".into()).unwrap();
        // "one" is now the oldest row; copying it again should surface it, not
        // leave the old copy behind as a duplicate.
        record(&store, &p, "one".into()).unwrap();
        let g = store.lock().unwrap();
        assert_eq!(g.entries.len(), 3);
        assert_eq!(g.entries[0].text, "one");
        assert_eq!(g.entries.iter().filter(|e| e.text == "one").count(), 1);
    }

    #[test]
    fn normalization_keeps_leading_indentation_but_drops_trailing_space() {
        // A code snippet's leading spaces are the point; the newline a selection
        // drag leaves behind is not.
        assert_eq!(normalize("  indented\r\n", 100), "  indented");
        assert_eq!(normalize("a\nb\n\n\n", 100), "a\nb");
        assert_eq!(normalize("no trailing", 100), "no trailing");
        // CRLF in the middle folds, so two spellings of one snippet match.
        assert_eq!(normalize("a\r\nb", 100), normalize("a\nb", 100));
        // Truncation still counts characters, not bytes.
        assert_eq!(normalize(&"é".repeat(50), 10).chars().count(), 10);
    }

    #[test]
    fn a_pin_survives_both_the_cap_and_the_sweep() {
        let sb = sandbox("pin");
        let store = sb.store.clone();
        let mut p = prefs();
        p.clipboard_max_entries = 3;
        record(&store, &p, "keep me".into()).unwrap();
        // The id is read and the lock dropped *before* pinning. Taking it inline
        // would hold the guard across the `set_pinned` call, and this mutex is not
        // reentrant — the test would deadlock instead of failing.
        let id = store.lock().unwrap().entries[0].id.clone();
        assert!(set_pinned(&store, &id, true));

        // Well past the cap, and old enough for any sane retention window.
        for i in 0..20 {
            record(&store, &p, format!("later {i}")).into_iter().for_each(drop);
        }
        {
            let g = store.lock().unwrap();
            assert_eq!(g.entries.iter().filter(|e| e.text == "keep me").count(), 1,
                "the pinned row was evicted by the cap");
        }

        store.lock().unwrap().entries[0].at = now_secs().saturating_sub(10 * 24 * 3600);
        {
            let g = store.lock().unwrap();
            write_out(&g);
        }
        list(&store, &p);
        assert!(store.lock().unwrap().entries.iter().any(|e| e.text == "keep me"),
            "the pinned row was swept as if it were ten days old");
    }

    #[test]
    fn unpinning_puts_a_row_back_in_the_queue() {
        let sb = sandbox("unpin");
        let store = sb.store.clone();
        let p = prefs();
        let entry = record(&store, &p, "temporary".into()).unwrap();
        set_pinned(&store, &entry.id, true);
        assert!(!set_pinned(&store, &entry.id, false), "still reported pinned");
        assert!(!store.lock().unwrap().entries[0].pinned);
    }

    #[test]
    fn a_transform_keeps_the_row_identity_and_the_pin() {
        let sb = sandbox("transform");
        let store = sb.store.clone();
        let p = prefs();
        let entry = record(&store, &p, "{\"a\":1}".into()).unwrap();
        set_pinned(&store, &entry.id, true);
        replace_text(&store, &entry.id, "{\n  \"a\": 1\n}".into()).unwrap();
        let g = store.lock().unwrap();
        assert_eq!(g.entries.len(), 1, "the transform added a second row");
        assert_eq!(g.entries[0].id, entry.id);
        assert!(g.entries[0].pinned, "the transform dropped the pin");
    }

    #[test]
    fn transforming_to_nothing_is_refused() {
        let sb = sandbox("transform-empty");
        let store = sb.store.clone();
        let entry = record(&store, &prefs(), "x".into()).unwrap();
        assert!(replace_text(&store, &entry.id, "   ".into()).is_err());
        assert_eq!(store.lock().unwrap().entries[0].text, "x");
    }

    #[test]
    fn pins_are_bounded_so_the_history_cannot_grow_without_limit() {
        // Pins are exempt from the sweep and from the cap, but not forever: a
        // ceiling well above the cap stops a pin-heavy history growing the file
        // without limit.
        let sb = sandbox("pin-bound");
        let store = sb.store.clone();
        let mut p = prefs();
        p.clipboard_max_entries = 4;
        for i in 0..40 {
            let e = record(&store, &p, format!("pinned {i}")).unwrap();
            set_pinned(&store, &e.id, true);
        }
        let g = store.lock().unwrap();
        assert_eq!(g.entries.len(), 4 * PIN_CEILING);
        assert!(g.entries.iter().all(|e| e.pinned), "an unpinned row beat a pin in");
    }

    #[test]
    fn the_secret_shapes_cover_the_obvious_cases() {
        assert!(looks_like_secret("api_key = abc123"));
        assert!(looks_like_secret("Bearer eyJhbGciOi"));
        assert!(!looks_like_secret("just a normal sentence"));
        assert!(!looks_like_secret(""));
        // A URL has dots and slashes, so the long-bare-token rule must not eat it.
        assert!(!looks_like_secret(&format!("https://example.com/{}", "a".repeat(40))));
    }
}
