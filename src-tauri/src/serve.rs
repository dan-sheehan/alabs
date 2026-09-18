//! The browser front door: one local process holding one alabs root open, for
//! one Chrome session. Like `desktop.rs` this file only wires things up. Every
//! filesystem rule, path check and limit stays in the shared core above it.
//!
//! What this file does own is the boundary around that core, because the
//! transport is now a socket rather than an IPC channel:
//!
//!   * one address, `127.0.0.1:43821`, refused rather than moved when taken;
//!   * one random launch credential, required on every operation;
//!   * exact `Host` and `Origin` checks, so nothing else on the machine can
//!     reach an operation through a page the user happens to have open;
//!   * one explicitly named route per operation. There is no route that takes
//!     a command name, so a page cannot reach an operation this file does not
//!     list.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{from_fn, from_fn_with_state, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedRwLockReadGuard, RwLock};
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use super::{git, local_model, recovery, view_files, FileStamp, Subject, SubjectRoot};

/// The one address alabs serves on. Fixed so the `Host` and `Origin` checks
/// below are an exact string comparison rather than a policy, and so a second
/// alabs cannot quietly appear on another port.
pub(crate) const ADDR: &str = "127.0.0.1:43821";
pub(crate) const ORIGIN: &str = "http://127.0.0.1:43821";

/// The header carrying the launch credential. A custom name is deliberate: a
/// cross-origin page cannot send one without a preflight, and no preflight is
/// ever answered.
pub(crate) const CREDENTIAL_HEADER: &str = "x-alabs-credential";

/// The header naming which editing session a request belongs to: one open
/// alabs page. Unlike the credential it is not a secret and admits nothing —
/// every request already had to carry the credential to get this far. It says
/// *which* admitted page is asking, which is what the one-writer rule and the
/// recovery records are about.
pub(crate) const SESSION_HEADER: &str = "x-alabs-session";

/// Longest session name accepted, and the characters one may contain. Bounded
/// because it is written into recovery records on disk.
const MAX_SESSION_CHARS: usize = 64;

/// Where the browser runtime keeps its own state. Deliberately not the
/// desktop application's folder (`me.dannysheehan.alabs`): the two runtimes
/// must never read or overwrite each other's state, and a browser recovery
/// file has to survive the desktop application being used on the same root.
const STATE_FOLDER: &str = "alabs-browser";

/// Largest request body accepted.
///
/// This is the transport's bound, not a policy: the core's own caps — 2 MB
/// for a file, 2 MB for a draft, 1 MB for the layout — are what actually
/// decide, and they are checked whatever arrives. It only has to be
/// comfortably larger than the biggest thing a single operation may carry, so
/// that a file alabs will open is never a file alabs cannot save.
///
/// The biggest is one 2 MB file's text as JSON. Escaping can grow that: a
/// control character becomes six characters, so the worst case is six times
/// the file. 16 MB clears that with room to spare and still refuses a body
/// nothing in alabs could have meant to send.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

/// Most operations running at once. Beyond this a request waits for a permit
/// rather than starting another walk of the disk; the request timeout below
/// is what stops it waiting forever.
const MAX_CONCURRENT: usize = 16;

/// Most search walks running at once.
///
/// A search is the one operation that outlives the request that started it:
/// its answer streams, so the handler returns as soon as the first byte can
/// go out and the walk carries on behind it. The request permit above is
/// released at that moment, so without this a walk would be bounded only by
/// "a new search cancels the old one" — true, but not a bound.
///
/// It is deliberately a second semaphore rather than more of the first.
/// Taking a request permit and then a second permit from the same semaphore
/// deadlocks the moment every permit is held by a request that is itself
/// waiting for one.
const MAX_CONCURRENT_WALKS: usize = 4;

/// Longest any one operation may take before the connection is dropped. The
/// core's own Git deadlines and file limits are shorter; this only stops a
/// request outliving the click that made it.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The content security policy for the served page. The desktop policy
/// (`tauri.conf.json`) with Tauri's IPC origins removed, `connect-src` narrowed
/// to this same origin, and framing prohibited outright.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
                   font-src 'self' data:; img-src 'self' data:; worker-src 'self' blob:; \
                   connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'; \
                   frame-ancestors 'none'; form-action 'none'";

/// The browser runtime's application data directory, the counterpart of the
/// desktop build's Tauri `app_data_dir`. Resolved from `$HOME` because no
/// Tauri `AppHandle` exists here; nothing is created until something is
/// written.
pub(crate) fn state_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "no HOME in the environment".to_string())?;
    state_dir_in(Path::new(&home))
}

/// The state folder under one home directory. Split out from `state_dir` so
/// it can be checked without changing this process's environment.
pub(crate) fn state_dir_in(home: &Path) -> Result<PathBuf, String> {
    if !home.is_absolute() {
        return Err(format!("HOME is not an absolute path: {}", home.display()));
    }
    Ok(home
        .join("Library")
        .join("Application Support")
        .join(STATE_FOLDER))
}

/// `n` bytes from the kernel, as lower-case hex.
fn random_hex(n: usize) -> Result<String, String> {
    use std::io::Read;
    let mut bytes = vec![0u8; n];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("cannot read /dev/urandom: {}", e))?;
    Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

/// A fresh launch credential: 32 bytes from the kernel, as hex. Generated
/// once per process, never written to disk and never logged.
pub(crate) fn new_credential() -> Result<String, String> {
    random_hex(32)
}

/// This process's name for itself: 16 bytes from the kernel, as hex.
///
/// It is not a second credential and nothing is admitted by it. It exists so
/// that a page can tell one `alabs-serve` lifetime from another — the same
/// server it was talking to a moment ago, or a restarted one whose editing
/// ownership and in-flight saves are gone. Recovery records carry it for the
/// same reason. Admission stays the launch credential's job, and only its.
pub(crate) fn new_server_id() -> Result<String, String> {
    random_hex(16)
}

/// Compare two credentials without letting the time taken describe how much
/// of a guess was right.
pub(crate) fn credential_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    // `new_credential` never produces an empty one, so this cannot happen;
    // it is refused anyway so that no future path can make "no credential at
    // either end" mean "admitted".
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Which admitted page a request came from, taken from `SESSION_HEADER` and
/// carried to whichever handler needs to know. `None` when the header was
/// absent, given twice, or not a plausible session name.
#[derive(Clone, Debug)]
pub(crate) struct Session(pub(crate) Option<String>);

/// A session name is chosen by the page, so it is bounded and restricted to
/// characters that stay themselves everywhere it is written down.
pub(crate) fn session_name(given: Option<String>) -> Option<String> {
    let name = given?;
    let usable = !name.is_empty()
        && name.chars().count() <= MAX_SESSION_CHARS
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    usable.then_some(name)
}

/// The editing role: one server, one writer.
///
/// Additional pages on the same server start read-only. Taking the role is
/// always something the user asks for, never something a page does on its own
/// by being opened.
pub(crate) struct Writing {
    /// The session that may change files, or none while nobody has asked.
    holder: Mutex<Option<String>>,
    /// Held for reading by every mutation for as long as it runs, and for
    /// writing by a takeover.
    ///
    /// This is what makes "wait for in-flight mutations" true rather than
    /// hopeful. A takeover cannot complete while a save that started before it
    /// is still on the disk, and a save that arrives while a takeover is under
    /// way waits for it and then finds the new holder — so it is refused,
    /// rather than committing under an ownership check it passed a moment
    /// before the role changed hands.
    gate: Arc<RwLock<()>>,
}

impl Writing {
    /// Take the role when it is free, or confirm a session that already has
    /// it. `None` when somebody else holds it.
    fn claim_free(&self, session: &str) -> Option<Writer> {
        let mut holder = self.holder.lock().ok()?;
        match holder.as_deref() {
            Some(held) if held != session => None,
            _ => {
                *holder = Some(session.to_string());
                Some(Writer {
                    writing: true,
                    holder: Some(session.to_string()),
                })
            }
        }
    }

    /// Hand the role to `session`, whoever had it. Only ever called with the
    /// takeover gate held.
    fn give_to(&self, session: &str) {
        if let Ok(mut holder) = self.holder.lock() {
            *holder = Some(session.to_string());
        }
    }

    /// Give the role up, but only for the session that actually holds it.
    fn release(&self, session: &str) -> Writer {
        if let Ok(mut holder) = self.holder.lock() {
            if holder.as_deref() == Some(session) {
                *holder = None;
            }
            return Writer {
                writing: false,
                holder: holder.clone(),
            };
        }
        Writer {
            writing: false,
            holder: None,
        }
    }

    /// Who holds the role, from `session`'s point of view.
    fn status(&self, session: Option<&str>) -> Writer {
        let holder = self.holder.lock().ok().and_then(|h| h.clone());
        Writer {
            writing: holder.is_some() && holder.as_deref() == session,
            holder,
        }
    }

    fn held_by(&self, session: &str) -> bool {
        self.holder
            .lock()
            .map(|h| h.as_deref() == Some(session))
            .unwrap_or(false)
    }
}

/// Everything one running server owns. The root is opened once, before
/// anything is served: a root that cannot be opened is a failure to launch,
/// never a state the running server can reach.
pub(crate) struct Server {
    pub(crate) subject: Subject,
    pub(crate) state_dir: PathBuf,
    pub(crate) credential: String,
    /// This process's name for itself; see `new_server_id`.
    pub(crate) server_id: String,
    /// Built application assets. Only this folder is ever served as a web
    /// resource; nothing inside the alabs root is.
    pub(crate) assets: PathBuf,
    /// Who may change files right now.
    pub(crate) writing: Writing,
    /// How many operations may run at once. Held across the whole handler, so
    /// the cap counts work on the disk, not connections.
    permits: tokio::sync::Semaphore,
    /// Held by inference itself, including after request cancellation.
    models: Arc<tokio::sync::Semaphore>,
    /// How many search walks may run at once. Held by the walk itself, for as
    /// long as it is on the disk — which is longer than the request that
    /// started it (`MAX_CONCURRENT_WALKS`).
    pub(crate) walks: Arc<tokio::sync::Semaphore>,
}

impl Server {
    /// Open `path` as this process's alabs root, keeping this runtime's state
    /// in the folder `state_dir()` names.
    pub(crate) fn open(path: &Path, assets: PathBuf) -> Result<Self, String> {
        Self::open_in(path, assets, state_dir()?)
    }

    /// The same, with the state folder given rather than read from the
    /// environment. `serve_main` uses `open`; tests use this so nothing they
    /// do can reach the real browser state, least of all its recovery drafts.
    pub(crate) fn open_in(
        path: &Path,
        assets: PathBuf,
        state_dir: PathBuf,
    ) -> Result<Self, String> {
        let root = SubjectRoot::open(path)?;
        if let Some(err) =
            super::state_dir_conflict(&root.path, &super::canonical_projection(&state_dir))
        {
            return Err(err);
        }
        if !assets.join("index.html").is_file() {
            return Err(format!(
                "no built browser assets at {} (run `npm run browser`)",
                assets.display()
            ));
        }
        let subject = Subject::default();
        subject.replace_root(root)?;
        Ok(Server {
            subject,
            state_dir,
            credential: new_credential()?,
            server_id: new_server_id()?,
            assets,
            writing: Writing {
                holder: Mutex::new(None),
                gate: Arc::new(RwLock::new(())),
            },
            permits: tokio::sync::Semaphore::new(MAX_CONCURRENT),
            models: Arc::new(tokio::sync::Semaphore::new(1)),
            walks: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_WALKS)),
        })
    }

    /// Where this server keeps recovery drafts.
    pub(crate) fn recovery_dir(&self) -> PathBuf {
        recovery::dir_in(&self.state_dir)
    }

    /// The name and canonical path of the open root, read back from the handle.
    pub(crate) fn root_info(&self) -> Result<super::SubjectInfo, String> {
        super::with_root_session(&self.subject, None, |root| {
            Ok(super::SubjectInfo {
                name: root
                    .path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| root.path.to_string_lossy().into_owned()),
                path: root.path.to_string_lossy().into_owned(),
            })
        })
    }
}

/// One refused operation, in the shape the frontend already handles: the
/// reason a native call rejected with.
#[derive(Serialize)]
struct ApiError {
    error: String,
}

/// What a handler returns: the operation's own value, or the reason it
/// refused. A refusal is a status the browser runtime turns back into a
/// rejected promise carrying exactly this reason.
type ApiResult<T> = Result<Json<T>, Refusal>;

#[derive(Debug)]
struct Refusal(StatusCode, String);

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        (self.0, Json(ApiError { error: self.1 })).into_response()
    }
}

/// An operation the core refused: the frontend shows the reason as it does on
/// the desktop.
fn refused(reason: String) -> Refusal {
    Refusal(StatusCode::UNPROCESSABLE_ENTITY, reason)
}

/// Run one blocking core operation off the request thread, the way the
/// desktop commands run theirs off the main thread.
async fn blocking<T, F>(work: F) -> Result<T, Refusal>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(reason)) => Err(refused(reason)),
        Err(e) => Err(Refusal(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("the operation did not finish: {}", e),
        )),
    }
}

/// A duplicated handle to the open root, refused if the client is carrying a
/// session from a root this process never had.
fn root_of(server: &Server, expected: Option<u64>) -> Result<SubjectRoot, String> {
    super::with_root_session(&server.subject, expected, SubjectRoot::try_clone)
}

// ---------------------------------------------------------------------------
// The operations. One route each, named here and nowhere else.
// ---------------------------------------------------------------------------

/// What the page needs before it can show anything: which root this process
/// owns, and what this runtime cannot do. The root comes from here and only
/// here, so a remembered layout can never select or replace it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    root: super::SubjectInfo,
    /// False while this runtime cannot write: the editor opens read-only and
    /// the actions that would write are refused rather than half-done.
    can_edit: bool,
    /// This `alabs-serve` lifetime's name for itself (`new_server_id`).
    ///
    /// A page compares it with the one it saw before to tell "the same server
    /// I was talking to" from "a server that has been restarted", which is the
    /// difference between an editing role and in-flight saves that still stand
    /// and ones that are gone. It admits nothing: the launch credential is
    /// still the only thing a request is admitted on.
    server_id: String,
}

async fn bootstrap(State(server): State<Arc<Server>>) -> ApiResult<Bootstrap> {
    let root = server.root_info().map_err(refused)?;
    Ok(Json(Bootstrap {
        root,
        can_edit: true,
        server_id: server.server_id.clone(),
    }))
}

// ---------------------------------------------------------------------------
// The editing role.
// ---------------------------------------------------------------------------

/// Who may change files, as an answer to whoever asked.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Writer {
    /// True when the asking session is the one that may change files.
    writing: bool,
    /// The session that holds the role, whoever is asking. Null while nobody
    /// has it.
    holder: Option<String>,
}

/// A request that has to say which page it is from, but did not.
const NO_SESSION: &str = "this page did not say which alabs window it is; reload it";

/// A mutation from a page that is not the one editing. Named plainly because
/// the page turns it back into the read-only state rather than showing it.
const NOT_WRITING: &str =
    "another alabs window is editing this root. Take over editing there or here first";

fn require_session(session: &Session) -> Result<String, Refusal> {
    session
        .0
        .clone()
        .ok_or_else(|| refused(NO_SESSION.to_string()))
}

/// Admission to change a file, checked where the change happens.
///
/// The returned guard is held for as long as the mutation runs, so a takeover
/// waits for it. The order matters and is deliberate: the gate is taken
/// **before** the holder is read, so a takeover already under way completes
/// first and this mutation then sees the new holder. Checking the holder first
/// would let a save that passed the check commit after the role had moved.
async fn writing(server: &Server, session: &Session) -> Result<OwnedRwLockReadGuard<()>, Refusal> {
    let name = require_session(session)?;
    let guard = server.writing.gate.clone().read_owned().await;
    if !server.writing.held_by(&name) {
        return Err(Refusal(StatusCode::CONFLICT, NOT_WRITING.to_string()));
    }
    Ok(guard)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claim {
    /// True for the user's explicit "take over editing"; false is the ordinary
    /// ask a page makes when it opens, which never disturbs another window.
    take_over: bool,
}

async fn claim_writing(
    State(server): State<Arc<Server>>,
    Extension(session): Extension<Session>,
    Json(args): Json<Claim>,
) -> ApiResult<Writer> {
    let name = require_session(&session)?;
    if let Some(answer) = server.writing.claim_free(&name) {
        return Ok(Json(answer));
    }
    if !args.take_over {
        // Somebody else is editing. That is a state, not a failure: this page
        // opens read-only and offers to take over.
        return Ok(Json(server.writing.status(Some(&name))));
    }
    // Every mutation that has already started finishes before the role moves,
    // and none can start while this is held.
    let _drained = server.writing.gate.write().await;
    server.writing.give_to(&name);
    Ok(Json(Writer {
        writing: true,
        holder: Some(name),
    }))
}

async fn release_writing(
    State(server): State<Arc<Server>>,
    Extension(session): Extension<Session>,
) -> ApiResult<Writer> {
    let name = require_session(&session)?;
    // Unload must drain writes just like takeover; otherwise a fresh claim
    // could start writing while the departed page's save is still running.
    let _drained = server.writing.gate.write().await;
    Ok(Json(server.writing.release(&name)))
}

async fn writing_status(
    State(server): State<Arc<Server>>,
    Extension(session): Extension<Session>,
) -> ApiResult<Writer> {
    Ok(Json(server.writing.status(session.0.as_deref())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelPath {
    rel_path: String,
    expected_session: Option<u64>,
}

async fn list_dir(
    State(server): State<Arc<Server>>,
    Json(args): Json<RelPath>,
) -> ApiResult<Vec<super::Entry>> {
    let root = root_of(&server, args.expected_session).map_err(refused)?;
    Ok(Json(
        blocking(move || super::list_entries(&root, &args.rel_path)).await?,
    ))
}

async fn entry_kind(
    State(server): State<Arc<Server>>,
    Json(args): Json<RelPath>,
) -> ApiResult<super::EntryKind> {
    let root = root_of(&server, args.expected_session).map_err(refused)?;
    Ok(Json(
        blocking(move || super::entry_kind_in(&root, &args.rel_path)).await?,
    ))
}

async fn read_file(
    State(server): State<Arc<Server>>,
    Json(args): Json<RelPath>,
) -> ApiResult<super::FileContent> {
    let root = root_of(&server, args.expected_session).map_err(refused)?;
    Ok(Json(
        blocking(move || super::read_file_in(&root, &args.rel_path)).await?,
    ))
}

async fn stat_file(
    State(server): State<Arc<Server>>,
    Json(args): Json<RelPath>,
) -> ApiResult<Option<super::FileStamp>> {
    let root = root_of(&server, args.expected_session).map_err(refused)?;
    Ok(Json(
        blocking(move || super::stat_file_in(&root, &args.rel_path)).await?,
    ))
}

#[derive(Deserialize)]
struct Place {
    place: String,
}

/// How this process asks Git anything.
///
/// `no_optional_locks` is the one difference from the desktop application: a
/// server the user is not looking at must never take a repository's index
/// lock or rewrite its index to answer a read-only question, because the same
/// repository is very likely open in their Terminal at the same moment.
fn git_env() -> git::GitEnv<'static> {
    git::GitEnv {
        program: Path::new(git::GIT_PROGRAM),
        available: git::tools_available(),
        no_optional_locks: true,
    }
}

async fn git_facts(
    State(server): State<Arc<Server>>,
    Json(args): Json<Place>,
) -> ApiResult<git::GitInspection> {
    let root = root_of(&server, None).map_err(refused)?;
    let server = server.clone();
    Ok(Json(
        blocking(move || git::inspect(&root, &args.place, &git_env(), &server.subject.git_formats))
            .await?,
    ))
}

#[derive(Deserialize)]
struct QueryArgs {
    place: String,
    query: git::GitQuery,
}

/// One change question about a work place: the handoff baseline, the change
/// listings, one side of a comparison. Same gate, same bounded helper and
/// same fixed command lines as `git_facts`; nothing here writes.
async fn git_query(
    State(server): State<Arc<Server>>,
    Json(args): Json<QueryArgs>,
) -> ApiResult<git::GitQueryResult> {
    let root = root_of(&server, None).map_err(refused)?;
    let server = server.clone();
    Ok(Json(
        blocking(move || {
            git::query(
                &root,
                &args.place,
                &git_env(),
                &server.subject.git_formats,
                &args.query,
            )
        })
        .await?,
    ))
}

/// `Open in Terminal`: `/usr/bin/open -a Terminal <path>`, the path read back
/// from the place's own handle, through the same bounded child-process helper
/// every other program alabs runs goes through. This is the whole of what the
/// browser can start: there is no route that takes a command.
async fn open_terminal(
    State(server): State<Arc<Server>>,
    Json(args): Json<Place>,
) -> ApiResult<()> {
    let root = root_of(&server, None).map_err(refused)?;
    Ok(Json(
        blocking(move || git::open_terminal(&root, &args.place, Path::new(git::OPEN_PROGRAM)))
            .await?,
    ))
}

// Explicit local-model and Visual View operations. The workflow, validation,
// rendering and sanitizing stay in the shared frontend; filesystem rules and
// model transport stay in the shared core.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewSessionArgs {
    expected_root: String,
}

async fn view_session(
    State(server): State<Arc<Server>>,
    Json(args): Json<ViewSessionArgs>,
) -> ApiResult<u64> {
    let session = super::with_root_session(&server.subject, None, |root| {
        if root.path.to_string_lossy() != args.expected_root {
            return Err("the alabs root changed while the view was being built".into());
        }
        Ok(server.subject.root_session.load(Ordering::SeqCst))
    })
    .map_err(refused)?;
    Ok(Json(session))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryArgs {
    place: String,
    expected_session: u64,
}

async fn collect_inventory(
    State(server): State<Arc<Server>>,
    Json(args): Json<InventoryArgs>,
) -> ApiResult<view_files::Inventory> {
    let root = root_of(&server, Some(args.expected_session)).map_err(refused)?;
    Ok(Json(
        blocking(move || view_files::collect_inventory(&root, &args.place)).await?,
    ))
}

async fn list_local_models() -> ApiResult<local_model::ModelListResult> {
    Ok(Json(
        blocking(|| {
            Ok(local_model::list_models(
                local_model::OLLAMA_ADDR,
                local_model::LIST_TIMEOUT,
            ))
        })
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelArgs {
    model: String,
    system: String,
    prompt: String,
    expected_session: u64,
}

/// No inference queue: a second explicit request can retry after the first
/// finishes. Holding the permit inside the worker bounds abandoned calls too.
async fn model_call(
    server: Arc<Server>,
    args: ModelArgs,
    json: bool,
) -> ApiResult<local_model::LocalModelResult> {
    let permit = server.models.clone().try_acquire_owned().map_err(|_| {
        Refusal(
            StatusCode::TOO_MANY_REQUESTS,
            "a local model request is still running; try again when it finishes".into(),
        )
    })?;
    Ok(Json(
        blocking(move || {
            let _permit = permit;
            super::with_root_session(&server.subject, Some(args.expected_session), |_| Ok(()))?;
            Ok(local_model::generate(
                local_model::OLLAMA_ADDR,
                &args.model,
                &args.system,
                &args.prompt,
                if json {
                    local_model::VIEW_REQUEST_TIMEOUT
                } else {
                    local_model::REQUEST_TIMEOUT
                },
                if json {
                    local_model::VIEW_SHAPE
                } else {
                    local_model::ASK_SHAPE
                },
            ))
        })
        .await?,
    ))
}

async fn ask_local_model(
    State(server): State<Arc<Server>>,
    Json(args): Json<ModelArgs>,
) -> ApiResult<local_model::LocalModelResult> {
    model_call(server, args, false).await
}

async fn generate_local_model_json(
    State(server): State<Arc<Server>>,
    Json(args): Json<ModelArgs>,
) -> ApiResult<local_model::LocalModelResult> {
    model_call(server, args, true).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewWriteArgs {
    expected_root: String,
    expected_session: u64,
    view_json: String,
    map_svg: String,
    replace: bool,
}

#[derive(Deserialize)]
struct PlaceViewWriteArgs {
    place: String,
    #[serde(flatten)]
    view: ViewWriteArgs,
}

async fn write_view_files(
    State(server): State<Arc<Server>>,
    Extension(session): Extension<Session>,
    Json(args): Json<PlaceViewWriteArgs>,
) -> ApiResult<()> {
    let guard = writing(&server, &session).await?;
    Ok(Json(
        blocking(move || {
            let _guard = guard;
            let v = args.view;
            super::with_root_session(&server.subject, Some(v.expected_session), |root| {
                view_files::write_view_files(
                    root,
                    &args.place,
                    &v.expected_root,
                    &v.view_json,
                    &v.map_svg,
                    v.replace,
                )
            })
        })
        .await?,
    ))
}

async fn write_root_view_files(
    State(server): State<Arc<Server>>,
    Extension(session): Extension<Session>,
    Json(v): Json<ViewWriteArgs>,
) -> ApiResult<()> {
    let guard = writing(&server, &session).await?;
    Ok(Json(
        blocking(move || {
            let _guard = guard;
            super::with_root_session(&server.subject, Some(v.expected_session), |root| {
                view_files::write_root_view_files(
                    root,
                    &v.expected_root,
                    &v.view_json,
                    &v.map_svg,
                    v.replace,
                )
            })
        })
        .await?,
    ))
}

// ---------------------------------------------------------------------------
// Search.
//
// The one operation whose answer arrives in pieces. The desktop pushes hits to
// the window as events and returns the summary from the call; here the same
// hits leave down the response body as they are found, one JSON object per
// line, and the last line is the same summary. Nothing is indexed, nothing is
// kept between calls, and no second channel is opened.
// ---------------------------------------------------------------------------

/// Hits gathered before a batch goes out, as on the desktop.
const SEARCH_BATCH: usize = 50;
/// Batches the channel holds before the walk waits for the page to catch up.
const SEARCH_QUEUE: usize = 8;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchArgs {
    query: String,
    search_id: u64,
    /// The place's root-relative folder. Required: a search never covers the
    /// whole root.
    scope: String,
    expected_session: Option<u64>,
}

/// One line of a streamed search: a batch of hits, then one summary, which is
/// always the last line. `search_id` is carried on every batch so a late
/// batch of a search the page has already replaced is dropped where it lands.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SearchLine {
    Batch {
        search_id: u64,
        results: Vec<super::SearchResult>,
    },
    Summary {
        summary: super::SearchSummary,
    },
}

/// The read end of one streamed search, as the body wants it.
struct SearchStream(tokio::sync::mpsc::Receiver<String>, Arc<AtomicBool>);

impl Drop for SearchStream {
    fn drop(&mut self) {
        // Cancellation must not wait for a matching result and a failed send:
        // a search with no matches still needs to stop when Chrome leaves.
        self.1.store(true, Ordering::SeqCst);
    }
}

impl futures_core::Stream for SearchStream {
    type Item = Result<String, std::convert::Infallible>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.get_mut().0.poll_recv(cx).map(|line| line.map(Ok))
    }
}

async fn search_subject(
    State(server): State<Arc<Server>>,
    Json(args): Json<SearchArgs>,
) -> Result<Response, Refusal> {
    let SearchArgs {
        query,
        search_id,
        scope,
        expected_session,
    } = args;
    // The scope is opened before a single byte of the answer exists, because
    // once the response has started there is no way left to say no. After
    // this, a search can only end: in hits, in nothing, or in cancellation.
    let dir = {
        let server = server.clone();
        let scope = scope.clone();
        blocking(move || {
            super::with_root_session(&server.subject, expected_session, |root| {
                // Starting a search cancels the one before it, so at most one
                // walk touches the disk at a time.
                server
                    .subject
                    .latest_search
                    .store(search_id, Ordering::SeqCst);
                super::open_scope_dir(root, &scope)
            })
        })
        .await?
    };
    // Taken before the walk starts and given up only when it stops, so the
    // work on the disk is bounded rather than the requests that asked for it.
    // A search that has to wait for a permit simply streams its first batch a
    // moment later; it is never refused for being the fifth one.
    let Ok(walk) = server.walks.clone().acquire_owned().await else {
        return Err(Refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "alabs is shutting down".to_string(),
        ));
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(SEARCH_QUEUE);
    let disconnected = Arc::new(AtomicBool::new(false));
    let gone = disconnected.clone();
    tokio::task::spawn_blocking(move || {
        // Named so it is plain that it is held here, and released only when
        // this closure ends — after the summary has gone out.
        let _walk = walk;
        // The page went away mid-search: the walk stops at the next entry,
        // exactly as a cancellation does, rather than reading the rest of a
        // folder nobody is waiting for.
        let send = |line: &SearchLine| match serde_json::to_string(line) {
            Ok(text) => {
                if tx.blocking_send(text + "\n").is_err() {
                    gone.store(true, Ordering::SeqCst);
                }
            }
            Err(_) => gone.store(true, Ordering::SeqCst),
        };
        let cancelled =
            || gone.load(Ordering::SeqCst) || !server.subject.search_is_current(search_id);
        let mut batch: Vec<super::SearchResult> = Vec::new();
        let flush = |batch: &mut Vec<super::SearchResult>| {
            if !batch.is_empty() {
                send(&SearchLine::Batch {
                    search_id,
                    results: std::mem::take(batch),
                });
            }
        };
        let mut sink = |result: super::SearchResult| {
            batch.push(result);
            if batch.len() >= SEARCH_BATCH {
                flush(&mut batch);
            }
        };
        let summary = super::search_walk(&dir, &scope, &query, &cancelled, &mut sink);
        if !summary.cancelled {
            flush(&mut batch);
        }
        send(&SearchLine::Summary { summary });
    });
    Ok((
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-ndjson"),
        )],
        Body::from_stream(SearchStream(rx, disconnected)),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelArgs {
    search_id: u64,
}

/// Stop only the named search. A cleanup arriving late must never stop a
/// newer walk, so the id has to match the one that is running.
async fn cancel_search(
    State(server): State<Arc<Server>>,
    Json(args): Json<CancelArgs>,
) -> ApiResult<()> {
    server.subject.cancel_search(args.search_id);
    Ok(Json(()))
}

async fn load_ui_state(State(server): State<Arc<Server>>) -> ApiResult<Option<String>> {
    let dir = server.state_dir.clone();
    Ok(Json(blocking(move || super::load_state_in(&dir)).await?))
}

#[derive(Deserialize)]
struct Text {
    text: String,
}

async fn save_ui_state(State(server): State<Arc<Server>>, Json(args): Json<Text>) -> ApiResult<()> {
    let dir = server.state_dir.clone();
    Ok(Json(
        blocking(move || super::save_state_in(&dir, &args.text)).await?,
    ))
}

async fn append_log(State(server): State<Arc<Server>>, Json(args): Json<Text>) -> ApiResult<()> {
    let dir = server.state_dir.clone();
    Ok(Json(
        blocking(move || super::append_log_in(&dir, &args.text)).await?,
    ))
}

// ---------------------------------------------------------------------------
// Changing files. Every one of these runs behind `writing`, and every one of
// them is the existing core operation with its existing protections: the
// stamp check, the staged temporary file, the atomic commit, the no-replace
// rename. Nothing here reimplements or relaxes any of that.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveArgs {
    rel_path: String,
    content: String,
    /// What the file looked like when this buffer last matched the disk. The
    /// core refuses the save when the file no longer looks like this — and it
    /// does so whoever holds the editing role. The two checks are independent:
    /// holding the role does not make a stale write acceptable.
    expected: FileStamp,
}

async fn save_file(
    State(server): State<Arc<Server>>,
    Extension(session): Extension<Session>,
    Json(args): Json<SaveArgs>,
) -> ApiResult<FileStamp> {
    let _writing = writing(&server, &session).await?;
    let root = root_of(&server, None).map_err(refused)?;
    Ok(Json(
        blocking(move || {
            // The disk task outlives a timed-out or disconnected request.
            let _writing = _writing;
            super::write_file_in(&root, &args.rel_path, &args.content, args.expected)
        })
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecreateArgs {
    rel_path: String,
    content: String,
}

async fn recreate_file(
    State(server): State<Arc<Server>>,
    Extension(session): Extension<Session>,
    Json(args): Json<RecreateArgs>,
) -> ApiResult<FileStamp> {
    let _writing = writing(&server, &session).await?;
    let root = root_of(&server, None).map_err(refused)?;
    Ok(Json(
        blocking(move || {
            let _writing = _writing;
            super::recreate_file_in(&root, &args.rel_path, &args.content)
        })
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateArgs {
    parent_rel: String,
    name: String,
}

async fn create_file(
    State(server): State<Arc<Server>>,
    Extension(session): Extension<Session>,
    Json(args): Json<CreateArgs>,
) -> ApiResult<String> {
    let _writing = writing(&server, &session).await?;
    let root = root_of(&server, None).map_err(refused)?;
    Ok(Json(
        blocking(move || {
            let _writing = _writing;
            super::create_in(&root, &args.parent_rel, &args.name, false)
        })
        .await?,
    ))
}

async fn create_dir(
    State(server): State<Arc<Server>>,
    Extension(session): Extension<Session>,
    Json(args): Json<CreateArgs>,
) -> ApiResult<String> {
    let _writing = writing(&server, &session).await?;
    let root = root_of(&server, None).map_err(refused)?;
    Ok(Json(
        blocking(move || {
            let _writing = _writing;
            super::create_in(&root, &args.parent_rel, &args.name, true)
        })
        .await?,
    ))
}

// ---------------------------------------------------------------------------
// Recovery.
//
// Deliberately **not** behind `writing`. A draft is the text somebody has
// already typed; keeping it safe cannot depend on who currently holds the
// editing role, or a takeover would strand the old window's unsaved work at
// exactly the moment it most needs keeping. Nothing here can change a file in
// the alabs root, so there is nothing for the role to protect.
// ---------------------------------------------------------------------------

/// Longest path a recovery record may name. It is a label inside alabs' own
/// state, never a filename, and the root-bounded operations validate it again
/// if the draft is ever opened.
const MAX_DRAFT_PATH_CHARS: usize = 1024;

fn draft_path(rel_path: &str) -> Result<String, Refusal> {
    let usable = !rel_path.is_empty()
        && rel_path.chars().count() <= MAX_DRAFT_PATH_CHARS
        && !rel_path.contains('\0');
    if !usable {
        return Err(refused(
            "that is not a path alabs can keep a draft for".to_string(),
        ));
    }
    Ok(rel_path.to_string())
}

async fn recovery_list(State(server): State<Arc<Server>>) -> ApiResult<recovery::Listing> {
    let root = server.root_info().map_err(refused)?.path;
    let dir = server.recovery_dir();
    Ok(Json(blocking(move || recovery::list(&dir, &root)).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftArgs {
    rel_path: String,
    stamp: Option<FileStamp>,
    revision: u64,
    contents: String,
}

/// What a stored revision came back as. The revision is echoed so a caller
/// acknowledges exactly the revision that reached the disk, never "the latest
/// one" — a write that finished late must not speak for a newer draft.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    revision: u64,
}

async fn recovery_put(
    State(server): State<Arc<Server>>,
    Extension(session): Extension<Session>,
    Json(args): Json<DraftArgs>,
) -> ApiResult<Stored> {
    let name = require_session(&session)?;
    let rel_path = draft_path(&args.rel_path)?;
    let root = server.root_info().map_err(refused)?.path;
    let dir = server.recovery_dir();
    let draft = recovery::Draft {
        version: 1,
        root,
        rel_path,
        stamp: args.stamp,
        revision: args.revision,
        server_id: server.server_id.clone(),
        session_id: name,
        updated_at: 0,
        contents: args.contents,
    };
    let revision = blocking(move || recovery::put(&dir, &draft)).await?;
    Ok(Json(Stored { revision }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DropArgs {
    rel_path: String,
    /// The revision that has been dealt with. A record holding a newer one is
    /// kept, because that text has not been.
    revision: u64,
}

async fn recovery_drop(
    State(server): State<Arc<Server>>,
    Json(args): Json<DropArgs>,
) -> ApiResult<bool> {
    let rel_path = draft_path(&args.rel_path)?;
    let root = server.root_info().map_err(refused)?.path;
    let dir = server.recovery_dir();
    Ok(Json(
        blocking(move || recovery::drop_draft(&dir, &root, &rel_path, args.revision)).await?,
    ))
}

// ---------------------------------------------------------------------------
// The boundary around them.
// ---------------------------------------------------------------------------

/// Every API request must prove three things before any handler runs: that it
/// was addressed to this server by name, that it came from this server's own
/// page, and that it carries this launch's credential. A request missing any
/// of them is refused without reaching an operation and without saying which
/// check failed.
pub(crate) fn admitted(
    host: Option<&str>,
    origin: Option<&str>,
    credential: Option<&str>,
    expected: &str,
) -> bool {
    host == Some(ADDR)
        && origin == Some(ORIGIN)
        && credential.is_some_and(|given| credential_matches(expected, given))
}

/// The one value of `name`. `None` when it is absent, when it is not text,
/// and when it was given more than once: a request carrying two `Host` or two
/// `Origin` headers does not have an exact one, so it is refused like a
/// request with none rather than admitted on whichever came first. A browser
/// cannot send either header twice — both are forbidden header names — so
/// nothing a page can legitimately do is turned away here.
pub(crate) fn only_header(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    let mut values = headers.get_all(name).iter();
    let only = values.next()?;
    if values.next().is_some() {
        return None;
    }
    only.to_str().ok().map(str::to_owned)
}

async fn admit(State(server): State<Arc<Server>>, mut request: Request, next: Next) -> Response {
    // Read what the checks need and let go of the request before the first
    // await: nothing borrowed from it may be held across one.
    let (host, origin, credential, session) = {
        let headers = request.headers();
        (
            only_header(headers, header::HOST),
            only_header(headers, header::ORIGIN),
            only_header(headers, HeaderName::from_static(CREDENTIAL_HEADER)),
            session_name(only_header(
                headers,
                HeaderName::from_static(SESSION_HEADER),
            )),
        )
    };
    if !admitted(
        host.as_deref(),
        origin.as_deref(),
        credential.as_deref(),
        &server.credential,
    ) {
        return Refusal(
            StatusCode::FORBIDDEN,
            "this request did not come from the alabs page this process launched".to_string(),
        )
        .into_response();
    }
    // Which admitted page this is. Read here so every handler sees the same
    // value from the same place, and so nothing downstream reads a header the
    // admission check has not already been past.
    request.extensions_mut().insert(Session(session));
    // Held for the whole operation, so a burst of clicks queues instead of
    // starting sixteen walks of the disk at once.
    let Ok(_permit) = server.permits.acquire().await else {
        return Refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "alabs is shutting down".to_string(),
        )
        .into_response();
    };
    next.run(request).await
}

/// An operation this server does not have. The browser runtime already names
/// what it cannot do yet, so reaching this is a mistake in alabs.
async fn no_such_operation() -> Refusal {
    Refusal(
        StatusCode::NOT_FOUND,
        "alabs has no such operation".to_string(),
    )
}

fn fixed(name: HeaderName, value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::overriding(name, HeaderValue::from_static(value))
}

/// Only explicit inference gets the core's longer deadline plus response
/// overhead. Navigation, saves, admission and assets keep the ordinary bound.
fn request_timeout(path: &str) -> Duration {
    match path {
        "/api/v1/ask-local-model" => local_model::REQUEST_TIMEOUT + Duration::from_secs(10),
        "/api/v1/generate-local-model-json" => {
            local_model::VIEW_REQUEST_TIMEOUT + Duration::from_secs(10)
        }
        _ => REQUEST_TIMEOUT,
    }
}

async fn request_deadline(request: Request, next: Next) -> Response {
    match tokio::time::timeout(request_timeout(request.uri().path()), next.run(request)).await {
        Ok(response) => response,
        Err(_) => StatusCode::REQUEST_TIMEOUT.into_response(),
    }
}

pub(crate) fn router(server: Arc<Server>) -> Router {
    let api = Router::new()
        .route("/bootstrap", post(bootstrap))
        .route("/list-dir", post(list_dir))
        .route("/entry-kind", post(entry_kind))
        .route("/read-file", post(read_file))
        .route("/stat-file", post(stat_file))
        .route("/git-facts", post(git_facts))
        .route("/git-query", post(git_query))
        .route("/open-terminal", post(open_terminal))
        .route("/view-session", post(view_session))
        .route("/collect-inventory", post(collect_inventory))
        .route("/list-local-models", post(list_local_models))
        .route("/ask-local-model", post(ask_local_model))
        .route(
            "/generate-local-model-json",
            post(generate_local_model_json),
        )
        .route("/write-view-files", post(write_view_files))
        .route("/write-root-view-files", post(write_root_view_files))
        .route("/search-subject", post(search_subject))
        .route("/cancel-search", post(cancel_search))
        .route("/load-ui-state", post(load_ui_state))
        .route("/save-ui-state", post(save_ui_state))
        .route("/append-log", post(append_log))
        .route("/claim-writing", post(claim_writing))
        .route("/release-writing", post(release_writing))
        .route("/writing-status", post(writing_status))
        .route("/save-file", post(save_file))
        .route("/recreate-file", post(recreate_file))
        .route("/create-file", post(create_file))
        .route("/create-dir", post(create_dir))
        .route("/recovery-list", post(recovery_list))
        .route("/recovery-put", post(recovery_put))
        .route("/recovery-drop", post(recovery_drop))
        // Anything else under `/api/v1` is an operation alabs does not have.
        // It is answered here rather than by the asset service, so the whole
        // API surface behaves the same way and sits behind the same check.
        .fallback(no_such_operation)
        // Outermost last: the no-store header goes on whatever comes back,
        // admission runs before routing and before the body is looked at,
        // and the body cap applies before a handler reads anything.
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        // The extractor tuple is named because nothing else in the chain
        // pins it, and `from_fn_with_state` cannot infer it on its own.
        .layer(from_fn_with_state::<_, _, (State<Arc<Server>>, Request)>(
            server.clone(),
            admit,
        ))
        .layer(fixed(header::CACHE_CONTROL, "no-store"))
        .with_state(server.clone());

    Router::new()
        .nest("/api/v1", api)
        // Only the built application. Nothing inside the alabs root is ever
        // reachable as a web resource: user files arrive as data through the
        // operations above and stay inside the existing sanitizers.
        .fallback_service(ServeDir::new(&server.assets))
        .layer(from_fn(request_deadline))
        .layer(fixed(
            HeaderName::from_static("content-security-policy"),
            CSP,
        ))
        .layer(fixed(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(fixed(header::REFERRER_POLICY, "no-referrer"))
}

/// Where the built browser assets live, relative to the repository this
/// executable was built in. The launcher sets `ALABS_ASSETS`; the default is
/// only a convenience when running the binary by hand.
fn assets_dir() -> PathBuf {
    match std::env::var_os("ALABS_ASSETS") {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|repo| repo.join("dist-browser"))
            .unwrap_or_else(|| PathBuf::from("dist-browser")),
    }
}

async fn serve(server: Arc<Server>) -> Result<(), String> {
    let addr: SocketAddr = ADDR.parse().map_err(|e| format!("bad address: {}", e))?;
    // A taken port is a refusal to launch. alabs never stops whatever is
    // already there and never quietly moves to another origin, because the
    // origin is half of what makes a request admissible.
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        format!(
            "cannot serve on {}: {}. Another alabs may already be running; \
             stop it with Control-C in its terminal and try again.",
            ADDR, e
        )
    })?;
    let root = server.root_info()?;
    println!("alabs root: {}", root.path);
    println!("state:      {}", server.state_dir.display());
    println!("open:       {}/#c={}", ORIGIN, server.credential);
    println!("Control-C stops this process. Closing Chrome does not.");
    axum::serve(listener, router(server))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| format!("the server stopped: {}", e))
}

/// The `alabs-serve` entry point. One argument: the absolute path of the
/// alabs root this process will own.
pub fn serve_main(args: Vec<String>) -> ExitCode {
    let [path] = args.as_slice() else {
        eprintln!("usage: alabs-serve <absolute-path-to-alabs-root>");
        return ExitCode::FAILURE;
    };
    if !Path::new(path).is_absolute() {
        eprintln!("alabs-serve: the alabs root must be an absolute path: {path}");
        return ExitCode::FAILURE;
    }
    let started = Server::open(Path::new(path), assets_dir()).and_then(|server| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("cannot start the local runtime: {}", e))?;
        runtime.block_on(serve(Arc::new(server)))
    });
    match started {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("alabs-serve: {err}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
#[path = "serve_tests.rs"]
mod tests;
