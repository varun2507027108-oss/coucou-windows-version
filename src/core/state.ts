// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { ClipEntry, MediaSnapshot, ShelfItem } from "./bridge";
import type { EyeShape } from "../mochi/engine";

export type AgentSource = "claudeCode" | "opencode" | "antigravity" | "n8n" | "agent";

/** Human label for a pill source. One place, so views never drift. */
export function sourceLabel(source: AgentSource): string {
  switch (source) {
    case "claudeCode": return "Claude Code";
    case "opencode": return "OpenCode";
    case "antigravity": return "Antigravity";
    case "n8n": return "n8n";
    // A third-party agent's own name is the label; this is only the fallback.
    case "agent": return "Agent";
  }
}

/** Pills driven by agent hooks rather than integration pollers. */
export const HOOK_PILL_IDS = [
  "integration_claude",
  "integration_opencode",
  "integration_antigravity",
];

/**
 * How many integration pills may sit next to the three agent pills. 3 + 4 = 7
 * tasks is exactly what the overview's right card holds (six others beside the
 * focused one), so this is the cap that keeps every pill clickable.
 */
export const MAX_ACTIVE_INTEGRATIONS = 4;
export type PillBadge = "approval" | "finished" | "error";

export interface StepChecklistItem {
  id?: string;
  label: string;
  icon?: "check" | "circle" | "terminal" | "spinner" | string;
  kind?: string;
  status: "done" | "active" | "pending";
}

export interface DiffLine {
  num?: number | string;
  type: "context" | "del" | "add" | "normal";
  text?: string;
  content?: string;
}

export interface ActiveFileInfo {
  name: string;
  path: string;
  ext?: string;
  badge?: string;
}

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  checklist?: StepChecklistItem[];
  activeFile?: ActiveFileInfo | null;
  diffLines?: DiffLine[];
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  /** Which pill asked. The card and the Allow/Deny buttons must attribute the
   *  request to this agent, not to whichever pill happens to be focused. */
  taskId: string;
  tool: string;
  command: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_opencode", "OpenCode", "#1F2937", "opencode"),
  task("integration_antigravity", "Antigravity", "#4285F4", "antigravity"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
  /** Clipboard history. Off until the user asks for it — recording a clipboard
   *  before anyone opted in is a surprise, not a feature. */
  clipboardEnabled: boolean;
  /** Minutes an entry is kept. 0 = until the cap evicts it. */
  clipboardRetentionMinutes: number;
  clipboardMaxEntries: number;
  /** Best-effort: never record a string shaped like a credential. */
  clipboardSkipSecrets: boolean;
  /** Keep dropped files on the shelf. */
  shelfEnabled: boolean;
  /** Now-playing from the OS media session. Off until turned on, like clipboard. */
  mediaEnabled: boolean;
  /** Lyrics from lrclib.net. Separate toggle: the only part that uses network. */
  mediaLyrics: boolean;
  /** Spotify client ID for the optional link. Public identifier, not a secret. */
  spotifyClientId: string;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-sonnet-4-6",
  clipboardEnabled: false,
  clipboardRetentionMinutes: 60,
  clipboardMaxEntries: 100,
  clipboardSkipSecrets: true,
  shelfEnabled: false,
  mediaEnabled: false,
  mediaLyrics: false,
  spotifyClientId: "",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;
  splitView = true;

  toggleSplitView() {
    this.splitView = !this.splitView;
    this.notify();
  }

  clearTaskSession(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps = [];
    t.stepIndex = 0;
    t.checklist = undefined;
    t.activeFile = null;
    t.diffLines = undefined;
    t.pillBadge = null;
    this.notify();
  }

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  // ── Clipboard history and file shelf ──────────────────────────────────────
  // Both are owned by Rust and only mirrored here for rendering. The island
  // never holds clipboard text of its own accord: it reads the list when the
  // view opens and when Rust says a row landed.
  clipboard: ClipEntry[] = [];
  /** The clipboard holds a bitmap, so a capture has no text to keep. */
  clipboardImage = false;
  shelf: ShelfItem[] = [];

  // ── Now playing ─────────────────────────────────────────────────────────
  // Owned by Rust (OS media session), mirrored here. `atWallMs` anchors the
  // progress bar: position advances locally between snapshots.
  media: MediaSnapshot | null = null;
  mediaAtWallMs = 0;
  /** Synced lyric lines for the current track, or null when none loaded. */
  lyricLines: { atMs: number; text: string }[] | null = null;
  /** Shown instead of lyrics when the lookup fails, is offline, or is off. */
  lyricNote: string | null = null;

  /** Whether an Anthropic key exists in the Credential Manager. The island can
   *  only ask "is it there", never read it. */
  hasApiKey = false;

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  /**
   * Creates a pill for a third-party agent the first time it speaks up.
   *
   * Inserted straight after `integration_claude`, not appended: the overview only
   * shows the first handful of pills, so an appended one landed outside the
   * visible slice and the agent looked like it had never connected. Upstream
   * `341b86a`.
   */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id,
      name,
      color,
      state: "idle",
      stepIndex: 0,
      steps: [],
      source: "agent",
      isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  /** Drops a pill and repairs the focus if it pointed at the one going away. */
  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? null;
    this.notify();
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    const clean = step.trim();
    if (!clean) return;
    if (t.steps.length > 0 && t.steps[t.steps.length - 1] === clean) return;
    t.steps.push(clean);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — hook pills always on, pollers opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        HOOK_PILL_IDS.includes(proto.id) || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Keep the declared order so pills never shuffle, except that `agent_*` pills
    // come first: the overview only has room for a handful, and a third-party
    // agent appended behind four integrations was never actually visible. Mirrors
    // the Mac layout. Upstream `f612110`.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      const aAgent = a.id.startsWith("agent_");
      const bAgent = b.id.startsWith("agent_");
      if (aAgent && !bAgent) return -1;
      if (bAgent && !aAgent) return 1;
      // Insertion order among themselves, so pills do not shuffle.
      if (aAgent && bAgent) return 0;
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    // Repair the focus whenever it points at a task that is gone — disabling
    // the focused pill in the settings window used to leave focusId dangling,
    // which silently turned off every "is this agent focused?" check.
    if (!this.tasks.some((t) => t.id === this.focusId)) {
      this.focusId = this.tasks[0]?.id ?? null;
    }
    this.notify();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
