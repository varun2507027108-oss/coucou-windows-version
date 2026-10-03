// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  /**
   * Activates the window already running this agent session — the editor, the
   * terminal, or the agent's own app — or falls back to launching it.
   * `file` is the session's active file name when known ("activate.rs"); VS Code
   * titles usually read "<file> — <folder>", so it is a second match signal.
   */
  activateTarget: (agent: string, cwd: string | null, file?: string | null) =>
    call<boolean>("activate_target", { agent, cwd, file: file ?? null }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  // ── OpenCode hooks ────────────────────────────────────────────────────
  opencodeStatus: () => call<AgentHookStatus>("opencode_status"),
  opencodePreview: (install: boolean) =>
    callOrThrow<AgentHookPreview>("opencode_preview", { install }),
  opencodeApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("opencode_apply", { install, fingerprint }),

  // ── Antigravity hooks ─────────────────────────────────────────────────
  antigravityStatus: () => call<AgentHookStatus>("antigravity_status"),
  antigravityPreview: (install: boolean) =>
    callOrThrow<AgentHookPreview>("antigravity_preview", { install }),
  antigravityApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("antigravity_apply", { install, fingerprint }),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string }>("chat_send", { query, context }),
  chatReset: () => call<void>("chat_reset"),
  /** Fetches available models from Anthropic API. */
  claudeModels: () => callOrThrow<{ id: string; label: string }[]>("claude_models"),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),

  // ── Clipboard history ─────────────────────────────────────────────────────
  /** Newest first. Rust also re-reads the clipboard here, to catch a copy the
   *  listener missed because another app held the clipboard open. */
  clipboardList: () => call<ClipEntry[]>("clipboard_list"),
  /** Puts an old entry back on the clipboard — the point of the history. */
  clipboardRestore: (text: string, id?: string) =>
    callOrThrow<void>("clipboard_restore", { text, id: id ?? null }),
  clipboardRemove: (id: string) => call<void>("clipboard_remove", { id }),
  clipboardClear: () => call<void>("clipboard_clear"),
  /**
   * True when the clipboard holds a bitmap (a screen capture, a copied image).
   * A text-only history cannot store those, and the island uses this to say so
   * rather than let the copy vanish silently.
   */
  clipboardHasImage: () => call<boolean>("clipboard_has_image"),
  /** Pins a row so the sweep and the cap leave it alone. */
  clipboardPin: (id: string, pinned: boolean) => call<boolean>("clipboard_pin", { id, pinned }),
  /** Rewrites a row's text after a transform; the id and pin survive. */
  clipboardTransform: (id: string, text: string) =>
    callOrThrow<void>("clipboard_transform", { id, text }),

  // ── File shelf ───────────────────────────────────────────────────────────
  shelfAdd: (path: string) => callOrThrow<ShelfItem>("shelf_add", { path }),
  shelfList: () => call<ShelfItem[]>("shelf_list"),
  /** Rust refuses any path outside the shelf directory. */
  shelfRemove: (path: string) => callOrThrow<void>("shelf_remove", { path }),
  shelfClear: () => call<void>("shelf_clear"),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Now playing (OS media session) ────────────────────────────────────
  /** Current track, if any. Local only — no account, no network. */
  mediaSnapshot: () => call<MediaSnapshot>("media_snapshot"),
  /** play | pause | toggle | next | prev. Fires from your clicks only. */
  mediaCommand: (op: string) => call<boolean>("media_command", { op }),
  /** Synced + plain lyrics for a track. Offline, disabled, or missing → empty. */
  mediaLyrics: (artist: string, title: string, album: string, durationSecs: number) =>
    call<MediaLyrics>("media_lyrics", { artist, title, album, durationSecs }),
  /** Spotify enrichment for a track: mood + fallback art. Unlinked → neutral. */
  mediaEnrich: (title: string, artist: string) =>
    call<MediaEnrichment>("media_enrich", { title, artist }),
  /** Linked Spotify account? Never exposes tokens — just the state. */
  spotifyStatus: () => call<SpotifyStatus>("spotify_status"),
  /** Returns the Spotify authorize URL; tokens land via the `spotify` event. */
  spotifyBegin: () => callOrThrow<string>("spotify_begin"),
  /** Drops every Spotify credential. Returns the new (unlinked) status. */
  spotifyUnlink: () => call<SpotifyStatus>("spotify_unlink"),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),
};

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

/** One row of the clipboard history. `id` is a stable key for the UI. */
export interface ClipEntry {
  id: string;
  text: string;
  /** Unix seconds. */
  at: number;
  /** Kept regardless of the retention window or the cap. */
  pinned: boolean;
  dataUrl?: string;
  isImage?: boolean;
}

/** Song mood. "neutral" until the Spotify link enriches it with audio-features. */
export type MediaMood = "neutral" | "fiery" | "bright" | "mellow" | "blue";

/** What the OS media session says is playing. All local, no accounts. */
export interface MediaSnapshot {
  active: boolean;
  playing: boolean;
  title: string;
  artist: string;
  album: string;
  positionSecs: number;
  durationSecs: number;
  /** data: URL art, or null. */
  art: string | null;
  canPlay: boolean;
  canPause: boolean;
  canNext: boolean;
  canPrev: boolean;
  mood: MediaMood;
}

/** Lyrics for one track. Both null when there are none to show. */
export interface MediaLyrics {
  synced: string | null;
  plain: string | null;
}

/** What the enrichment pass adds on top of the OS snapshot. */
export interface MediaEnrichment {
  mood: MediaMood;
  art: string | null;
}

/** Spotify link state. Tokens never cross this boundary. */
export interface SpotifyStatus {
  linked: boolean;
  hasClientId: boolean;
}

/** A file parked on the shelf, with a real path to drag out again. */
export interface ShelfItem {
  name: string;
  path: string;
  size: number;
  /** Unix seconds. */
  at: number;
  /** True once the copy behind it is gone. */
  missing: boolean;
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Status for the OpenCode / Antigravity installers. Same fields as
 *  HookStatus, plus the agent it belongs to. */
export interface AgentHookStatus extends HookStatus {
  agent: string;
}

export type AgentHookPreview = HookPreview;

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
