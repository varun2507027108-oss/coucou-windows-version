// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus, type HookPreview } from "../core/bridge";
import { DEFAULT_SETTINGS, MAX_ACTIVE_INTEGRATIONS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Agent hook sections (Claude Code, OpenCode, Antigravity) ─────────────────
// One component, three configs: every harness gets the same diff-preview →
// backup → explicit-click flow, only the words and the Bridge calls differ.

interface AgentHookConfig {
  title: string;
  installedHint: string;
  missingHint: string;
  /** Shown after a successful write. */
  doneNote: string;
  /** Extra guidance under the actions (policy snippet, manual path…). */
  extraHint?: string;
  /** Preview-screen wording (defaults to the Claude settings.json text). */
  previewInstallHint?: string;
  previewRemoveHint?: string;
  fileLabel: string;
  status: () => Promise<HookStatus | null>;
  preview: (install: boolean) => Promise<HookPreview>;
  apply: (install: boolean, fingerprint: string) => Promise<string>;
}

const CLAUDE_CONFIG: AgentHookConfig = {
  title: "Claude Code",
  installedHint:
    "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there.",
  missingHint:
    "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
  doneNote: "Open a new Claude Code session to pick the hooks up.",
  fileLabel: "settings.json",
  status: () => Bridge.hooksStatus(),
  preview: (install) => Bridge.hooksPreview(install),
  apply: (install, fingerprint) => Bridge.hooksApply(install, fingerprint),
};

const OPENCODE_CONFIG: AgentHookConfig = {
  title: "OpenCode",
  installedHint:
    "Coucou is hooked into your OpenCode sessions through the coucou plugin. Tool calls and permission requests show up in the island, and you can answer them there.",
  missingHint:
    "Install the plugin to see your OpenCode sessions in the island and approve permissions without leaving what you are doing.",
  doneNote: "Reload OpenCode to pick the plugin up.",
  previewInstallHint:
    "This is exactly what will be written to your OpenCode plugins folder. Your own plugins are left untouched.",
  previewRemoveHint:
    "This removes Coucou's plugin only. Your own plugins are left untouched.",
  extraHint:
    "OpenCode only asks for approval on tools your policy marks ask — add { \"permission\": { \"*\": \"ask\" } } to ~/.config/opencode/opencode.json to approve from the island. For a single project, copy the installed file to <project>/.opencode/plugins/coucou.js instead.",
  fileLabel: "plugin",
  status: () => Bridge.opencodeStatus(),
  preview: (install) => Bridge.opencodePreview(install),
  apply: (install, fingerprint) => Bridge.opencodeApply(install, fingerprint),
};

const ANTIGRAVITY_CONFIG: AgentHookConfig = {
  title: "Antigravity",
  installedHint:
    "Coucou is hooked into your Antigravity sessions through the global hooks.json. Tool calls show up in the island, and permission prompts can be answered there.",
  missingHint:
    "Install the hooks to see your Antigravity sessions in the island and approve tool calls without leaving what you are doing.",
  doneNote: "Open a new Antigravity session to pick the hooks up.",
  previewInstallHint:
    "This is exactly what will change in your global hooks.json. Your own hooks are left untouched.",
  previewRemoveHint:
    "This removes Coucou's entries only. Your own hooks are left untouched.",
  extraHint:
    "This edits the global ~/.gemini/config/hooks.json. For a single project, merge the same coucou entries into <project>/.agents/hooks.json instead.",
  fileLabel: "hooks.json",
  status: () => Bridge.antigravityStatus(),
  preview: (install) => Bridge.antigravityPreview(install),
  apply: (install, fingerprint) => Bridge.antigravityApply(install, fingerprint),
};

function agentHookSection(cfg: AgentHookConfig, status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: cfg.title })),
    body,
  );

  const rebuild = async () => {
    const fresh = await cfg.status();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: cfg.title }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed ? cfg.installedHint : cfg.missingHint,
      }),
      h("div", { class: "row" },
        h("label", { text: cfg.fileLabel }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
    if (cfg.extraHint) {
      body.append(h("div", { class: "hint", text: cfg.extraHint }));
    }
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await cfg.preview(install);
    } catch (err) {
      // An unreadable or invalid config stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    // Validate before clearing: `renderDiff` and the confirm handler read these
    // fields, and arguments are evaluated before `append`, so a partial payload
    // used to throw *after* the body was emptied — leaving a blank section with
    // no Back button and no way out but reloading the window.
    if (!preview || typeof preview.diff !== "string" || typeof preview.fingerprint !== "string") {
      clear(body);
      body.append(
        h("div", { class: "notice err", text: "The preview came back incomplete. Nothing was written — try again." }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? (cfg.previewInstallHint ?? "This is exactly what will change in your settings.json. Your own hooks are left untouched.")
          : (cfg.previewRemoveHint ?? "This removes Coucou's entries only. Your own hooks are left untouched."),
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await cfg.apply(install, preview.fingerprint);
        clear(body);
        // Rust returns an empty string when there was no previous file to back
        // up (the common first install). Saying "saved as <path>" for a backup
        // that does not exist would just be a lie with a path attached.
        body.append(h("div", {
          class: "notice ok",
          text: backup
            ? `Done. Previous settings saved as ${backup}. ${cfg.doneNote}`
            : `Done. Nothing to back up — there was no previous file. ${cfg.doneNote}`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── Claude API section ────────────────────────────────────────────────────────

const FALLBACK_MODELS: [string, string][] = [
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
];
const CUSTOM_MODEL_TAG = "__custom__";

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", {
    class: "hint",
    text: hasKey ? "Key saved in the Windows Credential Manager." : "No key yet — the chat needs one.",
  });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  let fetchedModels: { id: string; label: string }[] = [];

  const modelSelect = h("select", {}) as HTMLSelectElement;
  const customInput = h("input", {
    type: "text",
    placeholder: "Model ID (e.g. claude-sonnet-4-6)",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const customRow = h(
    "div",
    { class: "row", style: "display:none" },
    h("label", { text: "Custom ID" }),
    customInput,
  );

  function renderModelSelector() {
    const displayModels = fetchedModels.length > 0
      ? fetchedModels
      : FALLBACK_MODELS.map(([id, label]) => ({ id, label }));

    const isPreset = displayModels.some((m) => m.id === settings.model);
    const choice = isPreset ? settings.model : CUSTOM_MODEL_TAG;

    clear(modelSelect);
    for (const m of displayModels) {
      modelSelect.append(h("option", { value: m.id, text: m.label }));
    }
    modelSelect.append(h("option", { value: CUSTOM_MODEL_TAG, text: "Custom…" }));
    modelSelect.value = choice;

    if (choice === CUSTOM_MODEL_TAG) {
      customRow.style.display = "";
      customInput.value = settings.model;
    } else {
      customRow.style.display = "none";
    }
  }

  modelSelect.addEventListener("change", () => {
    const choice = modelSelect.value;
    if (choice !== CUSTOM_MODEL_TAG) {
      customRow.style.display = "none";
      settings.model = choice;
      void save();
    } else {
      customRow.style.display = "";
      customInput.value = settings.model;
      customInput.focus();
    }
  });

  customInput.addEventListener("input", () => {
    const val = customInput.value.trim();
    if (val) {
      settings.model = val;
      void save();
    }
  });

  async function loadModels() {
    try {
      const list = await Bridge.claudeModels();
      if (Array.isArray(list) && list.length > 0) {
        fetchedModels = list;
        renderModelSelector();
      }
    } catch {
      // If fetching fails or no key, fallback models remain
    }
  }

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? "Key saved in the Windows Credential Manager."
      : "No key yet — the chat needs one.";
    field.placeholder = present ? "••••••••••••  (stored)" : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
      void loadModels();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
      fetchedModels = [];
      renderModelSelector();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  renderModelSelector();
  if (hasKey) {
    void loadModels();
  }

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), modelSelect),
    customRow,
    h("div", { class: "hint", text: "Used by the chat. The list comes from your Anthropic account." }),
    feedback,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = MAX_ACTIVE_INTEGRATIONS;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        // `secrets::set` treats an empty value as delete, so a stray Enter in an
        // untouched field used to wipe a saved key with no confirmation.
        if (!value) return;
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Clipboard + shelf section ─────────────────────────────────────────────────

/**
 * Both features are off by default and both are about what Coucour keeps on the
 * disk, so they get their own section with the privacy wording next to the
 * switch rather than a line in General.
 */
function librarySection(): HTMLElement {
  const retention = h("select", {}) as HTMLSelectElement;
  for (const [value, label] of [
    [15, "15 minutes"],
    [60, "1 hour"],
    [240, "4 hours"],
    [1440, "24 hours"],
    [0, "Until I delete them"],
  ] as [number, string][]) {
    retention.append(h("option", { value: String(value), text: label }));
  }
  retention.value = String(settings.clipboardRetentionMinutes);
  retention.addEventListener("change", () => {
    settings.clipboardRetentionMinutes = Number(retention.value);
    void save();
  });

  const maxEntries = h("input", {
    type: "number", min: "10", max: "500", step: "10",
    value: String(settings.clipboardMaxEntries),
    style: "width:72px",
  }) as HTMLInputElement;
  maxEntries.addEventListener("change", () => {
    settings.clipboardMaxEntries = Math.max(10, Math.min(500, Number(maxEntries.value) || 100));
    maxEntries.value = String(settings.clipboardMaxEntries);
    void save();
  });

  const privacy = h("p", { class: "hint" });
  const paintPrivacy = () => {
    privacy.textContent = settings.clipboardEnabled
      ? `Kept in %LOCALAPPDATA%\\Coucou\\clipboard.json on this machine only. Up to ${settings.clipboardMaxEntries} entries, oldest dropped first. Nothing is uploaded.`
      : "Off. Coucou does not look at your clipboard at all until you turn this on.";
  };
  paintPrivacy();

  const shelfNote = h("p", { class: "hint" });
  const paintShelf = () => {
    shelfNote.textContent = settings.shelfEnabled
      ? "Dropped files are copied into %LOCALAPPDATA%\\Coucou\\shelf and kept for 30 days, so you can drag them back out into another app."
      : "Off. Dropped files still go to the drop inbox, which is swept after 7 days.";
  };
  paintShelf();

  const musicNote = h("p", { class: "hint" });
  const paintMusic = () => {
    musicNote.textContent = settings.mediaEnabled
      ? "Reads what Windows says is playing — no account, nothing uploaded."
      : "Off. Coucou does not watch your media until you turn this on.";
  };
  paintMusic();

  const lyricsNote = h("p", { class: "hint" });
  const paintLyrics = () => {
    lyricsNote.textContent = settings.mediaLyrics
      ? "Lyrics come from lrclib.net, only while you are online, and are cached on this machine."
      : "Off. No lyric lookups, no network.";
  };
  paintLyrics();

  // Glow style. Each button carries a live sample of its own effect rather than a
  // label: the difference between "tight" and "wide" is not something a word
  // conveys, and the choice only means anything against a real album colour.
  const GLOW_STYLES: Array<[string, string, string]> = [
    ["corner", "Corner", "A soft line along the bottom edge, pooling at the two rounded corners."],
    ["wide", "Wide", "The same light, larger and softer, spreading further out."],
    ["pulse", "Pulse", "The same light, breathing while the track plays."],
    ["off", "Off", "No album colour on the bar at all."],
  ];
  const glowButtons = GLOW_STYLES.map(([id, label, hint]) =>
    h("button", {
      class: "glow-opt",
      title: hint,
      "data-glow": id,
      onclick: () => {
        settings.mediaGlow = id;
        void save();
        paintGlow();
      },
    }, h("span", { class: "glow-opt-chip", "data-glow": id }), label),
  );
  const glowSeg = h("div", { class: "glow-seg" }, ...glowButtons);
  const glowNote = h("p", { class: "hint" });
  const paintGlow = () => {
    const current = GLOW_STYLES.find(([id]) => id === settings.mediaGlow);
    for (const b of glowButtons) {
      b.classList.toggle("on", b.dataset.glow === settings.mediaGlow);
    }
    glowSeg.classList.toggle("off", settings.mediaGlow === "off");
    glowNote.textContent = current
      ? current[2]
      : "Saved value not recognised; showing Corner.";
  };
  paintGlow();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Clipboard & files" })),
    h("div", { class: "row" },
      h("label", { text: "Clipboard history" }),
      toggle(settings.clipboardEnabled, (v) => {
        settings.clipboardEnabled = v;
        void save();
        paintPrivacy();
      }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Forget copies after" }),
      retention,
    ),
    h("div", { class: "row" },
      h("label", { text: "Keep at most" }),
      maxEntries,
      h("span", { class: "hint", text: "entries" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Skip anything that looks like a password" }),
      toggle(settings.clipboardSkipSecrets, (v) => {
        settings.clipboardSkipSecrets = v;
        void save();
      }),
    ),
    privacy,
    h("div", { class: "row" },
      h("label", { text: "File shelf" }),
      toggle(settings.shelfEnabled, (v) => {
        settings.shelfEnabled = v;
        void save();
        paintShelf();
      }),
    ),
    shelfNote,
    h("div", { class: "row" },
      h("label", { text: "Now playing" }),
      toggle(settings.mediaEnabled, (v) => {
        settings.mediaEnabled = v;
        void save();
        paintMusic();
      }),
    ),
    musicNote,
    h("div", { class: "row" },
      h("label", { text: "Lyrics" }),
      toggle(settings.mediaLyrics, (v) => {
        settings.mediaLyrics = v;
        void save();
        paintLyrics();
      }),
    ),
    lyricsNote,
    h("div", { class: "row" },
      h("label", { text: "Album glow on the bar" }),
      glowSeg,
    ),
    glowNote,
  );
}

// ── Music section ─────────────────────────────────────────────────────────────

// The player reads the OS media session: no account, nothing uploaded. Lyrics
// are the one part that uses the network, so they get their own switch; the
// Spotify link is only mood + fallback artwork on top of that.
function musicSection(): HTMLElement {
  const musicNote = h("p", { class: "hint" });
  const paintMusic = () => {
    musicNote.textContent = settings.mediaEnabled
      ? "Reads what Windows says is playing — no account, nothing uploaded."
      : "Off. Coucou does not watch your media until you turn this on.";
  };
  paintMusic();

  const lyricsNote = h("p", { class: "hint" });
  const paintLyrics = () => {
    lyricsNote.textContent = settings.mediaLyrics
      ? "Lyrics come from lrclib.net, only while you are online, and are cached on this machine."
      : "Off. No lyric lookups, no network.";
  };
  paintLyrics();

  const clientInput = h("input", {
    type: "text",
    placeholder: "Spotify client ID",
    autocomplete: "off",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
    value: settings.spotifyClientId ?? "",
  }) as HTMLInputElement;
  const linkBtn = h("button", { text: "Link…" });
  const unlinkBtn = h("button", { text: "Unlink" });
  const linkNote = h("p", { class: "hint" });
  const paintLink = (linked: boolean, hasId: boolean) => {
    linkNote.textContent = linked
      ? "Spotify linked — song moods and extra artwork are on."
      : hasId
        ? "Client ID saved. Link to finish connecting your account."
        : "Optional. A Spotify Dashboard client ID adds song moods (Mochi reacts to the kind of song) and extra artwork. Tokens stay in the Credential Manager.";
  };

  const refreshLink = async () => {
    const st = await Bridge.spotifyStatus().catch(() => null);
    paintLink(st?.linked ?? false, st?.hasClientId ?? clientInput.value.trim().length > 0);
    linkBtn.style.display = st?.linked ? "none" : "";
    unlinkBtn.style.display = st?.linked ? "" : "none";
  };
  void refreshLink();

  clientInput.addEventListener("change", () => {
    settings.spotifyClientId = clientInput.value.trim();
    void save();
    void refreshLink();
  });
  linkBtn.addEventListener("click", async () => {
    const id = clientInput.value.trim();
    if (!id) {
      linkNote.textContent = "Paste a client ID first — Spotify Dashboard → your app → Settings.";
      return;
    }
    settings.spotifyClientId = id;
    await save();
    try {
      const url = await Bridge.spotifyBegin();
      linkNote.textContent = "Approve in the browser tab that just opened…";
      void Bridge.openUrl(url);
      // The tokens land minutes later via the loopback listener, and the
      // settings page never hears the island's `spotify` event — so poll the
      // status until it flips instead of leaving "Link…" up forever.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const st = await Bridge.spotifyStatus().catch(() => null);
        if (st?.linked) break;
      }
      void refreshLink();
    } catch (e) {
      linkNote.textContent = String(e).replace(/^Error:\s*/, "");
    }
  });
  unlinkBtn.addEventListener("click", async () => {
    const st = await Bridge.spotifyUnlink().catch(() => null);
    paintLink(st?.linked ?? false, clientInput.value.trim().length > 0);
    void refreshLink();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Music" })),
    h("div", { class: "row" },
      h("label", { text: "Now playing" }),
      toggle(settings.mediaEnabled, (v) => {
        settings.mediaEnabled = v;
        void save();
        paintMusic();
      }),
    ),
    musicNote,
    h("div", { class: "row" },
      h("label", { text: "Lyrics" }),
      toggle(settings.mediaLyrics, (v) => {
        settings.mediaLyrics = v;
        void save();
        paintLyrics();
      }),
    ),
    lyricsNote,
    h("div", { class: "row" },
      h("label", { style: "min-width:104px", text: "Spotify link" }),
      clientInput, linkBtn, unlinkBtn,
    ),
    linkNote,
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };
  const openCodeStatus = (await Bridge.opencodeStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };
  const antigravityStatus = (await Bridge.antigravityStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  // Sections are grouped into tabs. Seven stacked cards meant a long scroll to
  // reach anything past the first agent, and the three hook cards alone pushed
  // everything else below the fold. Only one group is ever mounted, so this is
  // also less DOM than showing all of it at once.
  type Group = { id: string; label: string; build: () => HTMLElement };

  const groups: Group[] = [
    { id: "agents", label: "Agents", build: () => agentHookSection(CLAUDE_CONFIG, status) },
    // The two other harnesses share the Agents tab: they are the same kind of
    // card with the same install flow, and three near-identical tabs would be
    // noise of their own.
    { id: "agents", label: "", build: () => agentHookSection(OPENCODE_CONFIG, openCodeStatus) },
    { id: "agents", label: "", build: () => agentHookSection(ANTIGRAVITY_CONFIG, antigravityStatus) },
    { id: "claude", label: "Claude", build: () => apiSection(hasKey) },
    { id: "keys", label: "Integrations", build: () => integrationsSection(present) },
    { id: "library", label: "Clipboard & files", build: () => librarySection() },
    { id: "music", label: "Music", build: () => musicSection() },
    { id: "general", label: "General", build: () => generalSection() },
  ];

  const tab = (id: string, label: string): HTMLElement =>
    h("button", {
      class: "settings-tab",
      text: label,
      onclick: () => show(id),
    });

  const panel = h("div", { class: "settings-panel" });
  const tabsEl = h(
    "div",
    { class: "settings-tabs" },
    tab("agents", "Agents"),
    tab("claude", "Claude"),
    tab("keys", "Integrations"),
    tab("library", "Clipboard & files"),
    tab("music", "Music"),
    tab("general", "General"),
  );

  // Built once and kept, so a toggle or a typed value inside a section is not
  // thrown away by switching tabs and coming back.
  const built = new Map<string, HTMLElement[]>();
  for (const g of groups) {
    const list = built.get(g.id) ?? [];
    list.push(g.build());
    built.set(g.id, list);
  }

  const tabButtons = Array.from(tabsEl.querySelectorAll("button")) as HTMLButtonElement[];
  let current = "agents";

  function show(id: string) {
    current = id;
    clear(panel);
    for (const el of built.get(id) ?? []) panel.append(el);
    if (id === "general") {
      panel.append(
        h("div", {
          class: "hint",
          text: "No telemetry. Network requests only go to the services you configure yourself.",
        }),
      );
    }
    // Matched by index into the tab list, which lines up with the first group of each
    // id — the Agents tab holds three cards whose `label` is "", so comparing text
    // would never mark it as active.
    const index = groups.findIndex((g) => g.id === id);
    const tabIndex = ["agents", "claude", "keys", "library", "general"].indexOf(id);
    tabButtons.forEach((b, i) => b.classList.toggle("on", i === tabIndex && index >= 0));
  }

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    tabsEl,
    panel,
  );
  show(current);

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
