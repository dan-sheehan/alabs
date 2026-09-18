use super::*;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

/// A fake Ollama on a loopback port: answers every connection through
/// `reply(path, body)` until the test ends, closing each connection after
/// its response, and keeps every request it saw.
/// Every request the fake saw: its path and body.
type Seen = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

struct Fake {
    addr: String,
    seen: Seen,
}

impl Fake {
    fn paths(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|(p, _)| p.clone())
            .collect()
    }

    fn generate_body(&self) -> serde_json::Value {
        let seen = self.seen.lock().unwrap();
        let (_, body) = seen
            .iter()
            .find(|(p, _)| p == "/api/generate")
            .expect("a generate request");
        serde_json::from_slice(body).unwrap()
    }
}

fn fake(reply: impl Fn(&str, &[u8]) -> Vec<u8> + Send + Sync + 'static) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                request.extend_from_slice(&buf[..n]);
                if let Some(split) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&request[..split]).to_string();
                    let len: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("Content-Length: "))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    if request.len() >= split + 4 + len {
                        break;
                    }
                }
            }
            let split = request
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .unwrap_or(request.len());
            let head = String::from_utf8_lossy(&request[..split]).to_string();
            let path = head
                .lines()
                .next()
                .unwrap_or("")
                .split_whitespace()
                .nth(1)
                .unwrap_or("")
                .to_string();
            let body = request.get(split + 4..).unwrap_or(&[]).to_vec();
            log.lock().unwrap().push((path.clone(), body.clone()));
            let _ = stream.write_all(&reply(&path, &body));
        }
    });
    Fake { addr, seen }
}

fn http(status: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.0 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        status,
        body.len(),
        body
    )
    .into_bytes()
}

fn tags(names: &[&str]) -> String {
    let models: Vec<String> = names
        .iter()
        .map(|n| format!("{{\"name\":\"{}\",\"size\":1}}", n))
        .collect();
    format!("{{\"models\":[{}]}}", models.join(","))
}

/// A working Ollama with `names` installed that answers every generate with `answer`.
fn ollama(names: &'static [&'static str], answer: &'static str) -> Fake {
    fake(move |path, _| match path {
        "/api/tags" => http("200 OK", &tags(names)),
        "/api/generate" => http(
            "200 OK",
            &format!(
                "{{\"model\":\"m\",\"response\":\"{}\",\"done\":true}}",
                answer
            ),
        ),
        _ => http("404 Not Found", "{}"),
    })
}

fn unlistened() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    drop(listener);
    addr
}

const FIVE: Duration = Duration::from_secs(5);

#[test]
fn no_model_name_is_written_into_the_implementation() {
    let source = include_str!("local_model.rs");
    assert!(!source.contains("LOCAL_MODEL"), "no model constant");
    // Family names as whole tokens (so `Ollama` in prose does not count).
    let lower = source.to_lowercase();
    for token in lower.split(|c: char| !c.is_ascii_alphanumeric()) {
        for word in ["llama", "gemma", "qwen", "mistral", "deepseek"] {
            assert!(
                !token.starts_with(word),
                "found {} in token {}",
                word,
                token
            );
        }
    }
    // No Ollama-style `name:tag` string literal anywhere in the module.
    let literals = source.split('"').skip(1).step_by(2);
    for lit in literals {
        let looks_like_model = lit.split(':').count() == 2
            && lit.ends_with('b')
            && lit
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '-' | '_'));
        assert!(
            !looks_like_model,
            "string literal looks like a model name: {}",
            lit
        );
    }
}

#[test]
fn installed_models_are_listed_in_ollamas_order() {
    let f = ollama(&["small:1b", "big:7b", "embed:latest"], "x");
    assert_eq!(
        list_models(&f.addr, FIVE),
        ModelListResult::Models {
            names: vec!["small:1b".into(), "big:7b".into(), "embed:latest".into()]
        }
    );
    assert_eq!(f.paths(), vec!["/api/tags"]);
}

#[test]
fn listing_is_one_http_1_0_get_with_no_body() {
    let f = ollama(&[], "x");
    list_models(&f.addr, FIVE);
    let seen = f.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert!(seen[0].1.is_empty());
}

#[test]
fn no_installed_models_is_an_empty_list_not_a_failure() {
    let f = ollama(&[], "x");
    assert_eq!(
        list_models(&f.addr, FIVE),
        ModelListResult::Models { names: vec![] }
    );
    let f = fake(|_, _| http("200 OK", "{\"models\":[{\"name\":\"\"},{\"size\":3}]}"));
    assert_eq!(
        list_models(&f.addr, FIVE),
        ModelListResult::Models { names: vec![] }
    );
}

#[test]
fn listing_reports_unavailable_timeout_and_an_unusable_list() {
    assert_eq!(
        list_models(&unlistened(), FIVE),
        ModelListResult::Unavailable
    );
    let f = fake(|_, _| {
        thread::sleep(Duration::from_millis(500));
        http("200 OK", "{\"models\":[]}")
    });
    assert_eq!(
        list_models(&f.addr, Duration::from_millis(150)),
        ModelListResult::Timeout
    );
    let f = fake(|_, _| http("200 OK", "not json"));
    assert_eq!(
        list_models(&f.addr, FIVE),
        ModelListResult::Failed {
            reason: "malformed model list".into()
        }
    );
    let f = fake(|_, _| http("500 Internal Server Error", "{\"error\":\"broken\"}"));
    assert_eq!(
        list_models(&f.addr, FIVE),
        ModelListResult::Failed {
            reason: "broken".into()
        }
    );
}

#[test]
fn a_selected_installed_model_is_checked_against_the_list_then_used_exactly() {
    let f = ollama(&["small:1b", "big:7b"], "Danny lives in Sydney.");
    let result = ask(
        &f.addr,
        "big:7b",
        "be brief",
        "=== QUESTION ===\nwhere?",
        FIVE,
    );
    assert_eq!(
        result,
        LocalModelResult::Answer {
            text: "Danny lives in Sydney.".to_string(),
            model: "big:7b".to_string()
        }
    );
    assert_eq!(f.paths(), vec!["/api/tags", "/api/generate"]);
    let body = f.generate_body();
    assert_eq!(body["model"], "big:7b");
    assert_eq!(body["system"], "be brief");
    assert_eq!(body["prompt"], "=== QUESTION ===\nwhere?");
    assert_eq!(body["stream"], false);
    assert_eq!(body["options"]["num_ctx"], NUM_CTX);
    assert_eq!(
        body["options"].as_object().unwrap().len(),
        1,
        "no temperature for the ask"
    );
    assert_eq!(
        body["think"], false,
        "bounded Wiki answers must not spend their deadline on hidden reasoning"
    );
    assert_eq!(
        body.as_object().unwrap().len(),
        6,
        "only the five input fields plus think are sent"
    );
}

#[test]
fn an_uninstalled_model_is_refused_before_anything_is_generated() {
    let f = ollama(&["small:1b"], "never");
    assert_eq!(
        ask(&f.addr, "big:7b", "s", "p", FIVE),
        LocalModelResult::NotInstalled {
            model: "big:7b".into()
        }
    );
    // Names match exactly: no prefix, case or whitespace leniency.
    assert_eq!(
        ask(&f.addr, "small", "s", "p", FIVE),
        LocalModelResult::NotInstalled {
            model: "small".into()
        }
    );
    assert_eq!(
        ask(&f.addr, "SMALL:1B", "s", "p", FIVE),
        LocalModelResult::NotInstalled {
            model: "SMALL:1B".into()
        }
    );
    assert_eq!(
        ask(&f.addr, " small:1b", "s", "p", FIVE),
        LocalModelResult::NotInstalled {
            model: " small:1b".into()
        }
    );
    assert_eq!(
        f.paths(),
        vec!["/api/tags"; 4],
        "only the list was ever read"
    );
}

#[test]
fn an_empty_model_is_refused_without_dialling() {
    assert_eq!(
        ask(&unlistened(), "", "s", "p", FIVE),
        LocalModelResult::NotInstalled {
            model: String::new()
        }
    );
    assert_eq!(
        ask(&unlistened(), "   ", "s", "p", FIVE),
        LocalModelResult::NotInstalled {
            model: String::new()
        }
    );
}

#[test]
fn a_model_name_cannot_change_where_or_what_is_requested() {
    // A hostile name is only ever compared with the list; it never reaches a
    // request line and nothing is generated for it.
    let f = ollama(&["small:1b"], "never");
    let hostile = "small:1b HTTP/1.1\r\nHost: evil\r\n\r\nGET /admin";
    assert_eq!(
        ask(&f.addr, hostile, "s", "p", FIVE),
        LocalModelResult::NotInstalled {
            model: hostile.into()
        }
    );
    assert_eq!(f.paths(), vec!["/api/tags"]);
}

#[test]
fn nothing_listening_is_unavailable_for_an_ask_too() {
    assert_eq!(
        ask(&unlistened(), "m", "s", "p", FIVE),
        LocalModelResult::Unavailable
    );
}

#[test]
fn a_refused_generate_is_the_named_failure_from_ollama() {
    let f = fake(|path, _| match path {
        "/api/tags" => http("200 OK", &tags(&["m:1b"])),
        _ => http("404 Not Found", "{\"error\":\"model 'm:1b' not found\"}"),
    });
    assert_eq!(
        ask(&f.addr, "m:1b", "s", "p", FIVE),
        LocalModelResult::Failed {
            reason: "model 'm:1b' not found".into()
        }
    );
    let f = fake(|path, _| match path {
        "/api/tags" => http("200 OK", &tags(&["m:1b"])),
        _ => b"HTTP/1.0 500 Internal Server Error\r\n\r\nboom".to_vec(),
    });
    assert_eq!(
        ask(&f.addr, "m:1b", "s", "p", FIVE),
        LocalModelResult::Failed {
            reason: "HTTP 500".into()
        }
    );
}

#[test]
fn an_unusable_answer_is_a_failure_not_a_panic() {
    for reply in ["not json", "{\"done\":true}"] {
        let f = fake(move |path, _| match path {
            "/api/tags" => http("200 OK", &tags(&["m:1b"])),
            _ => http("200 OK", reply),
        });
        assert_eq!(
            ask(&f.addr, "m:1b", "s", "p", FIVE),
            LocalModelResult::Failed {
                reason: "malformed answer".into()
            }
        );
    }
    let f = fake(|_, _| b"garbage with no header break".to_vec());
    assert_eq!(
        ask(&f.addr, "m:1b", "s", "p", FIVE),
        LocalModelResult::Failed {
            reason: "malformed response".into()
        }
    );
}

#[test]
fn a_chunked_body_is_decoded() {
    let f = fake(|path, _| {
        match path {
        "/api/tags" => http("200 OK", &tags(&["m:1b"])),
        _ => b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n{\"response\":\"ok\"\r\n1\r\n}\r\n0\r\n\r\n".to_vec(),
    }
    });
    assert_eq!(
        ask(&f.addr, "m:1b", "", "q", FIVE),
        LocalModelResult::Answer {
            text: "ok".to_string(),
            model: "m:1b".to_string()
        }
    );
}

#[test]
fn a_generate_that_never_answers_is_a_timeout_within_the_one_deadline() {
    let f = fake(|path, _| match path {
        "/api/tags" => http("200 OK", &tags(&["m:1b"])),
        _ => {
            thread::sleep(Duration::from_millis(600));
            http("200 OK", "{\"response\":\"late\"}")
        }
    });
    let start = Instant::now();
    assert_eq!(
        ask(&f.addr, "m:1b", "s", "p", Duration::from_millis(200)),
        LocalModelResult::Timeout
    );
    assert!(start.elapsed() < Duration::from_millis(550));
}

#[test]
fn an_oversized_answer_is_refused() {
    let f = fake(|path, _| match path {
        "/api/tags" => http("200 OK", &tags(&["m:1b"])),
        _ => {
            let mut out = b"HTTP/1.0 200 OK\r\n\r\n{\"response\":\"".to_vec();
            out.extend(std::iter::repeat_n(b'x', MAX_RESPONSE_BYTES + 1));
            out
        }
    });
    assert_eq!(
        ask(&f.addr, "m:1b", "s", "p", FIVE),
        LocalModelResult::Failed {
            reason: "response too large".into()
        }
    );
}

#[test]
fn an_oversized_input_is_refused_before_anything_is_dialled() {
    let prompt = "x".repeat(MAX_INPUT_BYTES + 1);
    // Nothing listens at the address; an attempt would come back unavailable.
    assert_eq!(
        ask(&unlistened(), "m:1b", "", &prompt, FIVE),
        LocalModelResult::Failed {
            reason: "input too large".into()
        }
    );
}

#[test]
fn a_reason_is_bounded_and_never_the_input() {
    let f = fake(|path, _| match path {
        "/api/tags" => http("200 OK", &tags(&["m:1b"])),
        _ => http(
            "400 Bad Request",
            &format!("{{\"error\":\"{}\"}}", "e".repeat(1000)),
        ),
    });
    match ask(&f.addr, "m:1b", "secret system", "secret prompt", FIVE) {
        LocalModelResult::Failed { reason } => {
            assert_eq!(reason.len(), 200);
            assert!(!reason.contains("secret"));
        }
        other => panic!("{:?}", other),
    }
}

#[test]
fn the_results_serialize_with_the_kind_tags_the_frontend_reads() {
    let json = serde_json::to_string(&LocalModelResult::Answer {
        text: "a".to_string(),
        model: "m".to_string(),
    })
    .unwrap();
    assert_eq!(json, "{\"kind\":\"answer\",\"text\":\"a\",\"model\":\"m\"}");
    assert_eq!(
        serde_json::to_string(&LocalModelResult::NotInstalled { model: "m".into() }).unwrap(),
        "{\"kind\":\"not_installed\",\"model\":\"m\"}"
    );
    assert_eq!(
        serde_json::to_string(&LocalModelResult::Unavailable).unwrap(),
        "{\"kind\":\"unavailable\"}"
    );
    assert_eq!(
        serde_json::to_string(&LocalModelResult::Timeout).unwrap(),
        "{\"kind\":\"timeout\"}"
    );
    assert_eq!(
        serde_json::to_string(&LocalModelResult::Failed { reason: "x".into() }).unwrap(),
        "{\"kind\":\"failed\",\"reason\":\"x\"}"
    );
    assert_eq!(
        serde_json::to_string(&ModelListResult::Models {
            names: vec!["a".into()]
        })
        .unwrap(),
        "{\"kind\":\"models\",\"names\":[\"a\"]}"
    );
    assert_eq!(
        serde_json::to_string(&ModelListResult::Unavailable).unwrap(),
        "{\"kind\":\"unavailable\"}"
    );
}

#[test]
fn the_constants_are_the_documented_ones() {
    assert_eq!(OLLAMA_ADDR, "127.0.0.1:11434");
    assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(120));
    assert_eq!(LIST_TIMEOUT, Duration::from_secs(10));
    assert_eq!(MAX_INPUT_BYTES, 128 * 1024);
    assert_eq!(NUM_CTX, 8192);
}

#[test]
fn a_visual_view_build_call_adds_only_the_json_shape_to_the_same_request() {
    let f = ollama(&["small:1b"], "{}");
    let result = generate(&f.addr, "small:1b", "rules", "evidence", FIVE, VIEW_SHAPE);
    assert_eq!(
        result,
        LocalModelResult::Answer {
            text: "{}".to_string(),
            model: "small:1b".to_string()
        }
    );
    assert_eq!(
        f.paths(),
        vec!["/api/tags", "/api/generate"],
        "the installed list is still checked first"
    );
    let body = f.generate_body();
    assert_eq!(body["model"], "small:1b");
    assert_eq!(body["system"], "rules");
    assert_eq!(body["prompt"], "evidence");
    assert_eq!(body["stream"], false);
    assert_eq!(body["options"]["num_ctx"], VIEW_NUM_CTX);
    assert_eq!(body["options"]["temperature"], VIEW_TEMPERATURE);
    let temperature = VIEW_SHAPE
        .temperature
        .expect("a temperature for the view shape");
    assert!(temperature > 0.0 && temperature <= 0.2, "low but not zero");
    assert_eq!(body["options"].as_object().unwrap().len(), 2);
    assert_eq!(body["format"], "json");
    assert_eq!(body["think"], false);
    assert_eq!(
        body.as_object().unwrap().len(),
        7,
        "exactly the five fields plus format and think"
    );
}

#[test]
fn the_json_shape_keeps_every_refusal_of_the_plain_ask() {
    assert_eq!(
        generate(&unlistened(), "", "s", "p", FIVE, VIEW_SHAPE),
        LocalModelResult::NotInstalled {
            model: String::new()
        }
    );
    assert_eq!(
        generate(&unlistened(), "small:1b", "s", "p", FIVE, VIEW_SHAPE),
        LocalModelResult::Unavailable
    );
    let f = ollama(&["small:1b"], "never");
    assert_eq!(
        generate(&f.addr, "big:7b", "s", "p", FIVE, VIEW_SHAPE),
        LocalModelResult::NotInstalled {
            model: "big:7b".into()
        }
    );
    assert_eq!(f.paths(), vec!["/api/tags"]);
    let too_big = "x".repeat(MAX_INPUT_BYTES + 1);
    assert_eq!(
        generate(&f.addr, "small:1b", "", &too_big, FIVE, VIEW_SHAPE),
        LocalModelResult::Failed {
            reason: "input too large".into()
        }
    );
}

#[test]
fn the_view_shape_is_larger_and_longer_than_the_ask_and_neither_names_a_model() {
    assert_eq!(
        ASK_SHAPE,
        Shape {
            num_ctx: NUM_CTX,
            json: false,
            temperature: None
        }
    );
    assert_eq!(
        VIEW_SHAPE,
        Shape {
            num_ctx: VIEW_NUM_CTX,
            json: true,
            temperature: Some(VIEW_TEMPERATURE)
        }
    );
    let (view, ask) = (VIEW_SHAPE, ASK_SHAPE);
    assert!(view.num_ctx > ask.num_ctx);
    assert!(VIEW_REQUEST_TIMEOUT > REQUEST_TIMEOUT);
    assert_eq!(VIEW_REQUEST_TIMEOUT, Duration::from_secs(600));
    assert_eq!(view.num_ctx, 16384);
}
