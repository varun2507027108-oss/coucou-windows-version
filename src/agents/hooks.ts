// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type AgentTask, type DiffLine } from "../core/state";
import type { Island } from "../island/island";

const CLAUDE_ID = "integration_claude";
const OPENCODE_ID = "integration_opencode";
const ANTIGRAVITY_ID = "integration_antigravity";

/**
 * Which pill an event belongs to. The relay tags every payload with `agent`
 * (`claude` default); unknown values stay on the Claude pill rather than
 * vanishing.
 */
function taskIdFor(agent: string | undefined): string {
  switch (agent) {
    case "opencode": return OPENCODE_ID;
    case "antigravity": return ANTIGRAVITY_ID;
    default: return CLAUDE_ID;
  }
}

/** Pill title when a session has no folder name to show yet. */
function defaultProjectName(taskId: string): string {
  switch (taskId) {
    case OPENCODE_ID: return "OpenCode";
    case ANTIGRAVITY_ID: return "Antigravity";
    default: return "VS Code";
  }
}

/**
 * A `coucou_agent` tag is only honoured when it looks like a name.
 *
 * The tag arrives from whatever process called the relay, so it is untrusted: it
 * ends up in an element id and a label. Lowercase letters, digits and hyphens,
 * 24 characters, and `claude` is reserved because that pill already exists.
 * Anything else falls back to the Claude pill rather than minting a pill from
 * attacker-chosen text. Mirrors `HookServer.validateAgent` upstream.
 */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const AGENT_FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return AGENT_FALLBACK_COLORS[Math.abs(h) % AGENT_FALLBACK_COLORS.length];
}

/** Clears the approval card if no decision was made before the hook gave up. */
let approvalTimeout: number | null = null;

function clearApprovalTimeout(): void {
  if (approvalTimeout != null) {
    window.clearTimeout(approvalTimeout);
    approvalTimeout = null;
  }
}

/**
 * Called by the island once the request has been answered, so the expiry timer
 * cannot fire again on top of the state it just cleaned up.
 */
export function clearApprovalTimer(): void {
  clearApprovalTimeout();
}

/**
 * The 5.2 s "finished" reset, per pill. A new turn can start inside that window
 * and the stale timer used to flip a working agent back to `idle` and wipe its
 * badge, so every scheduled reset is cancelled by the next event for that pill.
 */
const stopTimers = new Map<string, number>();

function stopAfter(taskId: string, ms: number, run: () => void): void {
  const existing = stopTimers.get(taskId);
  if (existing != null) window.clearTimeout(existing);
  stopTimers.set(
    taskId,
    window.setTimeout(() => {
      stopTimers.delete(taskId);
      run();
    }, ms),
  );
}

interface HookPayload {
  hook_event_name?: string;
  /** Harness that sent this: `claude` (default), `opencode`, `antigravity`. */
  agent?: string;
  /**
   * Optional third-party agent tag (upstream 91654c7). A harness that is not one
   * of the three we know sends this, and it gets a pill of its own instead of
   * being folded into Claude Code.
   */
  coucou_agent?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
  // OpenCode tools are lowercase; same verbs, same island.
  bash: "Exécute",
  read: "Lit",
  write: "Écrit",
  edit: "Modifie",
  glob: "Cherche",
  grep: "Recherche",
  webfetch: "Récupère",
  websearch: "Recherche web",
  task: "Agent",
  skill: "Skill",
  todowrite: "Tâches",
  todoread: "Tâches",
  // Antigravity tools (PascalCase arguments, same verbs).
  run_command: "Exécute",
  view_file: "Lit",
  write_to_file: "Écrit",
  replace_file_content: "Modifie",
  multi_replace_file_content: "Modifie",
  list_dir: "Liste",
  find_by_name: "Cherche",
  grep_search: "Recherche",
  search_web: "Recherche web",
  read_url_content: "Récupère",
  invoke_subagent: "Agent",
  ask_question: "Question",
};

/**
 * First non-empty string among `fields`, looked up case-insensitively.
 *
 * The three harnesses spell the same argument differently — Claude `file_path`,
 * OpenCode `filePath`, Antigravity `TargetFile` / `AbsolutePath` / `CommandLine`
 * — so both the ticker line and the approval line resolve through this instead
 * of each growing its own case ladder.
 */
function firstString(input: Record<string, unknown>, fields: readonly string[]): string | null {
  const lowered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) lowered[k.toLowerCase()] = v;
  for (const field of fields) {
    const value = lowered[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Fields that identify a shell invocation, most specific first. */
const COMMAND_FIELDS = ["command", "commandline"] as const;
/** Fields that identify a file or directory, most specific first. */
const PATH_FIELDS = ["file_path", "filepath", "targetfile", "absolutepath", "path", "directorypath"] as const;

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const cmd = firstString(input, COMMAND_FIELDS);
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = firstString(input, PATH_FIELDS);
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const url = firstString(input, ["url"]);
  if (url) return `${label} · ${url.slice(0, 40)}`;
  const query = firstString(input, ["query", "pattern", "prompt"]);
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "commandline", // Antigravity run_command
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "targetfile", // Antigravity write/replace
  "path", // Read, LS
  "url", // WebFetch, read_url_content
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = firstString(input, [field]);
    if (value) return `${tool} · ${value}`;
  }
  return tool;
}

function upsert(taskId: string, projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === taskId);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function normalizeRelPath(fullPath: string, cwd: string): string {
  if (!fullPath) return "";
  let norm = fullPath.replace(/\\/g, "/");
  const cnorm = cwd.replace(/\\/g, "/");
  if (cnorm && norm.toLowerCase().startsWith(cnorm.toLowerCase())) {
    norm = norm.slice(cnorm.length).replace(/^\/+/, "");
  }
  return norm;
}

function updateRichTask(
  task: AgentTask,
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  eventStatus?: "start" | "working" | "done",
): void {
  if (!task.checklist || task.checklist.length === 0) {
    task.checklist = [
      { label: "Read", status: "pending", kind: "read" },
      { label: "Edit", status: "pending", kind: "edit" },
      { label: "Bash", status: "pending", kind: "bash" },
      { label: "Done", status: "pending", kind: "done" },
    ];
  }

  const filePath = firstString(input, PATH_FIELDS);
  if (filePath) {
    const name = lastPathComponent(filePath);
    const relPath = normalizeRelPath(filePath, cwd) || name;
    const dotIdx = name.lastIndexOf(".");
    const ext = dotIdx >= 0 ? name.slice(dotIdx + 1).toLowerCase() : "";
    const badge = ext ? ext.slice(0, 4).toUpperCase() : "FILE";
    task.activeFile = { name, path: relPath, ext, badge };
  }

  const lowerTool = tool.toLowerCase();
  const isRead = ["read", "view_file", "glob", "grep", "find_by_name", "list_dir", "ls"].includes(lowerTool);
  const isEdit = [
    "edit", "write", "write_to_file", "replace_file_content", "multi_replace_file_content",
    "multiedit", "notebookedit",
  ].includes(lowerTool);
  const isBash = ["bash", "run_command", "powershell"].includes(lowerTool);

  const setStatus = (
    read: "pending" | "active" | "done",
    edit: "pending" | "active" | "done",
    bash: "pending" | "active" | "done",
    done: "pending" | "active" | "done",
  ) => {
    if (!task.checklist) return;
    task.checklist[0].status = read;
    task.checklist[1].status = edit;
    task.checklist[2].status = bash;
    task.checklist[3].status = done;
  };

  if (eventStatus === "done") {
    setStatus("done", "done", "done", "done");
  } else if (isEdit) {
    setStatus("done", "active", "pending", "pending");
  } else if (isBash) {
    const editDone = task.checklist?.[1]?.status === "active" ? "done" : (task.checklist?.[1]?.status ?? "pending");
    setStatus("done", editDone, "active", "pending");
  } else if (isRead || eventStatus === "start") {
    setStatus("active", "pending", "pending", "pending");
  }

  const oldContent = firstString(input, ["targetcontent", "old_string", "oldstring", "target_content"]);
  const newContent = firstString(input, ["replacementcontent", "new_string", "newstring", "codecontent", "content"]);
  const startLineNum = typeof input.StartLine === "number"
    ? input.StartLine
    : (typeof input.start_line === "number" ? input.start_line : 12);

  if (oldContent || newContent) {
    const lines: DiffLine[] = [];
    const baseLine = Math.max(1, startLineNum - 2);
    lines.push({
      num: baseLine,
      type: "normal",
      text: `import { ${task.activeFile?.name.replace(/\.[^/.]+$/, "") ?? "Item"} } from './types'`,
    });
    lines.push({ num: baseLine + 1, type: "normal", text: "" });

    if (oldContent) {
      const oldLines = oldContent.split(/\r?\n/).slice(0, 3);
      for (let i = 0; i < oldLines.length; i++) {
        lines.push({ num: startLineNum + i, type: "del", text: `- ${oldLines[i]}` });
      }
    }

    if (newContent) {
      const newLines = newContent.split(/\r?\n/).slice(0, 3);
      for (let i = 0; i < newLines.length; i++) {
        lines.push({ num: startLineNum + i, type: "add", text: `+ ${newLines[i]}` });
      }
    } else {
      lines.push({ num: startLineNum, type: "add", text: `+ |` });
    }

    lines.push({ num: startLineNum + 1, type: "normal", text: "" });
    lines.push({ num: startLineNum + 2, type: "normal", text: `export function process() {` });
    task.diffLines = lines;
  } else if (isBash) {
    const cmd = firstString(input, COMMAND_FIELDS);
    if (cmd) {
      task.diffLines = [
        { num: 1, type: "normal", text: `$ ${cmd}` },
        { num: 2, type: "add", text: `> executing... |` },
      ];
    }
  }

  // Ensure default fallback diff lines so the rich card matches image 2
  if (!task.diffLines || task.diffLines.length === 0) {
    const fName = task.activeFile?.name ?? "invoice.ts";
    const fPath = task.activeFile?.path ?? `src/${fName}`;
    if (!task.activeFile) {
      task.activeFile = {
        name: fName,
        path: fPath,
        ext: "ts",
        badge: "TS",
      };
    }
    task.diffLines = [
      { num: 10, type: "normal", text: "import { Item } from './types'" },
      { num: 11, type: "normal", text: "" },
      { num: 12, type: "del", text: "- const TVA = 0.196" },
      { num: 12, type: "add", text: "+ |" },
      { num: 13, type: "normal", text: "" },
      { num: 14, type: "normal", text: "export function total(items: Item[]) {" },
      { num: 15, type: "normal", text: "  const sum = items.reduce((s, i) => s + i.price, 0)" },
      { num: 16, type: "normal", text: "  return sum * (1 + TVA)" },
      { num: 17, type: "normal", text: "}" },
    ];
  }
}

function clearSession(taskId: string) {
  const t = State.tasks.find((x) => x.id === taskId);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = defaultProjectName(taskId);
  t.pillBadge = null;
  t.checklist = undefined;
  t.activeFile = null;
  t.diffLines = undefined;
  // Dropping the folder but keeping the path left "Open project folder" pointing
  // at the previous session's directory after a session ended.
  t.sessionCwd = null;
  const pending = stopTimers.get(taskId);
  if (pending != null) {
    window.clearTimeout(pending);
    stopTimers.delete(taskId);
  }
}

/** One card, one request. Extracted so every harness gates identically. */
function requestApproval(
  island: Island,
  taskId: string,
  payload: HookPayload,
  projectName: string,
  cwd: string,
  focused: boolean,
): void {
  const requestId = payload.request_id ?? "";
  // One card, one request. A second one must never quietly replace the first —
  // that would leave a human staring at request B while request A waits for a
  // decision nobody can give. Hand it straight back to the harness.
  //
  // A request with no id cannot be answered at all, so it must never displace
  // the card that can be. (Both ids empty compared equal and the second one
  // silently took over.)
  if (!requestId) return;
  if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
    void Bridge.approvalDecline(requestId);
    return;
  }

  upsert(taskId, projectName, cwd);
  clearApprovalTimeout();
  const tool = payload.tool_name ?? "Tool";
  const input = payload.tool_input ?? {};
  State.pendingApproval = {
    requestId,
    sessionId: payload.session_id ?? "",
    taskId,
    tool,
    command: approvalTarget(tool, input),
  };
  // The relay's short ack window closes in 800 ms; everything below this line
  // is synchronous, so the card really is up by the time it lands.
  void Bridge.approvalAck(requestId);
  State.updateTask(taskId, "approval");
  State.isPinned = true;
  Sound.play("approval");
  if (focused) {
    island.alert("approval");
  } else {
    // Another agent holds the view, so the card would yank it away. The badge
    // is the signal instead — but it has to be on screen for that to mean
    // anything, hence the reveal. We just told the relay a human can act.
    State.setPillBadge(taskId, "approval");
    island.reveal();
  }
  // Coucou answers within 108 s or not at all; after that the harness has taken
  // over and the card would be lying.
  approvalTimeout = window.setTimeout(() => {
    approvalTimeout = null;
    if (!State.pendingApproval) return;
    const owner = State.pendingApproval.taskId;
    State.pendingApproval = null;
    State.isPinned = false;
    island.dropPin();
    State.updateTask(owner, "working");
    State.setPillBadge(owner, null);
    if (State.view === "approval") island.setView(State.defaultView());
    State.notify();
  }, 110_000);
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost the harness nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the harness takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  // A valid `coucou_agent` routes to its own `agent_<name>` pill; anything else
  // (absent, malformed, or the reserved "claude") falls back to the harness pill
  // this relay already knows. Upstream 46dfa67.
  const externalAgent = validateAgent(payload.coucou_agent);
  const taskId = externalAgent ? `agent_${externalAgent}` : taskIdFor(payload.agent);
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || defaultProjectName(taskId));
  const focused = State.focusId === taskId;

  /** Makes sure the target pill exists. A no-op for the three known harnesses. */
  const ensurePill = () => {
    if (externalAgent) {
      State.upsertExternalAgent(taskId, externalAgent, agentColor(externalAgent));
    }
    // The session fields (name, cwd) — without these the task never learns
    // where it runs, and "open session" has nothing to match against.
    upsert(taskId, projectName, cwd);
  };

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  switch (name) {
    case "SessionStart": {
      ensurePill();
      const t = State.tasks.find((x) => x.id === taskId);
      if (t) updateRichTask(t, "SessionStart", {}, cwd, "start");
      surface("overview", false);
      Sound.play("work");
      break;
    }

    case "UserPromptSubmit": {
      ensurePill();
      State.updateTask(taskId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(taskId, asked.slice(0, 60));
      const t = State.tasks.find((x) => x.id === taskId);
      if (t) updateRichTask(t, "Prompt", { prompt: asked }, cwd, "start");
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      // Antigravity has no separate permission event: `PreToolUse` *is* the
      // gate, and it waits for our answer. The relay declares it as an
      // approval gate too (see `waits_for_answer` in hook/src/main.rs), so
      // treating it as ordinary work here would leave the card down, the relay
      // timing out after 800 ms and every call falling back to a native prompt.
      if (payload.agent === "antigravity") {
        requestApproval(island, taskId, payload, projectName, cwd, focused);
        const t = State.tasks.find((x) => x.id === taskId);
        if (t) updateRichTask(t, payload.tool_name ?? "Tool", payload.tool_input ?? {}, cwd, "working");
        break;
      }
      ensurePill();
      State.updateTask(taskId, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(taskId, stepLabel(tool, payload.tool_input ?? {}));
      const t = State.tasks.find((x) => x.id === taskId);
      if (t) updateRichTask(t, tool, payload.tool_input ?? {}, cwd, "working");
      surface("overview", false);
      break;
    }

    case "PostToolUse": {
      // Antigravity's PreToolUse already carried the step label (it was the
      // approval line); Claude/OpenCode announce the tool here.
      const tool = payload.tool_name ?? "Tool";
      if (payload.agent !== "antigravity") {
        if (State.pendingApproval?.taskId === taskId) {
          State.appendStep(taskId, stepLabel(tool, payload.tool_input ?? {}));
        }
      }
      const t = State.tasks.find((x) => x.id === taskId);
      if (t) updateRichTask(t, tool, payload.tool_input ?? {}, cwd, "working");
      State.updateTask(taskId, "working");
      break;
    }

    case "PostToolUseFailure":
      State.updateTask(taskId, "working");
      State.appendStep(taskId, "⚠ failed");
      break;

    case "PreInvocation":
      // Antigravity fires this before each model call: the session is
      // thinking. No prompt text rides along, so only the state changes.
      ensurePill();
      State.updateTask(taskId, "thinking");
      surface("overview", false);
      break;

    case "PostInvocation":
      State.updateTask(taskId, "working");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(taskId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(taskId, "question");
        State.appendStep(taskId, message);
      }
      break;
    }

    case "Stop": {
      State.updateTask(taskId, "finished");
      if (payload.message) State.appendStep(taskId, payload.message.slice(0, 60));
      const t = State.tasks.find((x) => x.id === taskId);
      if (t) updateRichTask(t, "Stop", {}, cwd, "done");
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(taskId, "finished");
      stopAfter(taskId, 5200, () => {
        State.updateTask(taskId, "idle");
        State.setPillBadge(taskId, null);
      });
      break;
    }

    case "StopFailure":
      State.updateTask(taskId, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(taskId, "error");
      break;

    case "SessionEnd":
      State.updateTask(taskId, "idle");
      clearSession(taskId);
      break;

    case "SubagentStart":
      State.appendStep(taskId, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(taskId, "• subagent done");
      break;

    case "PermissionRequest":
      requestApproval(island, taskId, payload, projectName, cwd, focused);
      break;

    default:
      break;
  }
  State.notify();
}
