// Now-playing view: what the OS media session says is playing, with transport
// buttons that really drive the Brave tab, a progress bar, and one lyric line.
//
// Like the clipboard and shelf, the track is owned by Rust and only mirrored
// into `State`. The progress bar advances locally between snapshots; lyrics
// load once per track and never poll.

import { Bridge, type MediaMood, type MediaSnapshot } from "../core/bridge";
import { State } from "../core/state";
import { h, svg, clear } from "../views/dom";
import { ICONS } from "../views/icons";
import { card } from "../views/views";
import type { ViewHost } from "../views/views";
import type { BotEmoteName } from "../core/layout";

/** A synced lyric line with its start time. */
export interface LyricLine {
  atMs: number;
  text: string;
}

/**
 * Parses LRC (`[mm:ss.xx] line`, also `[mm:ss]`). Malformed lines are skipped,
 * never fatal: a half-broken lyrics file still shows the lines that parsed.
 */
export function parseLrc(raw: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\s*\]\s*(.*)$/);
    if (!m) continue;
    const min = Number(m[1]);
    const sec = Number(m[2]);
    let frac = m[3] ?? "";
    // centiseconds (2 digits) or milliseconds (3); one digit means tenths.
    while (frac.length < 3) frac += "0";
    const atMs = min * 60_000 + sec * 1000 + Number(frac.slice(0, 3));
    const text = m[4].trim();
    if (!text) continue;
    out.push({ atMs, text });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

/** Index of the line playing at `posMs`, or -1 before the first line. */
export function lyricIndexAt(lines: LyricLine[], posMs: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].atMs <= posMs) idx = i;
    else break;
  }
  return idx;
}

/** Mochi's face per song mood. Neutral (no Spotify data) bops without emoting. */
export const MOOD_EMOTE: Record<MediaMood, BotEmoteName | null> = {
  neutral: null,
  fiery: "proud",
  bright: "happy",
  mellow: "wink",
  blue: "yawn",
};

/** Bounce amplitude per mood. Blue barely moves; fiery jumps. */
export const MOOD_BOUNCE: Record<MediaMood, number> = {
  neutral: 0.5,
  fiery: 1.0,
  bright: 0.7,
  mellow: 0.4,
  blue: 0.15,
};

/** Identity of the track on screen, for change detection. */
export function musicKey(m: MediaSnapshot): string {
  return `${m.title}\x00${m.artist}\x00${m.album}`;
}

let lyricKey: string | null = null;

function fmtTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function positionNow(): number {
  const m = State.media;
  if (!m) return 0;
  const elapsed = m.playing ? (performance.now() - State.mediaAtWallMs) / 1000 : 0;
  return Math.min(m.positionSecs + Math.max(0, elapsed), m.durationSecs || Infinity);
}

export function buildMusic(): ViewHost {
  const art = h("img", { class: "music-art" }) as HTMLImageElement;
  const artFallback = h("div", { class: "music-art-fallback" }, svg(ICONS.note, 16));
  const title = h("div", { class: "music-title" });
  const artist = h("div", { class: "music-artist" });

  const transport = (op: string, icon: string, label: string) =>
    h("button", {
      class: `music-btn${op === "toggle" ? " main" : ""}`,
      title: label,
      onclick: async () => {
        await Bridge.mediaCommand(op);
        await refreshMedia();
      },
    }, svg(ICONS[icon as keyof typeof ICONS], op === "toggle" ? 15 : 12));

  const btnPrev = transport("prev", "prev", "Previous");
  const btnPlay = transport("toggle", "play", "Play or pause");
  const btnNext = transport("next", "next", "Next");

  const barFill = h("div", { class: "music-bar-fill" });
  const bar = h("div", { class: "music-bar" }, barFill);
  const timeCur = h("span", { class: "music-time" });
  const timeEnd = h("span", { class: "music-time" });
  const lyric = h("div", { class: "music-lyric" });

  const head = h(
    "div",
    { class: "music-head" },
    h("div", { class: "music-artwrap" }, art, artFallback),
    h("div", { class: "music-meta" }, title, artist),
    h("div", { class: "music-transport" }, btnPrev, btnPlay, btnNext),
  );
  const times = h("div", { class: "music-times" }, timeCur, bar, timeEnd);
  const el = h("div", { class: "view" }, card(null, h("div", { class: "music-body" }, head, times, lyric)));

  const paint = () => {
    const m = State.media;
    if (!m || !m.active) {
      title.textContent = State.settings.mediaEnabled ? "Nothing playing." : "Now playing is off.";
      artist.textContent = State.settings.mediaEnabled
        ? "Play something in Brave and it shows up here."
        : "Turn it on in Settings to see your music here.";
      art.style.display = "none";
      artFallback.style.display = "";
      barFill.style.width = "0%";
      timeCur.textContent = "";
      timeEnd.textContent = "";
      lyric.textContent = "";
      for (const b of [btnPrev, btnPlay, btnNext]) b.setAttribute("disabled", "");
      return;
    }
    title.textContent = m.title || "Unknown title";
    artist.textContent = m.artist || m.album || "Unknown artist";
    if (m.art) {
      art.src = m.art;
      art.style.display = "";
      artFallback.style.display = "none";
    } else {
      art.removeAttribute("src");
      art.style.display = "none";
      artFallback.style.display = "";
    }
    // The play button shows what pressing it does, not the current state.
    clear(btnPlay);
    btnPlay.append(svg(ICONS[m.playing ? "pause" : "play"], 15));
    btnPlay.toggleAttribute("disabled", m.playing ? !m.canPause : !m.canPlay);
    btnPrev.toggleAttribute("disabled", !m.canPrev);
    btnNext.toggleAttribute("disabled", !m.canNext);

    const pos = positionNow();
    barFill.style.width = m.durationSecs > 0 ? `${Math.min(100, (pos / m.durationSecs) * 100)}%` : "0%";
    timeCur.textContent = fmtTime(pos);
    timeEnd.textContent = m.durationSecs > 0 ? fmtTime(m.durationSecs) : "";

    if (State.lyricLines?.length) {
      const i = lyricIndexAt(State.lyricLines, pos * 1000);
      lyric.textContent = i >= 0 ? State.lyricLines[i].text : "♪";
      lyric.classList.toggle("empty", false);
    } else {
      lyric.textContent = State.lyricNote ?? "";
      lyric.classList.toggle("empty", true);
    }
  };

  return {
    el,
    sync: paint,
    tick() {
      // Progress and the lyric line move every frame while the view is open;
      // snapshots only land every couple of seconds.
      if (State.view === "music") paint();
    },
  };
}

/** Pulls the snapshot (and lyrics for a new track) into State. */
export async function refreshMedia(): Promise<void> {
  if (!State.settings.mediaEnabled) {
    State.media = null;
    State.lyricLines = null;
    State.lyricNote = null;
    lyricKey = null;
    State.notify();
    return;
  }
  const snap = await Bridge.mediaSnapshot();
  applySnapshot(snap);
}

/** Stores a snapshot from the poller event or a manual refresh. */
export function applySnapshot(snap: MediaSnapshot | null): void {
  State.media = snap?.active ? snap : null;
  State.mediaAtWallMs = performance.now();
  const key = snap?.active ? musicKey(snap) : null;
  if (key !== lyricKey) {
    lyricKey = key;
    State.lyricLines = null;
    State.lyricNote = null;
    if (key && snap) {
      void loadLyrics(snap);
      void enrichTrack(key, snap);
    }
  }
  State.notify();
}

/**
 * Spotify enrichment for a new track: mood + fallback art. One call per song,
 * skipped silently when unlinked — the OS data is already on screen, so this
 * can only add, never take away.
 */
async function enrichTrack(key: string, snap: MediaSnapshot): Promise<void> {
  const res = await Bridge.mediaEnrich(snap.title, snap.artist);
  if (lyricKey !== key || !res) return;
  const cur = State.media;
  if (!cur || musicKey(cur) !== key) return;
  let changed = false;
  if (res.mood && res.mood !== "neutral" && cur.mood !== res.mood) {
    cur.mood = res.mood;
    changed = true;
  }
  if (res.art && !cur.art) {
    cur.art = res.art;
    changed = true;
  }
  if (changed) State.notify();
}

async function loadLyrics(snap: MediaSnapshot): Promise<void> {
  const key = musicKey(snap);
  if (!State.settings.mediaLyrics) {
    // Not an error and not worth a lookup: the toggle says no.
    if (lyricKey === key) State.lyricNote = "Turn on Lyrics in Settings to see them here.";
    State.notify();
    return;
  }
  const res = await Bridge.mediaLyrics(snap.artist, snap.title, snap.album, snap.durationSecs);
  // A newer track may have arrived while the request was in flight; stale
  // lyrics landing on the wrong song is worse than none.
  if (lyricKey !== key) return;
  if (res?.synced) {
    State.lyricLines = parseLrc(res.synced);
    State.lyricNote = State.lyricLines.length ? null : "No lyrics found for this track.";
    if (!State.lyricLines.length) State.lyricLines = null;
  } else if (res?.plain) {
    // Unsynced: one static block, no line to highlight.
    State.lyricLines = [{ atMs: 0, text: res.plain }];
    State.lyricNote = null;
  } else {
    State.lyricLines = null;
    State.lyricNote = "No lyrics found for this track.";
  }
  State.notify();
}
