// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, HOOK_PILL_IDS, sourceLabel, type AgentTask, type StepChecklistItem, type DiffLine } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, openActionFor, type IntegrationCardHooks } from "./integrations";
  import { buildClipboard, buildReview, buildShelf } from "../library/views";
  import { buildMusic } from "../library/music";

/**
 * Pills the overview's right card can show. The card body is 108 px tall and a
 * row is 28 px + a 4 px gap, so three rows (six pills) fit and a fourth does
 * not. Everything the compact bar cannot fit is reachable here, which is why
 * this is a cap and not a scroll.
 */
export const MAX_OVERVIEW_PILLS = 6;

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  /** Flips one of the clipboard/shelf preferences and persists the lot. */
  setLibraryPref(key: "clipboardEnabled" | "clipboardSkipSecrets" | "shelfEnabled"): void;
  setClipboardRetention(minutes: number): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** True when internal animations (like Ticker transitions) are active. */
  animating?: boolean;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

export function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));
  // Hidden until the feature is on, so a tab that always says "off" never sits
  // in the header taking the space of a real one.
  const tabClip = h("button", { class: "tab", title: "Clipboard", onclick: () => go("clipboard") }, svg(ICONS.clipDoc, 13));
  const tabShelf = h("button", { class: "tab", title: "Shelf", onclick: () => go("shelf") }, svg(ICONS.tray, 13));
  const tabReview = h("button", { class: "tab", title: "Pending changes", onclick: () => go("review") }, svg(ICONS.split, 13));
  // Same hide-until-on rule as clipboard/shelf: a dead tab earns no header space.
  const tabMusic = h("button", { class: "tab", title: "Now playing", onclick: () => go("music") }, svg(ICONS.note, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop, tabClip, tabShelf, tabReview, tabMusic),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      tabClip.classList.toggle("on", v === "clipboard");
      tabShelf.classList.toggle("on", v === "shelf");
      tabReview.classList.toggle("on", v === "review");
      tabMusic.classList.toggle("on", v === "music");
      // Always reachable, so a tab that is only hidden when off can still be
      // opened from the settings panel and then switched off again.
      const clipWanted = State.settings.clipboardEnabled || v === "clipboard";
      const shelfWanted = State.settings.shelfEnabled || v === "shelf";
      tabClip.style.display = clipWanted ? "" : "none";
      tabShelf.style.display = shelfWanted ? "" : "none";
      // Only shown when something actually has changes waiting, so it is not a
      // permanent tab that is empty nine times out of ten.
      const reviewWanted = State.tasks.some((t) => (t.diffLines?.length ?? 0) > 0) || v === "review";
      tabReview.style.display = reviewWanted ? "" : "none";
      const musicWanted = State.settings.mediaEnabled || v === "music";
      tabMusic.style.display = musicWanted ? "" : "none";
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

const DEFAULT_CHECKLIST: StepChecklistItem[] = [
  { id: "read", label: "Read", status: "done" },
  { id: "edit", label: "Edit", status: "active" },
  { id: "bash", label: "Bash", status: "pending" },
  { id: "done", label: "Done", status: "pending" },
];

const DEFAULT_DIFF_LINES: DiffLine[] = [
  { num: 10, type: "context", text: "import { Item } from './types'" },
  { num: 11, type: "context", text: "" },
  { num: 12, type: "del", text: "- const TVA = 0.196" },
  { num: 12, type: "add", text: "+ " },
  { num: 13, type: "context", text: "" },
  { num: 14, type: "context", text: "export function total(items: Item[]) {" },
  { num: 15, type: "context", text: "  const sum = items.reduce((s, i) => s + i.price, 0)" },
  { num: 16, type: "context", text: "  return sum * (1 + TVA)" },
  { num: 17, type: "context", text: "}" },
];

function renderChecklist(checklist: StepChecklistItem[]): HTMLElement[] {
  return checklist.map((item) => {
    let iconEl: SVGElement;
    if (item.status === "done") {
      iconEl = svg(ICONS.check, 10, { stroke: 2.5 });
      iconEl.style.color = "#22c55e";
    } else if (item.status === "active") {
      if (item.id === "bash") {
        iconEl = svg(ICONS.terminal, 11);
      } else {
        iconEl = svg(ICONS.circleDot, 11);
      }
      iconEl.style.color = "#ffffff";
    } else {
      if (item.id === "bash") {
        iconEl = svg(ICONS.terminal, 11);
      } else {
        iconEl = svg(ICONS.circle, 11);
      }
      iconEl.style.color = "#4b5563";
    }

    return h(
      "div",
      { class: `split-check-item ${item.status}` },
      h("span", { class: "check-icon" }, iconEl),
      h("span", { class: "check-label", text: item.label }),
    );
  });
}

function renderDiffBody(diffLines: DiffLine[]): HTMLElement[] {
  return diffLines.map((line) => {
    const numEl = h("span", { class: "diff-num", text: line.num != null ? String(line.num) : "" });
    const textEl = h("span", { class: "diff-text" });
    const raw = line.text ?? line.content ?? "";
    if (line.type === "add" && raw.includes("|")) {
      textEl.textContent = raw.replace("|", "");
      textEl.append(h("span", { class: "cursor-blink", text: "|" }));
    } else if (line.type === "add" && (raw === "+ " || raw.endsWith("+ "))) {
      textEl.textContent = raw;
      textEl.append(h("span", { class: "cursor-blink", text: "|" }));
    } else {
      textEl.textContent = raw;
    }
    return h("div", { class: `diff-row ${line.type}` }, numEl, textEl);
  });
}

function buildOverview(actions: ViewActions): ViewHost {
  // ── Classic components ──
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });

  const splitBtnClassic = h(
    "button",
    {
      class: "icon-btn split-toggle",
      title: "Split view",
      onclick: () => State.toggleSplitView(),
    },
    svg(ICONS.split, 9),
  );
  const trashBtnClassic = h(
    "button",
    {
      class: "icon-btn trash-toggle",
      title: "Clear session",
      onclick: () => {
        const t = State.focusTask;
        if (t) State.clearTaskSession(t.id);
      },
    },
    svg(ICONS.trash, 9),
  );
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open in editor / terminal", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const leftActions = h("div", { class: "left-actions" }, splitBtnClassic, trashBtnClassic, jump);
  const left = card(null, leftBody, leftActions);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const classicWrap = h("div", { class: "classic-wrap" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  // ── Split View components ──
  const splitView = h("div", { class: "split-view" });

  // Sidebar (sits directly beneath Mochi avatar)
  const splitSidebar = h("div", { class: "split-sidebar" });
  const splitTitle = h("div", { class: "split-title" });
  const splitSub = h("div", { class: "split-sub" });
  const splitChecklist = h("div", { class: "split-checklist" });
  splitSidebar.append(splitTitle, splitSub, splitChecklist);

  // Main area: actions + diff-card
  const splitMain = h("div", { class: "split-main" });
  const splitActions = h("div", { class: "split-actions" });

  const splitBtn = h(
    "button",
    {
      class: "split-btn",
      title: "Toggle split view",
      onclick: () => State.toggleSplitView(),
    },
    svg(ICONS.split, 11),
  );
  const trashBtn = h(
    "button",
    {
      class: "split-btn",
      title: "Clear session",
      onclick: () => {
        const t = State.focusTask;
        if (t) State.clearTaskSession(t.id);
      },
    },
    svg(ICONS.trash, 11),
  );
  const openBtn = h(
    "button",
    {
      class: "split-btn open-btn",
      title: "Open in editor / terminal",
      onclick: () => actions.openTarget(),
    },
    svg(ICONS.arrowUpRight, 10),
  );
  splitActions.append(splitBtn, trashBtn, openBtn);

  const diffCard = h("div", {
    class: "diff-card",
    title: "Click to open in editor / terminal",
    onclick: () => actions.openTarget(),
  });
  const diffHeader = h("div", { class: "diff-header" });
  const diffHeaderLeft = h("div", { class: "diff-header-left" });
  const diffBadge = h("span", { class: "diff-badge" });
  const diffFilename = h("span", { class: "diff-filename" });
  const diffDot = h("span", { class: "diff-dot", text: "•" });
  diffHeaderLeft.append(diffBadge, diffFilename, diffDot);
  const diffPath = h("span", { class: "diff-path" });
  diffHeader.append(diffHeaderLeft, diffPath);

  const diffBody = h("div", { class: "diff-body" });
  diffCard.append(diffHeader, diffBody);
  splitMain.append(splitActions, diffCard);

  splitView.append(splitSidebar, splitMain);

  const el = h("div", { class: "view overview" }, classicWrap, splitView);

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    get animating(): boolean {
      return mode === "ticker" && ticker.animating;
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // Live agent session (Claude Code, OpenCode, Antigravity) with activity
      const sessionActive =
        !!task && HOOK_PILL_IDS.includes(task.id) && (task.state !== "idle" || task.steps.length > 0);

      const isSplit = State.splitView && sessionActive;

      if (isSplit && task) {
        // Show Split View, hide Classic
        classicWrap.style.display = "none";
        splitView.style.display = "flex";

        // Sidebar info
        splitTitle.textContent = task.name || "coucou";
        splitSub.textContent = sourceLabel(task.source);

        // Checklist
        clear(splitChecklist);
        const checklistData = (task.checklist && task.checklist.length > 0)
          ? task.checklist
          : DEFAULT_CHECKLIST;
        splitChecklist.append(...renderChecklist(checklistData));

        // Active file / target header
        const fileInfo = task.activeFile ?? {
          name: "invoice.ts",
          path: "src/invoice.ts",
          ext: "TS",
        };
        diffBadge.textContent = fileInfo.ext ?? "TS";
        diffFilename.textContent = fileInfo.name;
        diffPath.textContent = fileInfo.path;

        // Diff lines
        clear(diffBody);
        const lines = (task.diffLines && task.diffLines.length > 0)
          ? task.diffLines
          : DEFAULT_DIFF_LINES;
        diffBody.append(...renderDiffBody(lines));
      } else {
        // Show Classic View, hide Split
        classicWrap.style.display = "flex";
        splitView.style.display = "none";

        splitBtnClassic.style.display = sessionActive ? "" : "none";
        trashBtnClassic.style.display = sessionActive ? "" : "none";

        if (task && sessionActive) {
          if (mode !== "ticker") {
            clear(leftBody);
            leftBody.append(tickerBody);
            mode = "ticker";
            cardKey = "";
          }
          clear(who);
          who.append(
            dot(task.color, 7),
            h("span", { class: "name", text: task.name }),
            h("span", { class: "tool", text: sourceLabel(task.source) }),
          );
          if (task.steps.length > 1) {
            who.append(h("span", {
              class: "count",
              text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
            }));
          }
          ticker.sync(task);
        } else if (task) {
          const info = State.integrations[task.id];
          const key = [
            task.id, detailOpen, task.state, task.steps.join("|"),
            task.sessionCwd,
            info?.loaded, info?.error, info?.configured,
            JSON.stringify(info?.data ?? {}),
          ].join("~");
          if (key !== cardKey) {
            cardKey = key;
            mode = "card";
            clear(leftBody);
            leftBody.append(renderIntegrationCard(task, hooks));
          }
        }

        jump.style.display = detailOpen ? "none" : "";

        // The right card pills
        const others = State.otherTasks.slice(0, MAX_OVERVIEW_PILLS);
        const pillKey = others.map((t) => `${t.id}:${t.pillBadge ?? ""}`).join("|");
        if (pillKey !== pillIds) {
          pillIds = pillKey;
          clear(pills);
          for (const t of others) pills.append(buildPill(t, actions));
          pruneMiniBots();
        }
      }
    },
  };
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      const agent = task ? sourceLabel(task.source) : "Claude Code";
      who.append(agentWho(task, `${agent} is asking a question`));
      title.textContent = task?.steps.at(-1) ?? "The agent needs an answer.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — Coucou can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task ? sourceLabel(task.source) : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  // "Open terminal" was hardcoded, so finishing an OpenCode session offered to
  // open a terminal that does not exist and an n8n run offered Visual Studio
  // Code. The label follows the pill.
  const openBtn = btn("Open", "primary", () => actions.openTerminal());
  const row = h("div", { class: "actions" }, openBtn, btn("OK", "secondary", () => actions.collapse()));
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, `${task ? sourceLabel(task.source) : "Claude Code"} finished`));
      title.textContent = task?.steps.at(-1) ?? "Session finished";
      const open = openActionFor(task);
      openBtn.textContent = open?.label ?? "Open";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const clipSwitch = h("button", { class: "switch", onclick: () => actions.setLibraryPref("clipboardEnabled") });
  const clipSecretSwitch = h("button", { class: "switch", onclick: () => actions.setLibraryPref("clipboardSkipSecrets") });
  const shelfSwitch = h("button", { class: "switch", onclick: () => actions.setLibraryPref("shelfEnabled") });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const hooksBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  // Clipboard and shelf sit in their own group: they are off by default and about
  // what Coucou keeps on the disk, so they are not buried among sound and timers.
  const clipRetentionSeg = h("div", { class: "seg" },
    ...[[15, "15m"], [60, "1h"], [0, "∞"]].map(([minutes, label]) =>
      h("button", {
        onclick: () => actions.setClipboardRetention(Number(minutes)),
      }, String(label)),
    ),
  );
  const clipRow = h("div", { class: "settings-row", style: "gap:10px" },
    clipSwitch,
    h("span", { text: "Clipboard history" }),
  );
  // The retention segments sit on their own line under the toggle: on one line
  // they were squeezed against the label and the "∞" was unreadable.
  const clipRetention = h("div", { class: "settings-row settings-sub" },
    h("span", { class: "settings-sub-label", text: "Forget copies after" }),
    clipRetentionSeg,
  );
  const clipSecretRow = h("div", { class: "settings-row settings-sub" },
    clipSecretSwitch,
    h("span", { text: "Skip anything that looks like a password" }),
  );
  const clipNote = h("div", { class: "settings-note" });
  const shelfRow = h("div", { class: "settings-row" },
    shelfSwitch,
    h("span", { text: "File shelf" }),
  );
  const shelfNote = h("div", { class: "settings-note" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    // Each group is labelled, so a wall of toggles reads as two sets of choices
    // rather than one long list you have to decode.
    h("div", { class: "settings-group-label", text: "Island" }),
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h("div", { class: "settings-sep" }),
    h("div", { class: "settings-group-label", text: "What Coucou keeps" }),
    clipRow,
    clipRetention,
    clipSecretRow,
    clipNote,
    shelfRow,
    shelfNote,
    h("div", { class: "settings-sep" }),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      hooksBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  const retentionButtons = Array.from(clipRetentionSeg.querySelectorAll("button"));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));

      clipSwitch.classList.toggle("on", s.clipboardEnabled);
      // The secret guard only means anything while capturing, and the retention
      // only applies to a history that exists — so both hide with the master switch.
      clipSecretRow.style.display = s.clipboardEnabled ? "" : "none";
      clipRetention.style.display = s.clipboardEnabled ? "" : "none";
      clipNote.style.display = s.clipboardEnabled ? "" : "none";
      clipSecretSwitch.classList.toggle("on", s.clipboardSkipSecrets);
      retentionButtons.forEach((b, i) =>
        b.classList.toggle("on", s.clipboardRetentionMinutes === [15, 60, 0][i]),
      );
      clipNote.textContent = s.clipboardEnabled
        ? `Kept on this machine only · last ${s.clipboardRetentionMinutes === 0 ? "forever" : `${s.clipboardRetentionMinutes} min`} · up to ${s.clipboardMaxEntries} entries`
        : "Off. Nothing is recorded until you turn this on.";
      shelfSwitch.classList.toggle("on", s.shelfEnabled);
      shelfNote.textContent = s.shelfEnabled
        ? "Dropped files are copied here so you can drag them back out later."
        : "Off. Files still go to the 7-day drop inbox.";
      // One dot per agent harness, from the installer status the island already
      // fetched. Only reflecting Claude Code left the other two invisible here.
      clear(hooksBadge);
      for (const id of HOOK_PILL_IDS) {
        const task = State.tasks.find((t) => t.id === id);
        const on = State.integrations[id]?.configured ?? false;
        hooksBadge.append(
          dot(on ? "#22C55E" : "#F4505E", 6),
          h("span", { text: task?.name ?? id }),
        );
      }
      clear(apiBadge);
      apiBadge.append(
        dot(State.hasApiKey ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "API" }),
      );
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
  onLibraryChanged: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  map.set("clipboard", buildClipboard(onLibraryChanged));
  map.set("shelf", buildShelf(onLibraryChanged));
  map.set("review", buildReview((taskId) => {
    State.setFocus(taskId);
    actions.setView("overview");
  }));
  map.set("music", buildMusic());
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
