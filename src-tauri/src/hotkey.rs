// A global hotkey that summons the island, and one that quiets it.
//
// `RegisterHotKey` directly rather than a shortcut plugin: it is one call, it is
// in the `windows` crate we already depend on, and the alternative is a new
// third-party dependency for two fixed chords.
//
// WM_HOTKEY is posted to the thread that owns the window, and that is Tauri's main
// thread — a message loop of our own would never see it. So the island window's
// procedure is subclassed and everything except WM_HOTKEY is forwarded untouched.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, VK_C, VK_Q,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, SetWindowLongPtrW, GWLP_WNDPROC, WM_HOTKEY,
};

use crate::island;

/// Ctrl+Alt+C. Deliberately not Win+C: that belongs to Copilot, and a hotkey that
/// fights the OS shell feels broken rather than clever.
///
/// Not a `const`: `HOT_KEY_MODIFIERS` is a newtype over u32 with no const `BitOr`.
fn mods() -> HOT_KEY_MODIFIERS {
    MOD_CONTROL | MOD_ALT
}

const ID_SUMMON: i32 = 0x0C01;
/// Ctrl+Alt+Q, chosen by testing which chords were actually free on a real
/// machine rather than by taste. Ctrl+Alt+M was the obvious mnemonic for
/// "mute" and is already owned by something else, so the app came up without the
/// key and the only symptom was one line in the log. Q was free and still reads.
const ID_QUIET: i32 = 0x0C02;

/// What a press means. Rust decides, so the front end never has to know whether
/// the island is currently up.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Summon {
    /// Hidden or compact → open it.
    Show,
    /// Open → fold it away. A key that only opens is a one-way door.
    Hide,
}

/// The window procedure we replaced, plus the app handle to route presses to.
/// Both live for the life of the process: the subclass is never removed, and the
/// island window outlives every caller.
struct Ctx {
    app: AppHandle,
    previous: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
    previous_ptr: isize,
}

static mut CTX: *mut Ctx = std::ptr::null_mut();

pub fn register(app: &AppHandle) {
    let Some(hwnd) = island::hwnd(app) else { return };

    unsafe {
        let previous_ptr = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, subclass_proc as *const () as isize);
        if previous_ptr == 0 {
            crate::log::line("hotkey: could not subclass the island window");
            return;
        }
        let previous: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT =
            std::mem::transmute(previous_ptr);
        CTX = Box::into_raw(Box::new(Ctx {
            app: app.clone(),
            previous,
            previous_ptr,
        }));
    };

    // Fails when another app already owns the chord. Not fatal and not worth a
    // modal: the island still opens by hovering the top of the screen.
    if unsafe { RegisterHotKey(Some(hwnd), ID_SUMMON, mods(), VK_C.0 as u32) }.is_err() {
        crate::log::line("summon hotkey unavailable (Ctrl+Alt+C already taken)");
    } else {
        crate::log::line("summon hotkey registered (Ctrl+Alt+C)");
    }
    // Independent of the first: losing Ctrl+Alt+C must not also cost the quiet
    // key, or one collision would take out both.
    if unsafe { RegisterHotKey(Some(hwnd), ID_QUIET, mods(), VK_Q.0 as u32) }.is_err() {
        crate::log::line("quiet hotkey unavailable (Ctrl+Alt+Q already taken)");
    } else {
        crate::log::line("quiet hotkey registered (Ctrl+Alt+Q)");
    }
}

/// Restores the original window procedure. Called on quit.
pub fn unregister(app: &AppHandle) {
    if let Some(hwnd) = island::hwnd(app) {
        unsafe {
            let _ = UnregisterHotKey(Some(hwnd), ID_SUMMON);
            let _ = UnregisterHotKey(Some(hwnd), ID_QUIET);
            if !CTX.is_null() {
                let ctx = Box::from_raw(CTX);
                let _ = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, ctx.previous_ptr);
                CTX = std::ptr::null_mut();
            }
        }
    }
}

/// Flips `quiet_hover`, saves it, and tells both windows.
///
/// Returns the new value. Shared by the hotkey and the tray item so the two can
/// never disagree about whether the island is quiet.
pub fn toggle_quiet(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<crate::Shared>() else {
        return false;
    };
    let next = {
        let mut settings = state.settings.lock().unwrap();
        settings.quiet_hover = !settings.quiet_hover;
        let next = settings.quiet_hover;
        if let Err(err) = crate::settings::save(&settings) {
            crate::log::line(format!("quiet: could not save ({err})"));
        }
        next
    };
    crate::tray::set_quiet_checked(next);
    crate::log::line(if next {
        "quiet on hover: on, the island will not wake from the pointer"
    } else {
        "quiet on hover: off"
    });
    let settings = state.settings.lock().unwrap().clone();
    let _ = app.emit("settings-changed", settings);
    next
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let ctx = CTX;
    if ctx.is_null() {
        return LRESULT(0);
    }
    let ctx = &*ctx;
    if msg == WM_HOTKEY {
        let id = wparam.0 as i32;
        if id == ID_SUMMON {
            // `collapsed` is the same flag the wake strip uses: false means the panel
            // is open. Reading it is what makes the key toggle instead of only opening.
            let collapsed = ctx
                .app
                .try_state::<crate::Shared>()
                .map(|s| s.gate.collapsed.load(std::sync::atomic::Ordering::Relaxed))
                .unwrap_or(false);
            let _ = ctx.app.emit_to(
                island::WINDOW_LABEL,
                "summon",
                if collapsed { Summon::Show } else { Summon::Hide },
            );
            return LRESULT(0);
        }
        if id == ID_QUIET {
            toggle_quiet(&ctx.app);
            return LRESULT(0);
        }
    }
    unsafe { CallWindowProcW(Some(ctx.previous), hwnd, msg, wparam, lparam) }
}