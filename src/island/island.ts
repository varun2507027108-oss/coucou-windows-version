// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State, HOOK_PILL_IDS, type AgentTask } from "../core/state";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { openActionFor } from "../views/integrations";
import { refreshClipboard, refreshShelf } from "../library/views";
import { refreshMedia, MOOD_BOUNCE, MOOD_EMOTE } from "../library/music";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";
import { clearApprovalTimer } from "../agents/hooks";

const BOT_OVERHANG = 40;

/**
 * Frame budget once nothing is actually moving: 20 fps.
 *
 * Mochi's idle loops are all slow — a breath cycle is seconds long — so 20 fps
 * is indistinguishable from 60 while the springs are settled, and it is a third
 * of the canvas work. Anything in motion (transitions, the drop choreography, the
 * greeting, a cursor that moved in the last 250 ms) drops back to vsync.
 */
/** The clickable rows of the view on screen, in visual order. */
function listItems(root: HTMLElement): HTMLElement[] {
  const view = root.querySelector<HTMLElement>("#views > .view.on");
  if (!view) return [];
  return Array.from(view.querySelectorAll<HTMLElement>(".list-row"));
}

const IDLE_FRAME_MS = 50;

// A 2×2 grid of 13 px bots in the compact bar.
const COMPACT_GRID_SLOTS = 4;

/**
 * Which pills get a mini Mochi in the compact slots.
 *
 * The three agent harnesses (Claude Code, OpenCode, Antigravity) always show:
 * they are the ones the user installed hooks for, so "which agents do I have
 * wired up" is a standing question and the compact bar is the only thing on
 * screen to answer it. Hiding them left the bar looking broken — Mochi alone,
 * with no sign the agents were even there.
 *
 * Everything else has to earn a slot: a badge (approval / error / finished) or a
 * non-idle state. Showing idle integration pills too turned the bar into a row of
 * loose blobs floating over whatever app sits at the top of the screen.
 */
function attentionMiniBots(
  tasks: AgentTask[],
  focusedId: string | null,
  slots: number,
): AgentTask[] {
  const isAgent = (t: AgentTask): boolean => HOOK_PILL_IDS.includes(t.id);
  const needsAttention = (t: AgentTask): boolean =>
    isAgent(t) || t.pillBadge != null || t.state !== "idle";
  const weight = (t: AgentTask): number => {
    if (t.pillBadge === "approval") return 0;
    if (t.pillBadge === "error") return 1;
    if (t.pillBadge === "finished") return 2;
    if (isAgent(t)) return 3;
    return 4;
  };
  const ranked = tasks
    .filter(needsAttention)
    .sort((a, b) => weight(a) - weight(b) || a.id.localeCompare(b.id));

  // The focused pill is represented by Mochi itself in the compact bar, so it is
  // dropped — but only when there are enough other pills to fill the grid.
  const withoutFocused = ranked.filter((t) => t.id !== focusedId);
  const pool = withoutFocused.length >= slots ? withoutFocused : ranked;
  const result = pool.slice(0, slots);

  // If there aren't enough attention-demanding items, backfill from other tasks
  // (e.g. idle integrations) so all 4 slots in the 2x2 grid are filled.
  if (result.length < slots) {
    const chosenIds = new Set(result.map((t) => t.id));
    if (focusedId) chosenIds.add(focusedId);
    for (const t of tasks) {
      if (!chosenIds.has(t.id)) {
        result.push(t);
        chosenIds.add(t.id);
        if (result.length >= slots) break;
      }
    }
    // If still unfilled, allow the focused task as a last resort
    if (result.length < slots && focusedId) {
      const focusedTask = tasks.find((t) => t.id === focusedId);
      if (focusedTask && !result.some((t) => t.id === focusedId)) {
        result.push(focusedTask);
      }
    }
  }

  return result;
}
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private compactTrack!: HTMLElement;
  private compactTrackFill: HTMLElement | null = null;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  /** When the cursor last moved, and when the last frame actually drew. */
  private cursorHotAt = 0;
  private lastDrawAt = 0;
  private dirty = true;
  private canvasPx = 0;
  /** Cached glow state: writing `background` re-parses a gradient string, so
   *  it is only rewritten when the colour or the size actually changes. */
  private glowKey = "";
  /** Last written canvas position, so a settled Mochi writes no styles. */
  private botLeft = Number.NaN;
  private botTop = Number.NaN;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Highlighted row in the list views, -1 for none. */
  private rowCursor = -1;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    // The app opens hidden, and `setMode` returns early when nothing changed,
    // so the idle class has to be applied here or the island would start life
    // with its animations running.
    this.applyIdleClass();
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
      },
      openTerminal: () => {
        // Was `openInVSCode` for every pill, so "Open terminal" launched Visual
        // Studio Code even for a Stripe or Cal.com card. The resolver knows what
        // each pill actually opens.
        openActionFor(State.focusTask)?.run();
      },
      // The ↗ button — same resolver, so it can never be a dead button.
      openTarget: () => {
        openActionFor(State.focusTask)?.run();
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        State.pendingApproval = null;
        State.isPinned = false;
        this.fsm.pinned = false;
        clearApprovalTimer();
        // Reset the pill that actually asked. Hardcoding Claude left the
        // OpenCode/Antigravity pill stuck in "approval" with its badge for good,
        // and lit Claude up for a request it never made.
        State.updateTask(req.taskId, "working");
        State.setPillBadge(req.taskId, null);
        this.setView(State.defaultView());
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => {
        if (State.mode === "expanded") this.collapse();
        void Bridge.openSettingsWindow();
      },
      setLibraryPref: (key) => {
        const s = State.settings;
        s[key] = !s[key];
        void Bridge.saveSettings(s);
        // Turning a feature off must take its rows away immediately, not on the
        // next open of the view.
        if (key === "clipboardEnabled" && !s.clipboardEnabled) {
          State.clipboard = [];
          State.clipboardImage = false;
        }
        if (key === "shelfEnabled" && !s.shelfEnabled) {
          State.shelf = [];
        }
        if (key === "clipboardEnabled" && s.clipboardEnabled) {
          // Leave the settings view rather than sitting on a stale empty list.
          this.setView("clipboard");
          return;
        }
        if (key === "shelfEnabled" && s.shelfEnabled) {
          this.setView("shelf");
          return;
        }
        State.notify();
      },
      setClipboardRetention: (minutes) => {
        State.settings.clipboardRetentionMinutes = minutes;
        void Bridge.saveSettings(State.settings);
        State.notify();
        void this.refreshLibraryView();
      },
      blip: () => Sound.play("blip"),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.compactTrack = h("div", { id: "compact-track" },
      h("div", { class: "compact-track-text" },
        h("div", { class: "compact-track-title" }),
        h("div", { class: "compact-track-artist" })),
      h("div", { class: "compact-track-bar" }, h("div", { class: "compact-track-fill" })));
    this.compactTrackFill = this.compactTrack.querySelector(".compact-track-fill");
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(
      actions,
      () => this.animateGeometry(false),
      // A clipboard or shelf action changes a list; the open view re-reads it.
      () => void this.refreshLibraryView(),
    );
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.setView(State.defaultView()),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.compactTrack,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  /**
   * Turns every CSS animation and transition off while the island is closed.
   *
   * The views stay in the DOM so they can cross-fade, so their `infinite`
   * keyframes — the overview ticker's shimmer among them — would keep the
   * WebView2 renderer repainting at 60 Hz behind a hidden window. One class on
   * the root switches them all off (see `.is-idle` in style.css).
   */
  private applyIdleClass(): void {
    this.root.classList.toggle("is-idle", State.mode === "hidden");
  }

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    this.applyIdleClass();
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    // Kill every CSS animation and transition while closed. The views stay in
    // the DOM (they cross-fade via opacity), so their `infinite` keyframes would
    // otherwise keep the renderer painting at 60 Hz behind a hidden island.
    this.root.classList.toggle("is-idle", mode === "hidden");
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

expand(view: IslandViewName) {
   this.stopSequenceIfLeaving(view);
   // Tell the FSM the app did this. Without it the FSM still believed the island
   // was hidden, so the next hover collapsed a panel the user was reading — the
   // Windows half of upstream 3186879 (`openedExternally`).
   this.fsm.openedExternally();
   State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      void this.refreshLibraryView();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
    void this.refreshLibraryView();
  }

  /**
   * Re-reads whichever list is on screen. The clipboard and shelf views are fed
   * by Rust rather than polled, so this is the only place a list gets loaded —
   * opening the view is the moment the data is actually needed.
   */
  private async refreshLibraryView() {
    if (State.view === "clipboard") {
      await refreshClipboard();
      return;
    }
    if (State.view === "shelf") {
      await refreshShelf();
      return;
    }
    if (State.view === "music") {
      await refreshMedia();
    }
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Keep the FSM in step with what is on screen (home/coucou → petit now).
    this.fsm.collapse();
    this.setMode("compact");
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /**
   * Called by the global hotkey. Opens the island whether it is hidden, compact,
   * or stuck mid-greeting: without forcing the FSM first, a press while the FSM
   * still thought the island was hidden would be swallowed and the key would look
   * dead.
   */
  summon() {
    this.rowCursor = -1;
    if (State.mode === "expanded") return;
    this.fsm.forceHome();
    this.expand(State.defaultView());
    Sound.play("open");
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    // With the shelf on, a drop is shelved instead of being swept after a week —
    // and the shelf is where the user expects to find it afterwards.
    const shelved = State.settings.shelfEnabled;
    const ingest = shelved ? Bridge.shelfAdd(path) : Bridge.ingestFile(path);

    ingest
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        // A shelved file belongs on the shelf, not the inbox, so the list has to
        // pick it up — otherwise the row only appears after the view is reopened.
        if (shelved) void refreshShelf();
        State.notify();
      })
      .catch((err) => {
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Mochi has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private isSplitActive(): boolean {
    const focus = State.focusTask;
    return Boolean(
      State.mode === "expanded" &&
      State.view === "overview" &&
      State.splitView &&
      !!focus &&
      HOOK_PILL_IDS.includes(focus.id as any) &&
      (focus.state !== "idle" || focus.steps.length > 0 || (focus.diffLines && focus.diffLines.length > 0))
    );
  }

  private targetSize(): { w: number; h: number; r: number } {
    const isSplit = this.isSplitActive();
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length, isSplit);
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
// Centred on the pill's vertical middle (29 px height of the 2x2 grid).
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${(hh - 29) / 2}px`;
    // The gap between Mochi and the mini grid used to be ~200 px of nothing.
    // It is now the track, so the compact bar says what is playing instead of
    // being a blank strip you have to open to understand.
    const trackLeft = 62;
    const trackRight = w - 40 - 29 - 8;
    this.compactTrack.style.left = `${trackLeft}px`;
    this.compactTrack.style.width = `${Math.max(0, trackRight - trackLeft)}px`;
    this.compactTrack.style.top = `${(hh - 20) / 2}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      // No `State.mode` guard: the strip is the only OS-hit surface while the
      // island is hidden, but the window is also parked there while *expanded*,
      // and the FSM is what decides what a hover means. Gating on the mode meant
      // that once the FSM and the mode disagreed — which they do whenever the app
      // hides the island by itself — the hover was swallowed and the island could
      // never be woken or opened again.
      this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      // Only the chat has a field to type in. Clicking anything else has to hand
      // the keyboard straight back to the app underneath — otherwise the island
      // keeps the caret and the user's own shortcuts (Ctrl+Shift+S for a screen
      // capture being the obvious one) go to Coucou instead of their editor.
      if (State.view !== "prompt") {
        void Bridge.focusWindow(false);
      }
      // Driven by the FSM, not by `State.mode`. The two can disagree — the app
      // hides the island on its own without telling the FSM — and keying off the
      // mode left the island expanded on screen that nothing could open or close.
      if (this.fsm.state !== "home") {
        this.fsm.click();
        // `fsm.click()` only acts from `petit`/`hidden`; from `coucou` it is a
        // no-op, and the greeting would keep the island stuck open.
        if (this.fsm.state === "coucou") this.expand(State.defaultView());
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });

    // Arrow keys walk the rows of whatever list is on screen, Enter takes the
    // highlighted one and Escape steps back out. The list views used to need a
    // mouse for everything, which is the wrong shape for something that lives on
    // top of the screen.
    window.addEventListener("keydown", (e) => {
      if (State.mode !== "expanded") return;
      const view = State.view;
      if (view !== "clipboard" && view !== "shelf" && view !== "review") return;
      const items = listItems(this.root);
      if (!items.length) return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        this.rowCursor = (this.rowCursor + delta + items.length) % items.length;
        this.paintRowCursor(items);
      } else if (e.key === "Enter" && this.rowCursor >= 0) {
        e.preventDefault();
        (items[this.rowCursor] as HTMLElement).click();
      } else if (e.key === "Escape") {
        this.rowCursor = -1;
        this.paintRowCursor(items);
      }
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
if (!IS_TAURI) {
      window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    }
  }

  private paintRowCursor(items: HTMLElement[]) {
    items.forEach((row, i) => row.classList.toggle("cursor", i === this.rowCursor));
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    // AppState can hide the island by itself (last task ended): keep the FSM in step.
    if (State.mode === "hidden" && this.fsm.state === "petit") {
      this.fsm.hiddenExternally();
    }

    const prev = State.mouse;
    // Anything that moves the cursor keeps the island at full frame rate: the
    // eyes track it, and 60 Hz is the difference between "following you" and
    // "sliding". This is the only thing that earns the full budget.
    if (x !== prev.x || y !== prev.y) this.cursorHotAt = performance.now();
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    // Never make the caller wait for the first frame: `lastDrawAt` is stale by
    // however long the loop was parked.
    this.lastDrawAt = 0;
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    // Frame budget. `requestAnimationFrame` still fires on every vsync; this
    // decides how often we actually spend the frame drawing.
    //
    // Everything Mochi does is a slow organic loop — breathing, blinking, a
    // hover bob, the search sweep — so once the springs have settled and the
    // cursor has stopped, redrawing at 60 Hz is work nobody can see. Measured on
    // this machine the island cost ~50 % of a core while animating at 60 Hz;
    // the settled case is now bounded well below that and looks identical.
    // Transitions, the drop choreography, the greeting and a moving cursor all
    const viewAnimating = !!this.views?.get(State.view)?.animating;
    const moving =
      this.width.animating || this.height.animating || this.radius.animating ||
      !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
      (State.mode === "expanded" && State.view === "greeting") ||
      UploadSeq.isActive ||
      viewAnimating ||
      // A playing track has to keep the bar's progress moving even if Mochi has
      // settled, otherwise the line in the compact bar jumps every snapshot.
      (State.mode === "compact" && !!State.media?.playing) ||
      nowMs - this.cursorHotAt < 250;
    const budget = moving ? 0 : IDLE_FRAME_MS;
    if (budget > 0 && nowMs - this.lastDrawAt < budget) {
      requestAnimationFrame(this.frame);
      return;
    }
    this.lastDrawAt = nowMs;

    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);
    this.updateCompactTrackProgress();

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive || viewAnimating;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const isSplit = this.isSplitActive();
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress, isSplit);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap.
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) {
      // These six writes ran every single frame. Setting `background` to a
      // fresh `radial-gradient(...)` string forces a style re-parse and layout
      // each time, and while the island is expanded the frame loop never parks
      // (Mochi is always breathing) — so that was 60 style recalculations a
      // second for a glow that only changes when the state or the size does.
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      const size = Math.round(d * 2.2 * 100) / 100;
      if (
        this.botGlow.style.display !== "block" ||
        this.glowKey !== `${color}|${size}|${d}`
      ) {
        this.glowKey = `${color}|${size}|${d}`;
        this.botGlow.style.display = "block";
        this.botGlow.style.width = `${size}px`;
        this.botGlow.style.height = `${size}px`;
        this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
        this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
        this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
        this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
      } else {
        // The position still tracks the springs every frame, and those are plain
        // numbers — cheap, and unlike `background` they do not re-parse a value.
        this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
        this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      }
    } else {
      this.botGlow.style.display = "none";
      this.glowKey = "";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    // A 1 px position change is invisible and the springs settle on sub-pixel
    // values, so quantising avoids a style write per frame once Mochi is still.
    const left = Math.round(this.botCx.value - w / 2);
    const top = Math.round(this.botCy.value - BOT_OVERHANG / 2 - hCss / 2);
    if (left !== this.botLeft || top !== this.botTop) {
      this.botLeft = left;
      this.botTop = top;
      this.botCanvas.style.left = `${left}px`;
      this.botCanvas.style.top = `${top}px`;
    }
    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    this.engine.bodyColor = focus?.isIntegration ? hexToRGB(focus.color) : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    const target = this.targetSize();
    if (Math.abs(target.h - this.height.target) > 0.5) {
      this.animateGeometry(false);
    }
    if (this.views.get(State.view)?.animating) {
      this.ensureRunning();
    }

    // The chat is the only view with a text field, so it is the only time the
    // island is allowed to take keyboard focus. Everywhere else the caret is
    // pushed back to the app underneath, because an island that keeps the keyboard
    // steals the user's own shortcuts while it is merely open.
    if (this.lastSyncedView !== State.view) {
      this.lastSyncedView = State.view;
      if (State.view === "prompt") {
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else {
        // Not gated on `wasChat`: the window can hold focus for reasons other than
        // the chat ever having been on screen, and leaving the caret parked in the
        // island is exactly what breaks Ctrl+Shift+S and friends.
        void Bridge.focusWindow(false);
      }
    }

    // Compact mini grid — a fixed 2×2 of 13 px bots, so at most four.
    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    // All tasks, not `otherTasks`: the focused pill only drops out of the grid when
    // there are enough others to fill it, so every harness you have installed is
    // represented.
    const others = showGrid
      ? attentionMiniBots(State.tasks, State.focusId, COMPACT_GRID_SLOTS)
      : [];
    const key = others.map((t) => t.id).join("|");
    if (this.miniGrid.dataset.key !== key) {
      this.miniGrid.dataset.key = key;
      this.miniGrid.replaceChildren();
      for (const t of others) {
        this.miniGrid.append(createMiniBot(t, 13));
      }
      // Also runs when the grid empties: only opacity changed on leaving
      // compact, so the canvases stayed connected and `pruneMiniBots` (which
      // reclaims disconnected ones) never got a chance to run. Every hidden bot
      // kept animating and drawing for the rest of the session.
      pruneMiniBots();
    }

    syncMiniBotStates(State.tasks);
    this.syncCompactTrack();
    this.engine.setState(State.effectiveState);
    this.syncMusicMood();
  }

  /**
   * Fills the dead space in the compact bar with what is playing.
   *
   * Only in compact mode and only when the mini grid has nothing to say: agent
   * pills outrank a song title, because an agent asking for something is the one
   * thing on that bar the user must not miss. The text is the track, tinted from
   * the same cover colours the music view glows with, with a hairline progress
   * bar so a glance also answers "how far in are we".
   */
  private syncCompactTrack() {
    const m = State.media;
    const accent = State.mediaAccent;
    // Agents first: while any pill is live the grid is the message.
    const gridBusy = State.mode === "compact" && this.miniGrid.childElementCount > 0;
    const show = State.mode === "compact" && !!m?.active && !gridBusy;
    this.compactTrack.style.opacity = show ? "1" : "0";
    if (!show || !m) return;

    if (accent) {
      this.compactTrack.style.setProperty("--amb-base", accent.base);
      this.compactTrack.style.setProperty("--amb-light", accent.light);
    }
    this.compactTrack.classList.toggle("playing", m.playing);

    const title = this.compactTrack.querySelector<HTMLElement>(".compact-track-title")!;
    const artist = this.compactTrack.querySelector<HTMLElement>(".compact-track-artist")!;
    const fill = this.compactTrack.querySelector<HTMLElement>(".compact-track-fill")!;
    const nextTitle = m.title || "Unknown title";
    if (title.textContent !== nextTitle) title.textContent = nextTitle;
    const nextArtist = m.artist || m.album || "";
    if (artist.textContent !== nextArtist) artist.textContent = nextArtist;

    const elapsed = m.playing ? (performance.now() - State.mediaAtWallMs) / 1000 : 0;
    const pos = m.positionSecs + Math.max(0, elapsed);
    const pct = m.durationSecs > 0 ? Math.min(100, (pos / m.durationSecs) * 100) : 0;
    fill.style.transform = `scaleX(${pct / 100})`;
  }

  /**
   * The hairline progress in the compact bar, advanced per frame rather than per
   * snapshot. One transform write on one node, and skipped entirely when the bar
   * is not showing.
   */
  private updateCompactTrackProgress() {
    if (this.compactTrack.style.opacity === "0") return;
    const m = State.media;
    if (!m?.active) return;
    const fill = this.compactTrackFill;
    if (!fill) return;
    const elapsed = m.playing ? (performance.now() - State.mediaAtWallMs) / 1000 : 0;
    const pos = m.positionSecs + Math.max(0, elapsed);
    const pct = m.durationSecs > 0 ? Math.min(100, (pos / m.durationSecs) * 100) : 0;
    fill.style.transform = `scaleX(${pct / 100})`;
  }

  /**
   * Mochi bops to the music. Emote and bounce follow the song mood while
   * something plays; both release when it stops. Keyed on the track so a new
   * song re-triggers the face instead of leaving the old one stuck.
   */
  private lastMusicKey: string | null = null;

  private syncMusicMood() {
    const m = State.settings.mediaEnabled ? State.media : null;
    const live = m && m.active && m.playing;
    this.engine.musicBounceTarget = live ? (MOOD_BOUNCE[m.mood] ?? 0.5) : 0;
    const key = live ? `${m.title}\x00${m.artist}\x00${m.mood}` : null;
    if (key === this.lastMusicKey) return;
    this.lastMusicKey = key;
    // setPermanentEmote is ours to own here: minibots use their own engines,
    // and every other island flow uses the temporary triggerEmote, which keeps
    // overriding on top and falls back to this when it expires.
    this.engine.setPermanentEmote(live ? (MOOD_EMOTE[m.mood] ?? null) : null);
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
