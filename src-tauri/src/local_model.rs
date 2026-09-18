//! The optional local-model calls: `Ask local model` on the Wiki Overview
//! (post-Stage-1 feature). Ollama only, reached as plain HTTP/1.0 requests
//! to its localhost port over `std::net::TcpStream`. No HTTP client crate,
//! no provider abstraction, no streaming, no retries, no model name of its
//! own: the model is whatever the user picked from what their Ollama
//! reports as installed.
//!
//! ```text
//! list_local_models()
//!   when: only from the explicit choose or change click in the section
//!   to:   127.0.0.1:11434 · GET /api/tags · HTTP/1.0 · Connection: close
//!   out:  models(names) | unavailable | timeout | failed(reason)
//!
//! ask_local_model(model, system, prompt)
//!   when: only from the explicit Ask click; never from navigation or launch
//!   pre:  model nonempty · model present in GET /api/tags right now
//!   to:   127.0.0.1:11434 · POST /api/generate · HTTP/1.0 · Connection: close
//!   body: {"model", "system", "prompt", "stream": false, "think": false,
//!          "options": {"num_ctx"}}
//!   run:  spawn_blocking · 2 s to connect · 120 s in all · input ≤ 128 KB ·
//!         response ≤ 1 MB
//!   out:  answer(text, model) | not_installed(model) | unavailable | timeout
//!         | failed(reason)
//!
//! generate_local_model_json(model, system, prompt)
//!   when: only from the Visual View build queue (a `Run Raven` click; one
//!         call per step of Raven's workflow); never from navigation,
//!         Refresh or launch
//!   pre:  as ask
//!   to:   as ask, plus "format": "json"; both request direct answers with
//!         "think": false so hidden reasoning cannot consume the deadline
//!   run:  spawn_blocking · 2 s to connect · 600 s in all · num_ctx 16384 ·
//!         input ≤ 128 KB · response ≤ 1 MB
//!   out:  as ask
//! ```
//!
//! The frontend builds the whole input (the fixed instruction, the bounded
//! `context/` and `wiki/` files, the question) and names the model; nothing
//! here reads a file, and the only thing the model name can reach is the
//! `model` field of the JSON body sent to the fixed loopback address, after
//! it has matched a name Ollama itself listed. Nothing here logs: the input
//! and the answer never leave this process except to the local Ollama
//! socket, and the frontend records only the failure kind. Ollama is never
//! started or installed: a refused connection is reported as unavailable and
//! nothing else happens.
//!
//! HTTP/1.0 is deliberate: a 1.0 request makes Go's HTTP server answer with a
//! plain body and close the connection, so reading to end of stream is the
//! whole protocol. A chunked body is still decoded in case a different server
//! answers on that port.

use std::io::{self, ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Ollama's default listen address. Loopback only; nothing else is ever dialled.
pub const OLLAMA_ADDR: &str = "127.0.0.1:11434";
/// Whole-request bound for an ask, connect included. A small model on a
/// laptop needs well under this for a bounded prompt; anything longer is reported.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Whole-request bound for listing installed models: a local read of Ollama's own store.
pub const LIST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long to wait for the connection itself. Ollama answers at once or
/// refuses; a slow connect means something else owns the port.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// Bound on `system` plus `prompt`, above the frontend's own character
/// budget, so an oversized input is refused here too before anything is sent.
pub const MAX_INPUT_BYTES: usize = 128 * 1024;
/// Bound on the whole HTTP response, headers included.
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
/// Context window requested from Ollama, sized for the frontend budget.
pub const NUM_CTX: u32 = 8192;
/// Whole-request bound for one Visual View build call: Raven's notes are
/// several times the Wiki ask and the structured answer is long, and a
/// small model on a laptop reads and writes it at a few hundred and a few
/// dozen tokens a second. The build runs off the interaction path, so the
/// bound only decides when a stuck server is reported.
pub const VIEW_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
/// Context window for one Visual View build call: the fixed notes budget
/// (`viewEvidence.ts`, about 8,000 tokens) plus the instruction, the
/// answer and room for a model that thinks before answering.
pub const VIEW_NUM_CTX: u32 = 16384;
/// Sampling temperature for one Visual View build call. Low, so the map is
/// nearly repeatable, but not zero: at 0 and at 0.1 one real place made the
/// installed model stop its answer after the groups every time, which the
/// validator rejected; at 0.2 the same place completed on every run. Only
/// this call carries a temperature; the Wiki ask keeps the server's default.
pub const VIEW_TEMPERATURE: f32 = 0.2;

/// The one named result of an ask, as the frontend sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LocalModelResult {
    /// The model answered; `model` names what answered.
    Answer { text: String, model: String },
    /// The named model is not in Ollama's installed list right now (or no
    /// name was given): the frontend clears its selection.
    NotInstalled { model: String },
    /// Nothing accepted the connection: Ollama is stopped or not installed.
    Unavailable,
    /// The deadline passed before the answer arrived.
    Timeout,
    /// The request was refused or the answer unusable; `reason` is short and
    /// never contains the input.
    Failed { reason: String },
}

/// What listing the installed models produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelListResult {
    /// The names Ollama reports as installed, in Ollama's order; may be empty.
    Models {
        names: Vec<String>,
    },
    Unavailable,
    Timeout,
    Failed {
        reason: String,
    },
}

/// Why an exchange with the local server produced no usable response.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Fault {
    Unavailable,
    Timeout,
    Failed(String),
}

impl From<Fault> for LocalModelResult {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Unavailable => LocalModelResult::Unavailable,
            Fault::Timeout => LocalModelResult::Timeout,
            Fault::Failed(reason) => LocalModelResult::Failed { reason },
        }
    }
}

impl From<Fault> for ModelListResult {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Unavailable => ModelListResult::Unavailable,
            Fault::Timeout => ModelListResult::Timeout,
            Fault::Failed(reason) => ModelListResult::Failed { reason },
        }
    }
}

#[derive(Serialize)]
struct Options {
    num_ctx: u32,
    /// Sampling temperature; sent only for the JSON shape, where a factual
    /// answer should not vary from run to run.
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Serialize)]
struct Request<'a> {
    model: &'a str,
    system: &'a str,
    prompt: &'a str,
    stream: bool,
    options: Options,
    /// `"json"` for a structured answer; absent for the Wiki ask.
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'a str>,
    /// Both workflows request direct answers. Hidden reasoning can consume
    /// the Wiki deadline without returning text, or swallow a JSON answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    think: Option<bool>,
}

/// How one generate call is shaped beyond its text: the context window and
/// whether the answer must be JSON.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    pub num_ctx: u32,
    pub json: bool,
    /// Sampling temperature to request, or none for the server's default.
    pub temperature: Option<f32>,
}

/// The Wiki ask's shape: plain text in the default window.
pub const ASK_SHAPE: Shape = Shape {
    num_ctx: NUM_CTX,
    json: false,
    temperature: None,
};
/// The Visual View build's shape: JSON in the larger window, at the lowest
/// temperature that reliably completes an answer.
pub const VIEW_SHAPE: Shape = Shape {
    num_ctx: VIEW_NUM_CTX,
    json: true,
    temperature: Some(VIEW_TEMPERATURE),
};

fn failed(reason: impl Into<String>) -> Fault {
    Fault::Failed(reason.into())
}

fn is_timeout(e: &io::Error) -> bool {
    matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
}

/// Read the whole response within what is left of the deadline, at most
/// `MAX_RESPONSE_BYTES`. The server closes the connection when it is done.
fn read_all(stream: &mut TcpStream, start: Instant, timeout: Duration) -> Result<Vec<u8>, Fault> {
    let mut body = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let remaining = timeout.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            return Err(Fault::Timeout);
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|e| failed(format!("socket: {}", e.kind())))?;
        match stream.read(&mut buf) {
            Ok(0) => return Ok(body),
            Ok(n) => {
                if body.len() + n > MAX_RESPONSE_BYTES {
                    return Err(failed("response too large"));
                }
                body.extend_from_slice(&buf[..n]);
            }
            Err(e) if is_timeout(&e) => return Err(Fault::Timeout),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(failed(format!("read: {}", e.kind()))),
        }
    }
}

/// Decode an HTTP/1.1 chunked body. Not expected from Ollama (the request is
/// HTTP/1.0) but cheap to handle rather than hand the model's JSON back
/// garbled.
fn dechunk(raw: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut at = 0;
    loop {
        let line_end = raw[at..].windows(2).position(|w| w == b"\r\n")? + at;
        let size_text = std::str::from_utf8(&raw[at..line_end]).ok()?;
        let size_text = size_text.split(';').next()?.trim();
        let size = usize::from_str_radix(size_text, 16).ok()?;
        at = line_end + 2;
        if size == 0 {
            return Some(out);
        }
        let chunk = raw.get(at..at + size)?;
        out.extend_from_slice(chunk);
        at += size;
        if raw.get(at..at + 2)? != b"\r\n" {
            return None;
        }
        at += 2;
    }
}

/// Split a raw HTTP response into its status code and body.
fn parse_response(raw: &[u8]) -> Result<(u16, Vec<u8>), Fault> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| failed("malformed response"))?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| failed("malformed response"))?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| failed("malformed response"))?;
    let chunked = lines.any(|l| {
        let mut parts = l.splitn(2, ':');
        parts
            .next()
            .map(|k| k.trim().eq_ignore_ascii_case("transfer-encoding"))
            == Some(true)
            && parts
                .next()
                .map(|v| v.to_ascii_lowercase().contains("chunked"))
                == Some(true)
    });
    let body = &raw[split + 4..];
    let body = if chunked {
        dechunk(body).ok_or_else(|| failed("malformed response"))?
    } else {
        body.to_vec()
    };
    Ok((code, body))
}

/// The `error` field of an Ollama error body, or `HTTP <code>`.
fn error_reason(code: u16, body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error")?.as_str().map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.chars().take(200).collect())
        .unwrap_or_else(|| format!("HTTP {}", code))
}

/// One HTTP/1.0 exchange with the local server: connect, send `method
/// path` with an optional JSON body, read to end of stream, parse. The path
/// is one of this module's two fixed strings; nothing from the frontend
/// reaches the request line.
fn exchange(
    addr: &str,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    timeout: Duration,
) -> Result<(u16, Vec<u8>), Fault> {
    let socket: SocketAddr = addr.parse().map_err(|_| failed("bad address"))?;
    let start = Instant::now();
    let mut stream = TcpStream::connect_timeout(&socket, CONNECT_TIMEOUT.min(timeout))
        .map_err(|_| Fault::Unavailable)?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|_| failed("socket"))?;
    let mut head = format!(
        "{} {} HTTP/1.0\r\nHost: {}\r\nConnection: close\r\n",
        method, path, addr
    );
    if let Some(body) = body {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    head.push_str("\r\n");
    let written = stream
        .write_all(head.as_bytes())
        .and_then(|_| body.map_or(Ok(()), |b| stream.write_all(b)));
    if let Err(e) = written {
        return Err(if is_timeout(&e) {
            Fault::Timeout
        } else {
            failed(format!("write: {}", e.kind()))
        });
    }
    let raw = read_all(&mut stream, start, timeout)?;
    parse_response(&raw)
}

/// The installed model names as Ollama at `addr` reports them right now
/// (`GET /api/tags`). Blocking; never panics on what the socket returns.
pub fn list_models(addr: &str, timeout: Duration) -> ModelListResult {
    match list(addr, timeout) {
        Ok(names) => ModelListResult::Models { names },
        Err(fault) => fault.into(),
    }
}

fn list(addr: &str, timeout: Duration) -> Result<Vec<String>, Fault> {
    let (code, body) = exchange(addr, "GET", "/api/tags", None, timeout)?;
    if code != 200 {
        return Err(failed(error_reason(code, &body)));
    }
    let value: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| failed("malformed model list"))?;
    let models = value
        .get("models")
        .and_then(|m| m.as_array())
        .ok_or_else(|| failed("malformed model list"))?;
    Ok(models
        .iter()
        .filter_map(|m| m.get("name")?.as_str())
        .filter(|n| !n.trim().is_empty())
        .map(|n| n.to_string())
        .collect())
}

/// Ask `model` at `addr` once and wait for its whole answer, after checking
/// that `model` is a nonempty name Ollama lists as installed right now.
/// Blocking; the Tauri command runs it on `spawn_blocking`. Never panics on
/// what the socket returns and never reports the input back in a reason.
pub fn ask(
    addr: &str,
    model: &str,
    system: &str,
    prompt: &str,
    timeout: Duration,
) -> LocalModelResult {
    generate(addr, model, system, prompt, timeout, ASK_SHAPE)
}

/// One generate call in the given `shape`; `ask` is the plain-text case and
/// the Visual View build the JSON case. Same checks, same fixed address,
/// same two fixed paths.
pub fn generate(
    addr: &str,
    model: &str,
    system: &str,
    prompt: &str,
    timeout: Duration,
    shape: Shape,
) -> LocalModelResult {
    if model.trim().is_empty() {
        return LocalModelResult::NotInstalled {
            model: String::new(),
        };
    }
    if system.len() + prompt.len() > MAX_INPUT_BYTES {
        return LocalModelResult::Failed {
            reason: "input too large".to_string(),
        };
    }
    let start = Instant::now();
    let installed = match list(addr, LIST_TIMEOUT.min(timeout)) {
        Ok(names) => names,
        Err(fault) => return fault.into(),
    };
    if !installed.iter().any(|n| n == model) {
        return LocalModelResult::NotInstalled {
            model: model.to_string(),
        };
    }
    let body = match serde_json::to_vec(&Request {
        model,
        system,
        prompt,
        stream: false,
        options: Options {
            num_ctx: shape.num_ctx,
            temperature: shape.temperature,
        },
        format: if shape.json { Some("json") } else { None },
        think: Some(false),
    }) {
        Ok(body) => body,
        Err(_) => {
            return LocalModelResult::Failed {
                reason: "cannot encode request".to_string(),
            }
        }
    };
    let remaining = timeout.saturating_sub(start.elapsed());
    let (code, body) = match exchange(addr, "POST", "/api/generate", Some(&body), remaining) {
        Ok(parts) => parts,
        Err(fault) => return fault.into(),
    };
    if code != 200 {
        return LocalModelResult::Failed {
            reason: error_reason(code, &body),
        };
    }
    let value: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return LocalModelResult::Failed {
                reason: "malformed answer".to_string(),
            }
        }
    };
    match value.get("response").and_then(|r| r.as_str()) {
        Some(text) => LocalModelResult::Answer {
            text: text.to_string(),
            model: model.to_string(),
        },
        None => LocalModelResult::Failed {
            reason: "malformed answer".to_string(),
        },
    }
}

#[cfg(test)]
#[path = "local_model_tests.rs"]
mod tests;
