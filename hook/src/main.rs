//! coucou-hook — the relay an agent harness runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Coucou over the named pipe `\\.\pipe\coucou-<sid>`.
//!
//! One binary serves three harnesses — Claude Code, OpenCode (via the
//! `coucou.js` plugin) and Antigravity (via `hooks.json` command hooks) —
//! because all three speak the same stdin-JSON / stdout-JSON shape with only
//! small differences, normalised in `read_event`.
//!
//! Hard rule: **never block the agent.**
//! * If the pipe does not exist — Coucou is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only approval-gated events wait for an answer (`PermissionRequest` for
//!   Claude Code / OpenCode, `PreToolUse` for Antigravity), because approving
//!   from the island is the whole point. No answer means falling back to the
//!   harness native prompt: empty stdout for Claude Code (it asks in the
//!   terminal), a bare non-answer for OpenCode (the plugin leaves the TUI ask
//!   alone), `{"decision":"ask"}` for Antigravity (it prompts in its own UI).
//!
//! Usage: `coucou-hook <EventName> [agent]` where agent is one of
//! `claude` (default), `opencode`, `antigravity`. The agent is also read from
//! the JSON `agent` field when argv omits it, and guessed from the payload
//! shape (an Antigravity `toolCall` object) as a last resort.

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// `ERROR_PIPE_BUSY` — every instance is serving someone else right now. This is
/// the one error worth retrying: the server exists and a slot will free up.
const ERROR_PIPE_BUSY: i32 = 231;

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript_path"];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;

mod win;

/// `\\.\pipe\coucou-<sid>`. The SID keeps two accounts on the same machine from
/// ever meeting on the same pipe; the name falls back to the user name only if
/// the SID cannot be read at all, which should not happen.
fn pipe_path() -> String {
    let key = win::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\coucou-{key}")
}

/// Opens the pipe. Retries only while the server is busy: any other error means
/// there is nothing to talk to, and waiting would only delay Claude Code.
fn connect() -> Option<std::fs::File> {
    use std::os::windows::io::AsRawHandle;
    let path = pipe_path();
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => {
                let handle = windows::Win32::Foundation::HANDLE(file.as_raw_handle());
                // Somebody else's server on our pipe name gets nothing from us.
                return win::pipe_server_is_same_user(handle).then_some(file);
            }
            Err(err) => {
                if err.raw_os_error() != Some(ERROR_PIPE_BUSY) || Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
}

/// Events that gate on a human decision and therefore wait for the island.
/// Claude Code and OpenCode ask through `PermissionRequest` (OpenCode reaches us
/// via the plugin's `permission.ask` hook); Antigravity gates tool calls in
/// `PreToolUse` itself and has no separate permission event.
fn waits_for_answer(event: &str, agent: &str) -> bool {
    event == "PermissionRequest" || (agent == "antigravity" && event == "PreToolUse")
}

fn main() {
    let Some((payload, event, agent)) = read_event() else { std::process::exit(0) };

    let waits = waits_for_answer(&event, &agent);
    let budget = if waits { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };
    let waits_for_answer = waits;

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    let output = match rx.recv_timeout(budget) {
        Ok(Some(decision)) => decision_json(&decision, &agent, &event),
        // No island decision: each harness falls back to its native prompt.
        _ => fallback_json(&agent, &event),
    };
    if let Some(json) = output {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{json}");
        let _ = out.flush();
    }
    std::process::exit(0);
}

/// Fallback printed when an approval-gated event gets no island decision
/// (Coucou closed, paused, or timed out). Each harness falls back to its own
/// native prompt:
/// * Claude Code / OpenCode: `None` — empty stdout. Claude Code asks in the
///   terminal; our OpenCode plugin leaves the TUI ask untouched.
/// * Antigravity: its contract *requires* a `decision`, so silence is not an
///   option — `ask` respects the user's cached "Always Allow" grants and
///   otherwise prompts in the Antigravity UI, exactly like the other two.
fn fallback_json(agent: &str, event: &str) -> Option<String> {
    if agent == "antigravity" && event == "PreToolUse" {
        Some(r#"{"decision":"ask","reason":"Coucou is not available"}"#.to_string())
    } else {
        None
    }
}

/// Turns the island's bare `allow`/`deny` word into the JSON the calling
/// harness expects. Anything unrecognised prints nothing rather than guessing:
/// * Claude Code (`PermissionRequest`): the documented `hookSpecificOutput`
///   shape. See https://code.claude.com/docs/en/hooks
/// * OpenCode: the bare word itself — our plugin parses stdout, not OpenCode,
///   and maps it onto `permission.ask`'s `output.status`. Silence leaves the
///   TUI ask untouched.
/// * Antigravity (`PreToolUse`): `{"decision":"allow"|"deny"}`.
fn decision_json(decision: &str, agent: &str, event: &str) -> Option<String> {
    let word = decision.trim();
    if agent == "opencode" {
        return match word {
            "allow" | "always" => Some("allow".to_string()),
            "deny" => Some("deny".to_string()),
            _ => None,
        };
    }
    if agent == "antigravity" && event == "PreToolUse" {
        return match word {
            "allow" | "always" => Some(r#"{"decision":"allow"}"#.to_string()),
            "deny" => Some(r#"{"decision":"deny","reason":"Denied from Coucou"}"#.to_string()),
            _ => None,
        };
    }
    let behavior = match word {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not the harness's.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Coucou"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// Reads stdin and returns the payload to forward plus the event name and agent.
///
/// `agent` comes from argv[2] first (how our OpenCode plugin and Antigravity
/// `hooks.json` entries invoke us), then the JSON `agent` field, then the
/// payload shape: an Antigravity `toolCall` object means `antigravity`.
/// Anything else is `claude` — the OpenCode plugin already translates its
/// events into this Claude-shaped schema before spawning us.
fn read_event() -> Option<(String, String, String)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let map = payload.as_object_mut()?;

    // The event name is passed as argv[1] by the hook command; the JSON usually
    // carries it too. Trust argv when the JSON is missing it.
    let mut args = std::env::args();
    let _exe = args.next();
    let arg_event = args.next().unwrap_or_default();
    let arg_agent = args.next().unwrap_or_default();
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

    let agent = normalise_agent(map, &arg_agent);
    map.insert("agent".into(), serde_json::Value::String(agent.clone()));

    for field in DROPPED_FIELDS {
        map.remove(*field);
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Coucou accepts events from every
    // terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    truncate_strings(&mut payload);

    let mut line = payload.to_string();
    line.push('\n');
    Some((line, event, agent))
}

/// Picks the agent and flattens harness-specific shapes into the Claude-shaped
/// schema the island already renders (`tool_name`, `tool_input`, `cwd`,
/// `session_id`). The original fields are kept — only the missing
/// island-facing aliases are added.
fn normalise_agent(map: &mut serde_json::Map<String, serde_json::Value>, arg: &str) -> String {
    let from_arg = matches!(arg, "claude" | "opencode" | "antigravity");
    let from_json = map
        .get("agent")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| matches!(s.as_str(), "claude" | "opencode" | "antigravity"));
    let looks_like_antigravity = map.contains_key("toolCall");

    let agent = if from_arg {
        arg.to_string()
    } else if let Some(a) = from_json {
        a
    } else if looks_like_antigravity {
        "antigravity".to_string()
    } else {
        "claude".to_string()
    };

    if agent == "antigravity" {
        // Antigravity wraps the call as {toolCall:{name,args}, conversationId,
        // workspacePaths[], stepIdx}. Mirror it into island-facing fields.
        if let Some(call) = map.get("toolCall").cloned() {
            if let Some(name) = call.get("name").and_then(|v| v.as_str()) {
                if !map.contains_key("tool_name") {
                    map.insert("tool_name".into(), serde_json::Value::String(name.to_string()));
                }
            }
            if let Some(args) = call.get("args").cloned() {
                if !map.contains_key("tool_input") {
                    map.insert("tool_input".into(), args);
                }
            }
        }
        if let Some(id) = map.get("conversationId").and_then(|v| v.as_str()).map(str::to_string) {
            if !map.contains_key("session_id") {
                map.insert("session_id".into(), serde_json::Value::String(id));
            }
        }
        let cwd_missing = map
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(str::is_empty)
            .unwrap_or(true);
        if cwd_missing {
            if let Some(first) = map
                .get("workspacePaths")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .map(str::to_string)
            {
                map.insert("cwd".into(), serde_json::Value::String(first));
            }
        }
    }

    agent
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow", "claude", "PermissionRequest").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny", "claude", "PermissionRequest").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Coucou"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always", "claude", "PermissionRequest").unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("", "claude", "PermissionRequest").is_none());
        assert!(decision_json("maybe", "claude", "PermissionRequest").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#, "claude", "PermissionRequest").is_none());
    }

    #[test]
    fn opencode_gets_the_bare_word_for_the_plugin_to_map() {
        assert_eq!(decision_json("allow", "opencode", "PermissionRequest").unwrap(), "allow");
        assert_eq!(decision_json("always", "opencode", "PermissionRequest").unwrap(), "allow");
        assert_eq!(decision_json("deny", "opencode", "PermissionRequest").unwrap(), "deny");
        assert!(decision_json("maybe", "opencode", "PermissionRequest").is_none());
    }

    #[test]
    fn antigravity_pretooluse_gets_a_decision_object() {
        assert_eq!(
            decision_json("allow", "antigravity", "PreToolUse").unwrap(),
            r#"{"decision":"allow"}"#
        );
        assert_eq!(
            decision_json("deny", "antigravity", "PreToolUse").unwrap(),
            r#"{"decision":"deny","reason":"Denied from Coucou"}"#
        );
        assert!(decision_json("", "antigravity", "PreToolUse").is_none());
    }

    #[test]
    fn fallback_prompts_natively_without_guessing_a_decision() {
        assert!(fallback_json("claude", "PermissionRequest").is_none());
        assert!(fallback_json("opencode", "PermissionRequest").is_none());
        assert_eq!(
            fallback_json("antigravity", "PreToolUse").unwrap(),
            r#"{"decision":"ask","reason":"Coucou is not available"}"#
        );
        assert!(fallback_json("antigravity", "PostToolUse").is_none());
        assert!(fallback_json("antigravity", "Stop").is_none());
    }

    #[test]
    fn only_approval_gates_wait_for_the_island() {
        assert!(waits_for_answer("PermissionRequest", "claude"));
        assert!(waits_for_answer("PermissionRequest", "opencode"));
        assert!(waits_for_answer("PreToolUse", "antigravity"));
        assert!(!waits_for_answer("PreToolUse", "claude"));
        assert!(!waits_for_answer("PostToolUse", "antigravity"));
        assert!(!waits_for_answer("Stop", "antigravity"));
        assert!(!waits_for_answer("PreInvocation", "antigravity"));
    }

    #[test]
    fn antigravity_payloads_are_flattened_for_the_island() {
        let mut map = serde_json::json!({
            "toolCall": {"name": "run_command", "args": {"CommandLine": "npm test"}},
            "conversationId": "conv-1",
            "workspacePaths": ["C:/proj"],
            "stepIdx": 3
        })
        .as_object()
        .cloned()
        .unwrap();
        let agent = normalise_agent(&mut map, "");
        assert_eq!(agent, "antigravity");
        assert_eq!(map["tool_name"], "run_command");
        assert_eq!(map["tool_input"]["CommandLine"], "npm test");
        assert_eq!(map["session_id"], "conv-1");
        assert_eq!(map["cwd"], "C:/proj");
    }

    #[test]
    fn explicit_argv_agent_wins_over_guessing() {
        let mut map = serde_json::Map::new();
        assert_eq!(normalise_agent(&mut map, "opencode"), "opencode");
        assert_eq!(normalise_agent(&mut map, "claude"), "claude");
        // No argv, no agent field, no toolCall: the Claude default.
        assert_eq!(normalise_agent(&mut map, ""), "claude");
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }
}
