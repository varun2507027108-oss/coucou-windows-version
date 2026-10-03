// Claude API client — the same integration as ClaudeService.swift: multi-turn
// chat with web search, and files sent as document/image/text blocks.
//
// Everything happens here rather than in the island: the API key never leaves
// the Credential Manager, and file bytes never cross the IPC boundary.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets;

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the island never shows a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 4096;
/// Text and code files are inlined; anything larger is skipped, as on macOS.
const MAX_INLINE_TEXT: u64 = 200_000;
/// Same idea for images and PDFs, and it has to be checked: `file_block` returns
/// early for those, so a 400 MB PDF used to be read whole and base64'd into the
/// request body (and into memory, on a blocking read inside an async fn).
const MAX_INLINE_BINARY: u64 = 5_000_000;

pub const DEFAULT_MODEL: &str = "claude-sonnet-4-6";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelItem {
    pub id: String,
    pub label: String,
}

const SYSTEM_PROMPT: &str = "You are Mochi, a personal AI assistant living at the top of the user's screen. \
You have web search access and can help with absolutely anything — research, coding, finding places, recommendations, tasks, questions. \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

/// How many past turns to include in a request.
///
/// The history was previously sent in full, forever, so a long chat eventually
/// blew the context limit and every message after that failed with no visible
/// cause. Trimming keeps the cost of a turn bounded.
///
/// The cut is always an **even** number of messages from the front. `send`
/// appends exactly one user message and one assistant message per turn, so the
/// history is `[user, assistant, user, assistant, …]` and cutting on a turn
/// boundary can never orphan a `tool_result` from its `tool_use`.
const MAX_HISTORY_TURNS: usize = 24;

#[derive(Default)]
pub struct Chat {
    /// Full multi-turn history, including tool_use / tool_result blocks.
    ///
    /// A `tokio::sync::Mutex`, not a `std` one, and held for the whole turn: the
    /// old version took and released a `std` lock three separate times per turn
    /// (`is_empty` → `push` → `snapshot`, then `pop` on failure), so two quick
    /// Sends interleaved and the error path popped the *other* request's user
    /// message. A chat is one conversation, so serialising turns is also the
    /// correct semantics rather than a workaround.
    messages: tokio::sync::Mutex<Vec<Value>>,
}

impl Chat {
    pub async fn reset(&self) {
        self.messages.lock().await.clear();
    }

    /// Drops everything but the most recent [`MAX_HISTORY_TURNS`] turns, always
    /// on a turn boundary.
    fn trim(messages: &mut Vec<Value>) {
        if messages.len() <= MAX_HISTORY_TURNS * 2 {
            return;
        }
        let skip = messages.len() - MAX_HISTORY_TURNS * 2;
        // `skip` is even by construction, but never trust that: a user message
        // whose blocks are only tool_results must not become the first one sent.
        let mut cut = skip;
        while cut < messages.len() {
            let starts_clean = messages[cut]
                .get("role")
                .and_then(Value::as_str)
                .map(|r| r == "user")
                .unwrap_or(false)
                && !messages[cut]
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|blocks| {
                        blocks.iter().all(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                    })
                    .unwrap_or(false);
            if starts_clean {
                break;
            }
            cut += 1;
        }
        messages.drain(..cut);
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File { name: String, path: String },
    Window { app_name: String, title: String, url: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
}

/// One chat turn. Returns the assistant's text, or a message the island shows
/// in the note view.
pub async fn send(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let key = secrets::get("anthropic-api-key")
        .ok_or_else(|| "API key missing. Open settings.".to_string())?;

    // Held for the whole turn: this is a single conversation, and letting two
    // Sends interleave is what used to corrupt the history.
    let mut history = chat.messages.lock().await;

    let mut content: Vec<Value> = Vec::new();

    // File / window context rides along with the first message only, exactly
    // like ClaudeService.chat().
    if history.is_empty() {
        match &context {
            Some(ChatContext::File { name, path }) => {
                if let Some(block) = file_block(path) {
                    content.push(block);
                }
                content.push(json!({ "type": "text", "text": format!("File: {name}") }));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                content.push(json!({ "type": "text", "text": text }));
            }
            None => {}
        }
    }
    content.push(json!({ "type": "text", "text": query }));

    // The turn is built on a copy and only committed once the model has actually
    // answered. Every error below is then a plain `return` — there is no `pop()`
    // to forget, which is exactly how a `tool_use` without its `tool_result` used
    // to end up in the history and make the chat reject every later message.
    let mut turn = history.clone();
    Chat::trim(&mut turn);
    turn.push(json!({ "role": "user", "content": content }));

    let body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "tools": [{ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 }],
        "fallbacks": "default",
        "messages": turn,
    });

    let response = call(&key, &body, model).await?;

    // A policy decline comes back as HTTP 200 with stop_reason "refusal".
    if response.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        let why = response
            .get("stop_details")
            .and_then(|d| d.get("explanation"))
            .and_then(Value::as_str)
            .unwrap_or("Claude declined this one.")
            .to_string();
        return Err(why);
    }

    let Some(blocks) = response.get("content").and_then(Value::as_array).cloned() else {
        return Err("Unexpected API response.".into());
    };

    let text = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if text.is_empty() {
        return Err("No response text.".into());
    }

    // Store the whole content — tool_use / tool_result blocks included — so the
    // next turn has the right context.
    history.push(json!({ "role": "user", "content": content }));
    history.push(json!({ "role": "assistant", "content": blocks }));
    Ok(ChatReply { text })
}

async fn call(key: &str, body: &Value, model: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(ENDPOINT)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // Surface the API's own message, which is what makes a bad key obvious.
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                let err = v.get("error")?;
                let err_type = err.get("type").and_then(Value::as_str);
                let err_msg = err.get("message").and_then(Value::as_str);
                if err_type == Some("not_found_error") {
                    Some(format!("Model not found: {model}. Pick another one in Settings."))
                } else {
                    err_msg.map(str::to_string)
                }
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("Claude API {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

/// Fetches available models from the Anthropic API in the order returned.
pub async fn fetch_models() -> Result<Vec<ModelItem>, String> {
    let key = secrets::get("anthropic-api-key")
        .ok_or_else(|| "API key missing.".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get("https://api.anthropic.com/v1/models?limit=100")
        .header("x-api-key", &key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let val = response.json::<Value>().await.map_err(|e| e.to_string())?;
    let mut list = Vec::new();
    if let Some(items) = val.get("data").and_then(Value::as_array) {
        for item in items {
            if let (Some(id), Some(name)) = (
                item.get("id").and_then(Value::as_str),
                item.get("display_name").and_then(Value::as_str),
            ) {
                list.push(ModelItem {
                    id: id.to_string(),
                    label: name.to_string(),
                });
            }
        }
    }
    Ok(list)
}

/// PDF → document block, image → image block, text/code → inline text.
/// Mirrors readFileAsBlock() in ClaudeService.swift.
fn file_block(path: &str) -> Option<Value> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "pdf" => Some(("document", "application/pdf")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "png" => Some(("image", "image/png")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        _ => None,
    };

    // Bounded before the read, not after: the size check has to come first or
    // an arbitrarily large dropped file is pulled into memory whole.
    if std::fs::metadata(path).ok()?.len() > MAX_INLINE_BINARY {
        return None;
    }

    if let Some((block_type, media)) = media_type {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": block_type,
            "source": { "type": "base64", "media_type": media, "data": base64(&bytes) },
        }));
    }

    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(json!({ "type": "text", "text": format!("File contents:\n{text}") }))
}

/// Small standalone base64 encoder — not worth another dependency.
/// Also used for Stripe's basic auth.
pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{base64, file_block, Chat, MAX_HISTORY_TURNS, MAX_INLINE_BINARY, MAX_INLINE_TEXT};
    use serde_json::{json, Value};

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn a_huge_binary_is_refused_before_it_is_read() {
        let tmp = std::env::temp_dir().join(format!("coucou-claude-huge-{}.png", std::process::id()));
        // Sparse, so the test does not really allocate 5 MB.
        let file = std::fs::File::create(&tmp).unwrap();
        file.set_len(MAX_INLINE_BINARY + 1).unwrap();
        drop(file);
        // The size guard has to run before the media branch, or this returns a
        // multi-megabyte base64 block instead of `None`.
        assert!(file_block(tmp.to_str().unwrap()).is_none());
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn a_small_image_and_a_large_text_file_are_handled_as_documented() {
        // Distinct names: these tests share a process and run in parallel, so
        // reusing one path made them fight over the same file.
        let png = std::env::temp_dir().join(format!("coucou-claude-small-{}.png", std::process::id()));
        std::fs::write(&png, b"\x89PNG\r\n\x1a\nsmall").unwrap();
        let block = file_block(png.to_str().unwrap()).expect("a small image is inlined");
        assert_eq!(block["type"], "image");
        assert_eq!(block["source"]["media_type"], "image/png");
        let _ = std::fs::remove_file(&png);

        let big =
            std::env::temp_dir().join(format!("coucou-claude-big-{}.txt", std::process::id()));
        std::fs::write(&big, vec![b'x'; MAX_INLINE_TEXT as usize + 1]).unwrap();
        assert!(file_block(big.to_str().unwrap()).is_none(), "text over the cap is skipped");
        let _ = std::fs::remove_file(&big);
    }

    /// Trimming the history must never leave a `tool_result` as the first
    /// message: the API rejects that, which is what used to brick a long chat.
    #[test]
    fn trimming_keeps_whole_turns_and_starts_on_a_real_user_message() {
        let user = |i: usize| json!({ "role": "user", "content": [{ "type": "text", "text": format!("q{i}") }] });
        let assistant = |i: usize| json!({ "role": "assistant", "content": [{ "type": "text", "text": format!("a{i}") }] });

        for turns in [1usize, 2, 5, MAX_HISTORY_TURNS, MAX_HISTORY_TURNS + 1, 200] {
            let mut history: Vec<Value> = (0..turns).flat_map(|i| [user(i), assistant(i)]).collect();
            Chat::trim(&mut history);
            assert!(history.len() <= MAX_HISTORY_TURNS * 2, "{turns} turns: not bounded");
            if turns > MAX_HISTORY_TURNS {
                assert!(!history.is_empty(), "{turns} turns: trimmed to nothing");
                // Always starts on a user message, never on an assistant reply
                // and never on a user message made only of tool results.
                assert_eq!(history[0]["role"], "user", "{turns} turns: bad first role");
                let kinds: Vec<&str> = history[0]["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|b| b.get("type").and_then(Value::as_str))
                    .collect();
                assert_ne!(kinds.first(), Some(&"tool_result"), "{turns} turns: orphan tool_result");
                // Still alternating and still paired.
                assert_eq!(history.len() % 2, 0, "{turns} turns: unpaired");
            }
        }
    }

    #[test]
    fn trimming_skips_past_a_user_message_that_is_only_tool_results() {
        // A tool result must follow its tool_use, so a cut may not land here.
        let mut history = vec![
            json!({ "role": "user", "content": [{ "type": "text", "text": "q" }] }),
            json!({ "role": "assistant", "content": [{ "type": "tool_use", "id": "t1" }] }),
            json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1" }] }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "a" }] }),
        ];
        Chat::trim(&mut history);
        assert_eq!(history[0]["role"], "user");
        let kinds: Vec<&str> = history[0]["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|b| b.get("type").and_then(Value::as_str))
            .collect();
        assert_ne!(kinds.first(), Some(&"tool_result"));
    }
}
