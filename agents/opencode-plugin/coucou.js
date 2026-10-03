// Coucou for OpenCode — forwards session, tool and permission events to the
// Coucou island over the same named-pipe relay Claude Code uses.
//
// Installed by Coucou (Settings → OpenCode → Install) into your global
// OpenCode plugins directory. `__COUCOU_HOOK_EXE__` is baked in at install
// time; do not edit it by hand — reinstall from Settings instead.
//
// Contract with coucou-hook.exe (argv: `<Event> opencode`, JSON on stdin):
//   * fire-and-forget events print nothing and exit fast (the relay bounds
//     itself: ~300 ms to connect, ~2 s total). Coucou never blocks OpenCode.
//   * `permission.ask` spawns `PermissionRequest`: stdout `allow`/`deny`
//     decides, anything else (empty = Coucou closed or paused) leaves
//     `output.status` untouched so OpenCode asks in the TUI as usual.
//
// Tip: OpenCode only raises `permission.ask` for tools your policy marks
// `ask`. To approve from the island, set e.g.
// `{ "permission": { "*": "ask" } }` in ~/.config/opencode/opencode.json.
// Explicit `deny` rules are still enforced first.

export const Coucou = async ({ directory }) => {
  const HOOK_EXE = "__COUCOU_HOOK_EXE__";

  /** Runs the relay and returns its trimmed stdout ("" on any failure). */
  function relay(event, payload) {
    try {
      const proc = Bun.spawnSync([HOOK_EXE, event, "opencode"], {
        stdin: Buffer.from(JSON.stringify(payload)),
        stdout: "pipe",
        stderr: "ignore",
      });
      return (proc.stdout?.toString() ?? "").trim();
    } catch {
      return "";
    }
  }

  /**
   * Fire-and-forget: the agent loop must never wait on observation.
   *
   * `tool.execute.before/after` used to go through `relay` (spawnSync), so
   * every tool call blocked the agent on a process spawn plus a ~130 ms pipe
   * round-trip — twice per tool. The relay bounds itself (~300 ms to connect,
   * ~2 s total) and exits alone, so awaiting it buys nothing. Only
   * `permission.ask` still blocks, because there the answer is the point.
   */
  function fire(event, payload) {
    try {
      const proc = Bun.spawn([HOOK_EXE, event, "opencode"], {
        stdin: Buffer.from(JSON.stringify(payload)),
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref();
    } catch {
      // Observation that cannot be delivered is simply dropped.
    }
  }

  const cwd = directory ?? "";

  function base(sessionID) {
    return { agent: "opencode", session_id: sessionID ?? "", cwd };
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const id = event.properties?.info?.id ?? event.properties?.id ?? "";
        fire("SessionStart", { ...base(id), hook_event_name: "SessionStart" });
      } else if (event.type === "session.deleted") {
        const id = event.properties?.info?.id ?? event.properties?.id ?? "";
        fire("SessionEnd", { ...base(id), hook_event_name: "SessionEnd" });
      } else if (event.type === "session.idle") {
        const id = event.properties?.sessionID ?? event.properties?.id ?? "";
        fire("Stop", { ...base(id), hook_event_name: "Stop" });
      }
    },

    "chat.message": async (input, output) => {
      // The user's prompt, so the island shows what was asked the way
      // UserPromptSubmit does for Claude Code. Fire-and-forget: never block
      // the message on the relay.
      try {
        const text =
          output?.message?.content ??
          output?.message?.text ??
          (Array.isArray(output?.parts)
            ? output.parts.filter((p) => typeof p?.text === "string").map((p) => p.text).join("\n")
            : "");
        if (typeof text === "string" && text.trim()) {
          fire("UserPromptSubmit", {
            ...base(input.sessionID),
            hook_event_name: "UserPromptSubmit",
            prompt: text.trim().slice(0, 2000),
          });
        }
      } catch {
        // A prompt we cannot read is simply not shown.
      }
    },

    "tool.execute.before": async (input, output) => {      const payload = {
        ...base(input.sessionID),
        hook_event_name: "PreToolUse",
        tool_name: input.tool ?? "tool",
        tool_input:
          output && typeof output.args === "object" && output.args !== null
            ? output.args
            : {},
      };
      fire("PreToolUse", payload);
      if (input.tool === "task") {
        fire("SubagentStart", { ...base(input.sessionID), hook_event_name: "SubagentStart" });
      }
    },

    "tool.execute.after": async (input) => {
      fire("PostToolUse", {
        ...base(input.sessionID),
        hook_event_name: "PostToolUse",
        tool_name: input.tool ?? "tool",
        tool_input:
          input && typeof input.args === "object" && input.args !== null ? input.args : {},
      });
      if (input.tool === "task") {
        fire("SubagentStop", { ...base(input.sessionID), hook_event_name: "SubagentStop" });
      }
    },

    "permission.ask": async (permission, output) => {
      const tool =
        (permission && (permission.tool ?? permission.type)) || "Permission";
      const answer = relay("PermissionRequest", {
        ...base(permission?.sessionID ?? permission?.session_id ?? ""),
        hook_event_name: "PermissionRequest",
        tool_name: String(tool),
        tool_input:
          permission && typeof permission === "object" ? permission : {},
      });
      // The relay prints the bare word `allow`/`deny`. Anything else means
      // Coucou could not answer — leave the TUI ask alone.
      if (answer === "allow" || answer === "always") output.status = "allow";
      else if (answer === "deny") output.status = "deny";
    },
  };
};
