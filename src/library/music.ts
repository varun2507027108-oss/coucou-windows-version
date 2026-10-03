// Now-playing view: what the OS media session says is playing, with transport
// buttons that really drive the Brave tab, a draggable timeline, and lyrics.
//
// Like the clipboard and shelf, the track is owned by Rust and only mirrored
// into `State`. Snapshots land every couple of seconds; everything that moves
// between them is advanced here.
//
// Two performance rules shape this file, because a player that stutters is worse
// than a plain one:
//
//   * `sync` writes the whole view, and only when a snapshot actually changed.
//   * `tick` runs every animation frame, so it touches exactly three nodes —
//     the progress fill, the elapsed label and the lyric line — and skips the
//     write entirely when the text or the rounded percentage has not changed.
//     Rewriting all of it at 60 Hz is what made the bar feel laggy.
//
// The ambience comes from the cover: `palette.ts` samples it and the result is
// written to CSS custom properties, so the glow around the panel is the album's
// own colour rather than a fixed accent.

import { Bridge, type MediaMood, type MediaSnapshot } from "../core/bridge";
import { State } from "../core/state";
import { h, svg, clear } from "../views/dom";
import { ICONS } from "../views/icons";
import { card } from "../views/views";
import type { ViewHost } from "../views/views";
import type { BotEmoteName } from "../core/layout";
import { loadPalette } from "./palette";

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

/** Word shown on the mood chip. Only set once Spotify has looked the song up. */
const MOOD_LABEL: Record<MediaMood, string> = {
  neutral: "",
  fiery: "fiery",
  bright: "bright",
  mellow: "mellow",
  blue: "blue",
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

/** Fraction 0..1 of the way through the track. 0 when the length is unknown. */
export function progressOf(positionSecs: number, durationSecs: number): number {
  if (!(durationSecs > 0)) return 0;
  return Math.max(0, Math.min(1, positionSecs / durationSecs));
}

/** Seconds at `fraction` of the way along a track of `durationSecs`. */
export function positionAt(fraction: number, durationSecs: number): number {
  if (!(durationSecs > 0)) return 0;
  return Math.max(0, Math.min(1, fraction)) * durationSecs;
}

export function buildMusic(): ViewHost {
  // ── Structure ────────────────────────────────────────────────────────────
  // Two absolutely-positioned glow layers behind everything, tinted from the
  // cover. `--amb-base` etc. are set by `applyPalette` and fall back to the
  // island's own neutrals in CSS, so a track with no readable art still looks
  // deliberate rather than broken.
  const glowA = h("div", { class: "music-glow music-glow-a" });
  const glowB = h("div", { class: "music-glow music-glow-b" });
  const glowSheen = h("div", { class: "music-glow music-glow-sheen" });

  const art = h("img", { class: "music-art", alt: "" }) as HTMLImageElement;
  const artFallback = h("div", { class: "music-art-fallback" }, svg(ICONS.waveform, 22));
  const artWrap = h("div", { class: "music-artwrap" }, art, artFallback);

  const title = h("div", { class: "music-title" });
  const artist = h("div", { class: "music-artist" });
  const moodChip = h("div", { class: "music-mood" });

  // Four bars that breathe while the track plays. Purely decorative — the OS
  // gives us no audio samples, so this is a mood-driven animation and nothing
  // pretends to be a spectrum analyser.
  const bars = h("div", { class: "music-viz" },
    ...[0, 1, 2, 3].map((i) => h("span", { class: "music-viz-bar", style: `--i:${i}` })));

  const meta = h("div", { class: "music-meta" }, title, artist,
    h("div", { class: "music-subrow" }, moodChip, bars));

  const transport = (op: string, icon: string, label: string, main = false) =>
    h("button", {
      class: `music-btn${main ? " main" : ""}`,
      title: label,
      "aria-label": label,
      // Pointer, not default: the old default cursor made these read as labels.
      onclick: async () => {
        if (dragging) return;
        await Bridge.mediaCommand(op);
        await refreshMedia();
      },
    }, svg(ICONS[icon as keyof typeof ICONS], main ? 20 : 17));

  const btnPrev = transport("prev", "prev", "Previous");
  const btnPlay = transport("toggle", "play", "Play or pause", true);
  const btnNext = transport("next", "next", "Next");
  const transportRow = h("div", { class: "music-transport" }, btnPrev, btnPlay, btnNext);

  const barFill = h("div", { class: "music-bar-fill" });
  const barKnob = h("div", { class: "music-bar-knob" });
  const barGhost = h("div", { class: "music-bar-ghost" });
  const bar = h("div", { class: "music-bar", role: "slider", tabindex: "0",
    "aria-label": "Seek" }, barGhost, barFill, barKnob);
  const scrubTip = h("div", { class: "music-scrub-tip" });
  const timeCur = h("span", { class: "music-time" });
  const timeEnd = h("span", { class: "music-time end" });
  const times = h("div", { class: "music-times" }, timeCur, bar, timeEnd, scrubTip);

  // Lyrics get the leftover height, with the neighbouring lines dimmed so the
  // current one reads as the focal point without anything having to scroll.
  const lyricPrev = h("div", { class: "music-lyric prev" });
  const lyricNow = h("div", { class: "music-lyric now" });
  const lyricNext = h("div", { class: "music-lyric next" });
  const lyrics = h("div", { class: "music-lyrics" }, lyricPrev, lyricNow, lyricNext);

  // Transport sits in the top-right rather than on a row of its own. Centred
  // under a wide panel it left the right half of the header empty and spent a
  // whole 48 px band saying nothing; here it balances the cover and gives those
  // 48 px back to the lyrics.
  const panel = h("div", { class: "music-body" },
    glowA, glowB, glowSheen,
    h("div", { class: "music-stage" }, artWrap, meta, transportRow),
    times,
    lyrics);
  const el = h("div", { class: "view" }, card(null, panel));

  // ── Scrubbing ────────────────────────────────────────────────────────────
  // Pointer events rather than separate mouse/touch handlers: a trackpad drag
  // and a finger drag then take exactly the same path, and `setPointerCapture`
  // keeps the drag alive when the pointer leaves the 4px bar.
  let dragging = false;
  let dragFraction = 0;

  const fractionAt = (clientX: number): number => {
    const r = bar.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const showScrub = (fraction: number, secs: number) => {
    bar.classList.add("scrubbing");
    barFill.style.transform = `scaleX(${fraction})`;
    barKnob.style.left = `${fraction * 100}%`;
    scrubTip.textContent = fmtTime(secs);
    scrubTip.style.left = `${fraction * 100}%`;
    scrubTip.classList.add("on");
    timeCur.textContent = fmtTime(secs);
  };

  const endScrub = async () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove("scrubbing");
    scrubTip.classList.remove("on");
    const m = State.media;
    if (m?.canSeek && m.durationSecs > 0) {
      // Move the local clock first so the bar does not jump backwards while the
      // command is in flight, then let the next snapshot confirm it.
      const target = positionAt(dragFraction, m.durationSecs);
      State.media = { ...m, positionSecs: target };
      State.mediaAtWallMs = performance.now();
      const ok = await Bridge.mediaSeek(target);
      if (!ok) await refreshMedia();
    } else {
      await refreshMedia();
    }
    State.notify();
  };

  bar.addEventListener("pointerdown", (e) => {
    const m = State.media;
    if (!m?.active || !(m.durationSecs > 0)) return;
    dragging = true;
    // Guarded: capture throws NotFoundError for a pointer the browser does not
    // know about, and a throw here would abort the handler before the drag
    // position is even read.
    try {
      bar.setPointerCapture(e.pointerId);
    } catch {
      /* no capture available; the window-level listeners still track the drag */
    }
    dragFraction = fractionAt(e.clientX);
    showScrub(dragFraction, positionAt(dragFraction, m.durationSecs));
    e.preventDefault();
  });
  bar.addEventListener("pointermove", (e) => {
    const m = State.media;
    if (!m?.active || !(m.durationSecs > 0)) return;
    const f = fractionAt(e.clientX);
    if (!dragging) {
      // Hover: show where you would land, without pretending it moved.
      scrubTip.textContent = fmtTime(positionAt(f, m.durationSecs));
      scrubTip.style.left = `${f * 100}%`;
      scrubTip.classList.add("on");
      return;
    }
    dragFraction = f;
    showScrub(f, positionAt(f, m.durationSecs));
  });
  const leaveBar = () => {
    if (dragging) return;
    scrubTip.classList.remove("on");
  };
  bar.addEventListener("pointerleave", leaveBar);
  bar.addEventListener("pointerup", () => void endScrub());
  bar.addEventListener("pointercancel", () => void endScrub());
  bar.addEventListener("keydown", (e) => {
    const m = State.media;
    if (!m?.active || !m.canSeek) return;
    const step = e.shiftKey ? 30 : 5;
    const now = positionNow();
    let target: number | null = null;
    if (e.key === "ArrowRight") target = now + step;
    else if (e.key === "ArrowLeft") target = now - step;
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = m.durationSecs;
    if (target === null) return;
    e.preventDefault();
    const clamped = Math.max(0, Math.min(m.durationSecs, target));
    State.media = { ...m, positionSecs: clamped };
    State.mediaAtWallMs = performance.now();
    void Bridge.mediaSeek(clamped);
    State.notify();
  });

  // ── Palette ──────────────────────────────────────────────────────────────
  // The cover is sampled once per track and parked in `State.mediaAccent`, so
  // this only has to copy it onto the panel — and the compact bar tints itself
  // from the same place without the view ever being open.
  const applyPalette = () => {
    const p = State.mediaAccent;
    if (!p) {
      panel.style.removeProperty("--amb-base");
      panel.style.removeProperty("--amb-deep");
      panel.style.removeProperty("--amb-light");
      return;
    }
    panel.style.setProperty("--amb-base", p.base);
    panel.style.setProperty("--amb-deep", p.deep);
    panel.style.setProperty("--amb-light", p.light);
  };

  // ── Painting ─────────────────────────────────────────────────────────────
  // Remembered so `tick` can skip a write that would not change anything.
  let lastPct = -1;
  let lastCur = "";
  let lastLyric = "";
  let lastArt: string | null = null;

  const paintProgress = (pos: number) => {
    const m = State.media;
    const duration = m?.durationSecs ?? 0;
    // Two decimals of a percent: any finer and the transform string changes
    // every frame, which is the churn that reads as lag.
    const pct = Math.round(progressOf(pos, duration) * 1000) / 10;
    if (!dragging && pct !== lastPct) {
      lastPct = pct;
      barFill.style.transform = `scaleX(${pct / 100})`;
      barKnob.style.left = `${pct}%`;
    }
    const label = fmtTime(pos);
    if (!dragging && label !== lastCur) {
      lastCur = label;
      timeCur.textContent = label;
    }
    timeEnd.textContent = duration > 0 ? fmtTime(duration) : "";

    const lines = State.lyricLines;
    if (lines?.length) {
      const i = lyricIndexAt(lines, pos * 1000);
      const now = i >= 0 ? lines[i].text : "♪";
      const key = `${i} ${now}`;
      if (key !== lastLyric) {
        lastLyric = key;
        lyricNow.textContent = now;
        lyricPrev.textContent = i > 0 ? lines[i - 1].text : "";
        lyricNext.textContent = i >= 0 && i + 1 < lines.length ? lines[i + 1].text : "";
        lyrics.classList.toggle("singed", true);
      }
    } else if (lastLyric !== "none") {
      lastLyric = "none";
      lyricNow.textContent = State.lyricNote ?? "";
      lyricPrev.textContent = "";
      lyricNext.textContent = "";
      lyrics.classList.toggle("singed", false);
    }
  };

  const paint = () => {
    const m = State.media;
    lastPct = -1;
    lastCur = "";
    lastLyric = "";

    if (!m || !m.active) {
      panel.classList.add("empty");
      panel.classList.toggle("playing", false);
      title.textContent = State.settings.mediaEnabled ? "Nothing playing." : "Now playing is off.";
      artist.textContent = State.settings.mediaEnabled
        ? "Play something in Brave and it shows up here."
        : "Turn it on in Settings to see your music here.";
      artWrap.classList.remove("has-art");
      art.removeAttribute("src");
      moodChip.textContent = "";
      moodChip.style.display = "none";
      transportRow.style.visibility = "hidden";
      for (const b of [btnPrev, btnPlay, btnNext]) b.setAttribute("disabled", "");
      bar.classList.add("disabled");
      lyrics.style.display = "none";
      lastArt = null;
      paintProgress(0);
      return;
    }

    panel.classList.remove("empty");
    lyrics.style.display = "";
    transportRow.style.visibility = "";
    bar.classList.toggle("disabled", !m.canSeek || !(m.durationSecs > 0));

    title.textContent = m.title || "Unknown title";
    artist.textContent = m.artist || m.album || "Unknown artist";

    if (m.art && m.art !== lastArt) {
      lastArt = m.art;
      art.src = m.art;
      artWrap.classList.add("has-art");
    } else if (!m.art && lastArt !== null) {
      lastArt = null;
      art.removeAttribute("src");
      artWrap.classList.remove("has-art");
    }
    applyPalette();

    const label = MOOD_LABEL[m.mood] ?? "";
    moodChip.textContent = label;
    moodChip.style.display = label ? "" : "none";

    panel.classList.toggle("playing", m.playing);
    clear(btnPlay);
    btnPlay.append(svg(ICONS[m.playing ? "pause" : "play"], 20));
    btnPlay.toggleAttribute("disabled", m.playing ? !m.canPause : !m.canPlay);
    btnPrev.toggleAttribute("disabled", !m.canPrev);
    btnNext.toggleAttribute("disabled", !m.canNext);

    paintProgress(positionNow());
  };

  return {
    el,
    sync: paint,
    tick() {
      // Every frame while the view is open. `paintProgress` writes only what
      // actually changed, so this is three cheap DOM touches, not a rebuild.
      if (State.view === "music") paintProgress(positionNow());
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
  void loadAccent(snap);
  State.notify();
}

/**
 * Colours for the current cover, sampled once per track.
 *
 * Done here rather than in the view so the compact bar can glow in the album's
 * colour without the music view ever being opened, and so the view does not
 * re-sample every time it is rebuilt.
 */
let accentKey: string | null = null;

async function loadAccent(snap: MediaSnapshot | null): Promise<void> {
  const art = snap?.active ? snap.art : null;
  const key = art ?? "";
  if (key === accentKey) return;
  accentKey = key;
  if (!art) {
    State.mediaAccent = null;
    State.notify();
    return;
  }
  const palette = await loadPalette(art);
  // A newer track may have landed while the cover decoded.
  if (accentKey !== key) return;
  State.mediaAccent = palette;
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
