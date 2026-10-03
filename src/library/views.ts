// Clipboard history and file shelf — the OmniNotch features, as two island views.
//
// Both lists are owned by Rust and only mirrored into `State` for rendering. The
// island never reads the clipboard on its own: Rust listens for the copy and says
// so, which is the only way to keep this off the critical path of anything else.

import { Bridge, type ClipEntry, type ShelfItem } from "../core/bridge";
import { State } from "../core/state";
import { h, svg, clear, dot } from "../views/dom";
import { ICONS } from "../views/icons";
import { card } from "../views/views";
import type { ViewHost } from "../views/views";

// ── Shared bits ───────────────────────────────────────────────────────────────

/** "just now" / "12 min" / "3 h" / "Tue" — enough resolution to be useful. */
export function agoLabel(atSeconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - atSeconds);
  if (delta < 45) return "now";
  if (delta < 3600) return `${Math.round(delta / 60)} min`;
  if (delta < 86_400) return `${Math.round(delta / 3600)} h`;
  if (delta < 7 * 86_400) return `${Math.round(delta / 86_400)} d`;
  return new Date(atSeconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** True when a transform would change something, so we do not offer dead buttons. */
function canTransform(kind: TransformKind, text: string): boolean {
  switch (kind) {
    case "json": return looksLikeJson(text);
    case "urls": return /\bhttps?:\/\/\S+/.test(text);
    case "strip": return /\s{2,}|\s+$/.test(text);
    case "snake":
    case "kebab":
    case "camel": return /\s|-|_/.test(text.trim());
  }
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

export type TransformKind = "json" | "urls" | "strip" | "snake" | "kebab" | "camel";

/**
 * The transforms offered on a row. Pure string work, done here rather than in
 * Rust: they are instant, they never leave the machine, and a failure is just
 * "this text isn't JSON" rather than an error to surface.
 */
export function applyTransform(kind: TransformKind, text: string): string | null {
  switch (kind) {
    case "json": {
      const t = text.trim();
      if (!looksLikeJson(t)) return null;
      try {
        // 2-space indent, the same shape most formatters use.
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return null;
      }
    }
    case "urls": {
      const found = text.match(/\bhttps?:\/\/[^\s<>"'`)\]]+/g);
      return found && found.length ? [...new Set(found)].join("\n") : null;
    }
    case "strip":
      return text.replace(/[ \t]{2,}/g, " ").replace(/\s+$/, "");
    case "snake":
      return text.trim().replace(/[\s-]+/g, "_").replace(/_+/g, "_").toLowerCase();
    case "kebab":
      return text.trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").toLowerCase();
    case "camel":
      return text
        .trim()
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
        .join("");
  }
}

export const TRANSFORM_LABELS: Record<TransformKind, string> = {
  json: "JSON",
  urls: "URLs",
  strip: "Trim",
  snake: "snake",
  kebab: "kebab",
  camel: "camel",
};

/** Two lines of the text, so one long entry cannot take over the view. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

function emptyState(icon: string, title: string, sub: string): HTMLElement {
  return h(
    "div",
    { class: "list-empty" },
    svg(ICONS[icon as keyof typeof ICONS], 18),
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
}

/**
 * The card every other expanded view draws itself into. The list has to live in
 * one too: a bare `.view` is transparent, so the rows sat straight on top of
 * whatever app was behind the island with no panel behind them at all.
 */
function listShell(...children: (Node | null)[]): HTMLElement {
  return h("div", { class: "stack", style: "padding:0" }, h("div", { class: "list-body" }, ...children));
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

export function buildClipboard(onChanged: () => void): ViewHost {
  const rows = h("div", { class: "list-rows" });
  const note = h("div", { class: "list-note" });

  // Kept outside `render`: a filter that reset itself on every re-render would eat
  // the half-typed query the moment a copy landed.
  let query = "";
  const queryInput = h("input", {
    class: "list-search",
    type: "text",
    placeholder: "Search…",
    spellcheck: false,
    oninput: (e: Event) => {
      query = (e.target as HTMLInputElement).value;
      render();
    },
  }) as HTMLInputElement;

  const searchBar = h("div", { class: "list-searchbar" }, queryInput);
  const body = listShell(searchBar, rows);

  // Click anywhere on a row to put it back on the clipboard. The delete button
  // stops propagation so removing a row never also restores it.
  const restore = async (entry: ClipEntry) => {
    try {
      await Bridge.clipboardRestore(entry.text, entry.id);
    } catch (err) {
      // The clipboard is shared and lockable, so this genuinely fails sometimes
      // and the user needs to know why nothing happened.
      note.textContent = "Couldn't reach the clipboard — another app has it open.";
      return;
    }
    note.textContent = entry.isImage
      ? "Image copied back to your clipboard."
      : "Copied back to your clipboard.";
    onChanged();
  };

  const drop = async (entry: ClipEntry) => {
    await Bridge.clipboardRemove(entry.id);
    note.textContent = "";
    onChanged();
  };

  // A screen capture copied with Ctrl+Shift+S lands on the clipboard as a bitmap,
  // with no text at all — so a text-only history has nothing to store and the copy
  // silently vanished. Coucou keeps no image data, but it says what happened
  // instead of pretending the copy never occurred.
  const IMAGE_NOTE = "Copy an image or text to keep it here.";

  const clearAll = async () => {
    await Bridge.clipboardClear();
    note.textContent = "";
    onChanged();
  };

  const togglePin = async (entry: ClipEntry, e: Event) => {
    e.stopPropagation();
    await Bridge.clipboardPin(entry.id, !entry.pinned);
    onChanged();
  };

  /** Runs a transform and puts the result on the clipboard, as well as in the row. */
  const transform = async (entry: ClipEntry, kind: TransformKind, e: Event) => {
    e.stopPropagation();
    const out = applyTransform(kind, entry.text);
    if (out == null) {
      note.textContent = `${TRANSFORM_LABELS[kind]} doesn't apply to that.`;
      return;
    }
    try {
      await Bridge.clipboardTransform(entry.id, out);
      await Bridge.clipboardRestore(out);
      note.textContent = `${TRANSFORM_LABELS[kind]} — copied back to your clipboard.`;
    } catch {
      note.textContent = "Couldn't write that — another app has the clipboard open.";
    }
    onChanged();
  };

  const el = h("div", { class: "view" }, card(null, body), note);

  const render = () => {
    clear(rows);
    if (!State.settings.clipboardEnabled) {
      rows.append(
        emptyState(
          "clipDoc",
          "Clipboard history is off.",
          "Turn it on in Settings to keep what you copy.",
        ),
      );
      return;
    }
    // The filter runs here rather than in Rust: it is instant, and re-querying the
    // backend on every keystroke would put a round trip in the middle of typing.
    const q = query.trim().toLowerCase();
    const shown = q ? State.clipboard.filter((e) => e.text.toLowerCase().includes(q)) : State.clipboard;

    if (!State.clipboard.length) {
      rows.append(
        State.clipboardImage
          ? emptyState("clipDoc", "That was an image.", IMAGE_NOTE)
          : emptyState("clipDoc", "Nothing copied yet.", "Copy some text and it shows up here."),
      );
      return;
    }
    if (!shown.length) {
      rows.append(emptyState("clipDoc", "No match.", `Nothing here contains "${query.trim()}".`));
      return;
    }

    for (const entry of shown) {
      const del = h("button", {
        class: "row-del",
        title: "Delete",
        onclick: (e: Event) => {
          e.stopPropagation();
          void drop(entry);
        },
      });
      del.append(svg(ICONS.xmark, 10, { stroke: 2.2 }));

      const pin = h("button", {
        class: `row-pin${entry.pinned ? " on" : ""}`,
        title: entry.pinned ? "Unpin" : "Keep this forever",
        onclick: (e: Event) => void togglePin(entry, e),
      });
      pin.append(svg(ICONS.star, 10, { fill: entry.pinned ? "#F5A524" : "currentColor" }));

      // Only the transforms that would actually change this row, so there are no
      // dead buttons to click your way through.
      const actions = entry.isImage
        ? []
        : (Object.keys(TRANSFORM_LABELS) as TransformKind[])
            .filter((k) => canTransform(k, entry.text))
            .map((k) =>
              h("button", {
                class: "row-act",
                text: TRANSFORM_LABELS[k],
                onclick: (e: Event) => void transform(entry, k, e),
              }),
            );

      rows.append(
        h(
          "div",
          {
            class: `list-row${entry.pinned ? " pinned" : ""}`,
            title: "Copy this back",
            onclick: () => void restore(entry),
          },
          h("div", { class: "row-main" },
            entry.dataUrl ? h("img", { class: "row-thumb", src: entry.dataUrl, alt: "Copied image" }) : null,
            h("div", { class: "row-text", text: preview(entry.text) }),
            h("div", { class: "row-meta" },
              h("span", { text: agoLabel(entry.at) }),
              entry.isImage
                ? h("span", { class: "row-tag", text: "image" })
                : (entry.text.includes("\n") ? h("span", { class: "row-tag", text: "multiline" }) : null),
              actions.length ? h("span", { class: "row-acts" }, ...actions) : null,
            ),
          ),
          pin,
          del,
        ),
      );
    }
    rows.append(
      h(
        "div",
        { class: "list-foot" },
        h("span", {
          text: q
            ? `${shown.length} of ${State.clipboard.length} · Esc clears the search`
            : `${State.clipboard.length} kept · click a row to copy it back`,
        }),
        h("button", { class: "link-btn", text: "Clear all", onclick: () => void clearAll() }),
      ),
    );
  };

  return { el, sync: render };
}

/** Pulls the history from Rust. Called when the view opens and after a change. */
export async function refreshClipboard(): Promise<void> {
  if (!State.settings.clipboardEnabled) {
    State.clipboard = [];
    State.clipboardImage = false;
    State.notify();
    return;
  }
  const entries = await Bridge.clipboardList();
  // Read the image flag *after* the list: `clipboard_list` re-reads the clipboard
  // itself, so this is the state as of that moment rather than before it.
  State.clipboard = entries ?? [];
  State.clipboardImage = (await Bridge.clipboardHasImage()) ?? false;
  State.notify();
}

// ── Change review ──────────────────────────────────────────────────────────────

/**
 * Every agent's pending diff in one list.
 *
 * The split view shows one agent at a time, which is fine until two harnesses are
 * editing at once — then you have to flip between them to work out what is
 * actually outstanding. This is the triage view: one row per agent that has
 * changes, showing what it touched and how big, so you can pick which to look at.
 */
export function buildReview(onOpenTask: (taskId: string) => void): ViewHost {
  const rows = h("div", { class: "list-rows" });
  const body = listShell(rows);
  const el = h("div", { class: "view" }, card(null, body));

  const render = () => {
    clear(rows);
    const pending = State.tasks.filter((t) => (t.diffLines?.length ?? 0) > 0);

    if (!pending.length) {
      rows.append(
        emptyState("split", "No pending changes.", "An agent's diff shows up here as soon as it edits a file."),
      );
      return;
    }

    for (const task of pending) {
      const diff = task.diffLines ?? [];
      const added = diff.filter((l) => l.type === "add").length;
      const removed = diff.filter((l) => l.type === "del").length;
      const file = task.activeFile?.name;

      rows.append(
        h(
          "div",
          {
            class: "list-row review-row",
            title: "Open this agent's diff",
            onclick: () => onOpenTask(task.id),
          },
          h("div", { class: "file-ico" }, dot(task.color, 8)),
          h("div", { class: "row-main" },
            h("div", { class: "row-text", text: task.name }),
            h("div", { class: "row-meta" },
              file ? h("span", { text: file }) : null,
              h("span", { class: "row-sep", text: "·" }),
              h("span", { class: "diff-add", text: `+${added}` }),
              h("span", { class: "diff-del", text: `−${removed}` }),
            ),
          ),
          h("span", { class: "row-open", text: "Review" }),
        ),
      );
    }

    const totalAdd = pending.reduce((n, t) => n + (t.diffLines ?? []).filter((l) => l.type === "add").length, 0);
    const totalDel = pending.reduce((n, t) => n + (t.diffLines ?? []).filter((l) => l.type === "del").length, 0);
    rows.append(
      h(
        "div",
        { class: "list-foot" },
        h("span", { text: `${pending.length} agent${pending.length === 1 ? "" : "s"} · +${totalAdd} −${totalDel}` }),
      ),
    );
  };

  return { el, sync: render };
}

// ── File shelf ────────────────────────────────────────────────────────────────

export function buildShelf(onChanged: () => void): ViewHost {
  const rows = h("div", { class: "list-rows" });
  const body = listShell(rows);

  const drop = async (item: ShelfItem) => {
    try {
      await Bridge.shelfRemove(item.path);
    } catch {
      // A path outside the shelf is refused by Rust on purpose; the row stays so
      // the user can see it is still there rather than watching it vanish.
      return;
    }
    onChanged();
  };

  const clearAll = async () => {
    await Bridge.shelfClear();
    onChanged();
  };

  const el = h("div", { class: "view" }, card(null, body));

  const render = () => {
    clear(rows);
    if (!State.settings.shelfEnabled) {
      rows.append(
        emptyState("tray", "The shelf is off.", "Turn it on in Settings to park files here."),
      );
      return;
    }
    if (!State.shelf.length) {
      rows.append(
        emptyState("tray", "The shelf is empty.", "Drop a file on the island to keep it here."),
      );
      return;
    }
    for (const item of State.shelf) {
      const del = h("button", {
        class: "row-del",
        title: "Remove",
        onclick: (e: Event) => {
          e.stopPropagation();
          void drop(item);
        },
      });
      del.append(svg(ICONS.xmark, 10, { stroke: 2.2 }));
      rows.append(
        h(
          "div",
          {
            class: "list-row file-row",
            // Drag a shelf item straight into Explorer, a chat, or anywhere else
            // that accepts files.
            //
            // WebView2 has no drag-source of its own, but Chromium understands
            // the `DownloadURL` pseudo-format: setting it on a `draggable` element
            // is the supported way to drag a real file out of a page, and the
            // receiving app is handed a genuine file — not a copy we had to make.
            draggable: true,
            ondragstart: (e: Event) => {
              const ev = e as DragEvent;
              if (!ev.dataTransfer) return;
              // A file:// URL, forward-slashed. Explorer refuses a Windows path
              // here, and backslashes are not valid in a URL.
              const asUrl = new URL(`file:///${item.path.replace(/\\/g, "/").replace(/^\/+/, "")}`);
              ev.dataTransfer.setData("DownloadURL", `${item.name}\n${asUrl.href}`);
              ev.dataTransfer.setData("text/plain", item.path);
              ev.dataTransfer.effectAllowed = "copy";
            },
          },
          h("div", { class: "file-ico" }, svg(ICONS.doc, 13)),
h("div", { class: "row-main" },
            h("div", { class: "row-text", text: item.name }),
            h("div", { class: "row-meta" },
              h("span", { text: humanSize(item.size) }),
              h("span", { class: "row-sep", text: "·" }),
              h("span", { text: agoLabel(item.at) }),
              h("span", { class: "row-sep", text: "·" }),
              // The point of the shelf: the row has to say it can be dragged,
              // or it just looks like another read-only list.
              h("span", { class: "row-drag-hint", text: "drag out" }),
            ),
          ),
          del,
        ),
      );
    }
    const total = State.shelf.reduce((sum, i) => sum + i.size, 0);
    rows.append(
      h(
        "div",
        { class: "list-foot" },
        h("span", {
          text: `${State.shelf.length} file${State.shelf.length === 1 ? "" : "s"} · ${humanSize(total)} · kept 30 days`,
        }),
        h("button", { class: "link-btn", text: "Clear all", onclick: () => void clearAll() }),
      ),
    );
  };

  return { el, sync: render };
}

export async function refreshShelf(): Promise<void> {
  if (!State.settings.shelfEnabled) {
    State.shelf = [];
    State.notify();
    return;
  }
  const items = await Bridge.shelfList();
  State.shelf = items ?? [];
  State.notify();
}
