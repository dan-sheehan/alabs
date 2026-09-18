//! Bounded child processes and the one hardened Git helper (BUILD_PLAN Step 4).
//!
//! Every external program alabs runs goes through `run_bounded`: a fixed
//! program path, `std::process`, `try_wait` polling against a deadline,
//! reader threads that drain stdout (capped) and stderr continuously, the
//! child killed on timeout or cap breach, and one named result. No process
//! framework, no tokio dependency; the Tauri command runs it on
//! `spawn_blocking`.
//!
//! Git inspection never executes repository-controlled programs and never
//! touches the network:
//!
//! ```text
//! git_facts(place)
//!   pre:  place opened through the root handle · canonical path read back from
//!         that handle · .git is a real directory (a .git file or link is
//!         "linked", unsupported) · .git/info/attributes absent · xcode-select -p
//!         succeeded once this session
//!   argv: /usr/bin/git -C <path> --git-dir=.git --work-tree=. --no-pager
//!         --no-lazy-fetch --attr-source=<empty tree of the repository's object
//!         format> -c core.fsmonitor=false -c diff.external= -c
//!         core.hooksPath=/dev/null -c core.pager=cat -c
//!         core.attributesFile=/dev/null <subcommand>
//!   env:  inherited GIT_* stripped; GIT_TERMINAL_PROMPT=0 GIT_ATTR_NOSYSTEM=1
//!         GIT_NO_LAZY_FETCH=1 LC_ALL=C; stdin closed
//!   run:  spawn_blocking · 5 s · stdout capped at 2 MB · stderr bounded
//!   out:  ok(bytes) | timeout | too large | spawn failure | exit≠0 (first stderr line)
//! ```
//!
//! Step 6 adds the change queries (`git_query`) behind the same gate and the
//! same fixed command line: `rev-parse --verify -q HEAD` plus `status` for the
//! handoff baseline; `status --porcelain=v1 -z -uall --no-renames`; `cat-file
//! -e <baseline>^{commit}` before any use of a baseline; `diff --name-status
//! -z --no-renames <baseline>..HEAD`; `diff --name-status -z --no-renames
//! <baseline>` plus `ls-files --others --exclude-standard -z`; and `cat-file
//! blob <rev>:<path>` for one side of a comparison. A baseline or revision is
//! accepted only as `HEAD` or a full hex object name and a path only as a
//! plain relative path, so no argument can ever be read as an option.
//!
//! The browser front door adds `--no-optional-locks` to every one of those
//! calls (`GitEnv::no_optional_locks`), so a question asked by a background
//! process never takes the index lock or rewrites the index of a repository
//! the user is also using in Terminal.
//!
//! `Open in Terminal` runs `/usr/bin/open -a Terminal <path>` through the same
//! bounded helper, with the path read back from the place handle.
//!
//! Accepted Stage 1 limitation (README): the child receives a pathname, so a
//! hostile same-user process could replace the place directory between the
//! path read and the launch; a normal rename makes Git fail by name.

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{dir_path, open_scope_dir, SubjectRoot, MAX_FILE_BYTES};

/// Wall-clock bound for every child process alabs runs.
pub const PROCESS_TIMEOUT: Duration = Duration::from_secs(5);
/// Most stderr bytes kept; the rest is drained and dropped.
const MAX_STDERR_BYTES: usize = 16 * 1024;
const POLL: Duration = Duration::from_millis(10);

/// Apple's git shim; without Command Line Tools it opens an install dialog,
/// which is why `tools_available` runs first.
pub const GIT_PROGRAM: &str = "/usr/bin/git";
const XCODE_SELECT: &str = "/usr/bin/xcode-select";
/// macOS `open`, used only to hand a place folder to Terminal.app.
pub const OPEN_PROGRAM: &str = "/usr/bin/open";

const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256: &str = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/// The one named result of a bounded child process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessError {
    /// The deadline passed; the child was killed.
    Timeout,
    /// Stdout passed the cap; the child was killed.
    TooLarge,
    /// The program could not be started.
    Spawn(String),
    /// The child exited with a failure; `stderr` is its first line.
    Exit { code: Option<i32>, stderr: String },
}

/// Drain a pipe to its end, keeping at most `cap` bytes. `over` is raised
/// the moment more than `cap` bytes have arrived, so the caller can kill the
/// child while this keeps draining. Returns the kept bytes.
fn drain(mut reader: impl Read, cap: usize, over: &AtomicBool) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = cap.saturating_sub(kept.len());
                if n > room {
                    over.store(true, Ordering::SeqCst);
                }
                kept.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
    kept
}

/// The first line of a child's stderr, without a leading `fatal: ` or
/// `error: `, for the named failure.
fn first_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    line.strip_prefix("fatal: ")
        .or_else(|| line.strip_prefix("error: "))
        .unwrap_or(line)
        .to_string()
}

/// Run `cmd` to completion within `timeout`, keeping at most `max_stdout`
/// bytes of its output. Stdin is closed. Stdout and stderr are drained on
/// their own threads the whole time, so a chatty child never blocks; a child
/// that outlives the deadline or the cap is killed and reaped. The readers
/// are joined once the pipes close; a pipe held open past the deadline by
/// something the child left behind counts as a timeout.
pub fn run_bounded(
    mut cmd: Command,
    timeout: Duration,
    max_stdout: usize,
) -> Result<Vec<u8>, ProcessError> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| ProcessError::Spawn(e.to_string()))?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let over = Arc::new(AtomicBool::new(false));
    let err_over = Arc::new(AtomicBool::new(false));
    let (out_tx, out_rx) = mpsc::channel();
    let (err_tx, err_rx) = mpsc::channel();
    let out_flag = Arc::clone(&over);
    let out_reader = thread::spawn(move || {
        let _ = out_tx.send(drain(stdout, max_stdout, &out_flag));
    });
    let err_flag = Arc::clone(&err_over);
    let err_reader = thread::spawn(move || {
        let _ = err_tx.send(drain(stderr, MAX_STDERR_BYTES, &err_flag));
    });
    let start = Instant::now();
    let kill = |child: &mut std::process::Child| {
        let _ = child.kill();
        let _ = child.wait();
    };
    // Wait for the child, the cap or the deadline, whichever comes first.
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(e) => {
                kill(&mut child);
                break Err(ProcessError::Spawn(e.to_string()));
            }
        }
        if over.load(Ordering::SeqCst) {
            kill(&mut child);
            break Err(ProcessError::TooLarge);
        }
        if start.elapsed() >= timeout {
            kill(&mut child);
            break Err(ProcessError::Timeout);
        }
        thread::sleep(POLL);
    };
    // The child is gone; its pipes close unless something it started keeps
    // them. Collect what the readers kept, within what is left of the deadline.
    let remaining = || timeout.saturating_sub(start.elapsed()).max(POLL);
    let collect = |rx: mpsc::Receiver<Vec<u8>>, reader: thread::JoinHandle<()>| match rx
        .recv_timeout(remaining())
    {
        Ok(bytes) => {
            let _ = reader.join();
            Ok(bytes)
        }
        Err(RecvTimeoutError::Timeout) => Err(ProcessError::Timeout),
        Err(RecvTimeoutError::Disconnected) => Ok(Vec::new()),
    };
    let status = match status {
        Ok(status) => status,
        Err(e) => {
            // Killed: give the readers a moment to see the pipes close, then report.
            let _ = collect(out_rx, out_reader);
            let _ = collect(err_rx, err_reader);
            return Err(e);
        }
    };
    let stdout = collect(out_rx, out_reader)?;
    let stderr = collect(err_rx, err_reader)?;
    if over.load(Ordering::SeqCst) {
        return Err(ProcessError::TooLarge);
    }
    if !status.success() {
        return Err(ProcessError::Exit {
            code: status.code(),
            stderr: first_line(&stderr),
        });
    }
    Ok(stdout)
}

/// Whether `xcode-select -p` at `program` succeeds: the Command Line Tools
/// are installed, so `/usr/bin/git` is a real git and not the install shim.
pub fn probe_tools(program: &Path) -> bool {
    let mut cmd = Command::new(program);
    cmd.arg("-p");
    run_bounded(cmd, PROCESS_TIMEOUT, 4096).is_ok()
}

/// The Command Line Tools probe, run lazily once per launch and cached for
/// the session. Refresh never re-probes; the next launch does.
pub fn tools_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| probe_tools(Path::new(XCODE_SELECT)))
}

/// What a Git call runs with. Production uses `GIT_PROGRAM` and the cached
/// probe; tests substitute a marker script or a missing program.
pub struct GitEnv<'a> {
    pub program: &'a Path,
    /// The Command Line Tools probe result. False means nothing is spawned.
    pub available: bool,
    /// True to pass `--no-optional-locks`, which stops git taking the index
    /// lock and refreshing the index for a read-only question.
    ///
    /// The browser front door sets it (`serve.rs`): that process reads a
    /// repository the user is also working in from Terminal, and a background
    /// reader must never take a lock or rewrite an index on their behalf. The
    /// desktop application is the window the user is looking at and keeps
    /// git's ordinary behaviour.
    pub no_optional_locks: bool,
}

/// Object formats seen per place this session, so the empty-tree lookup runs
/// once per place. Cleared when the root changes.
pub type FormatCache = Mutex<HashMap<String, String>>;

/// The fixed, hardened git command line. `attr_source` is the empty tree of
/// the repository's object format; it is `None` only for the object-format
/// lookup itself, which reads no attributes.
fn git_command(
    program: &Path,
    place_path: &Path,
    attr_source: Option<&str>,
    no_optional_locks: bool,
    args: &[&str],
) -> Command {
    let mut cmd = Command::new(program);
    if no_optional_locks {
        cmd.arg("--no-optional-locks");
    }
    cmd.arg("-C")
        .arg(place_path)
        .arg("--git-dir=.git")
        .arg("--work-tree=.")
        .arg("--no-pager")
        .arg("--no-lazy-fetch")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "diff.external=",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.pager=cat",
            "-c",
            "core.attributesFile=/dev/null",
        ]);
    if let Some(tree) = attr_source {
        cmd.arg(format!("--attr-source={tree}"));
    }
    cmd.args(args);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            cmd.env_remove(&key);
        }
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("LC_ALL", "C");
    cmd
}

/// Run one git subcommand in the place at `place_path` through the bounded
/// helper with the fixed arguments. Every Git call in alabs is this call.
pub fn git_run(
    env: &GitEnv,
    place_path: &Path,
    attr_source: Option<&str>,
    args: &[&str],
) -> Result<Vec<u8>, ProcessError> {
    run_bounded(
        git_command(
            env.program,
            place_path,
            attr_source,
            env.no_optional_locks,
            args,
        ),
        PROCESS_TIMEOUT,
        MAX_FILE_BYTES as usize,
    )
}

/// One Git fact, or the named reason it is not available.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitOutcome<T> {
    Ok { value: T },
    Timeout,
    TooLarge,
    Failed { reason: String },
}

impl<T> From<ProcessError> for GitOutcome<T> {
    fn from(e: ProcessError) -> Self {
        match e {
            ProcessError::Timeout => GitOutcome::Timeout,
            ProcessError::TooLarge => GitOutcome::TooLarge,
            ProcessError::Spawn(reason) => GitOutcome::Failed { reason },
            ProcessError::Exit { stderr, code } => GitOutcome::Failed {
                reason: if stderr.is_empty() {
                    format!("git exited with status {}", code.unwrap_or(-1))
                } else {
                    stderr
                },
            },
        }
    }
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    pub subject: String,
    /// Committer time, seconds since the epoch.
    pub time: u64,
}

/// What alabs found when it looked at a place's `.git`.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitInspection {
    /// No `.git` entry: an ordinary folder.
    None,
    /// `.git` is a file or a link (worktree or submodule): not supported yet; nothing spawned.
    Linked,
    /// The Command Line Tools probe failed; nothing spawned.
    Unavailable,
    /// The repository cannot be inspected safely; nothing spawned.
    Refused { reason: String },
    /// Branch name (empty when detached) and the last commit (`None` before the first commit).
    Facts {
        branch: GitOutcome<String>,
        last: GitOutcome<Option<Commit>>,
    },
}

/// The object format of the repository at `place_path`, from the cache or
/// one `rev-parse` call, mapped to the empty tree used as the attribute source.
fn attr_source_for(
    env: &GitEnv,
    place: &str,
    place_path: &Path,
    formats: &FormatCache,
) -> Result<String, GitOutcome<String>> {
    let cached = formats.lock().ok().and_then(|m| m.get(place).cloned());
    let format = match cached {
        Some(f) => f,
        None => {
            let out = git_run(
                env,
                place_path,
                None,
                &["rev-parse", "--show-object-format"],
            )
            .map_err(GitOutcome::from)?;
            let f = String::from_utf8_lossy(&out).trim().to_string();
            if let Ok(mut m) = formats.lock() {
                m.insert(place.to_string(), f.clone());
            }
            f
        }
    };
    match format.as_str() {
        "sha1" => Ok(EMPTY_TREE_SHA1.to_string()),
        "sha256" => Ok(EMPTY_TREE_SHA256.to_string()),
        other => Err(GitOutcome::Failed {
            reason: format!("object format {} is not supported", other),
        }),
    }
}

/// True for git's message that the current branch has no commits yet.
fn is_unborn(reason: &str) -> bool {
    reason.contains("does not have any commits yet") || reason.contains("unknown revision")
}

/// A repository the gate let through: the canonical path of the place, read
/// back from its handle, and the empty tree used as the attribute source.
pub struct Repo {
    pub path: PathBuf,
    pub tree: String,
}

/// What the gate found. Only `Ready` spawns anything further.
pub enum Gate {
    Ready(Repo),
    /// No `.git` entry: an ordinary folder.
    None,
    /// `.git` is a file or a link: not supported yet.
    Linked,
    /// The Command Line Tools probe failed.
    Unavailable,
    /// The repository cannot be inspected safely.
    Refused(String),
    /// The object-format lookup failed; every later call would too.
    Failed(GitOutcome<String>),
}

/// The gate every Git operation passes (BUILD_PLAN Step 4, reused by Step
/// 6): the place is opened through the root handle and its canonical path
/// read back from that handle; `.git` is checked through the same handle
/// and must be a real directory; `.git/info/attributes` refuses; the tools
/// probe must have succeeded; then the object format is looked up once per
/// place. An error is a handle failure (missing place, outside the root),
/// never a Git result.
pub fn open_repo(
    sub: &SubjectRoot,
    place: &str,
    env: &GitEnv,
    formats: &FormatCache,
) -> Result<Gate, String> {
    let dir = open_scope_dir(sub, place)?;
    match dir.symlink_metadata(".git") {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Ok(Gate::Linked),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Gate::None),
        Err(e) => return Err(format!("cannot access {}/.git: {}", place, e)),
    }
    let git_dir = match dir.open_dir(".git") {
        Ok(d) => d,
        Err(e) => return Ok(Gate::Refused(format!("cannot open .git: {}", e))),
    };
    match git_dir.open_dir("info") {
        Ok(info) => {
            if info.symlink_metadata("attributes").is_ok() {
                return Ok(Gate::Refused(".git/info/attributes is present".to_string()));
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) if e.kind() == io::ErrorKind::NotADirectory => {}
        Err(e) => return Ok(Gate::Refused(format!("cannot check .git/info: {}", e))),
    }
    if !env.available {
        return Ok(Gate::Unavailable);
    }
    let path: PathBuf = dir_path(&dir).map_err(|e| format!("cannot resolve {}: {}", place, e))?;
    match attr_source_for(env, place, &path, formats) {
        Ok(tree) => Ok(Gate::Ready(Repo { path, tree })),
        Err(outcome) => Ok(Gate::Failed(outcome)),
    }
}

/// Inspect the place `place` (a validated root-relative folder) for the
/// Overview: branch and last commit. Nothing is spawned for anything the
/// gate stops.
pub fn inspect(
    sub: &SubjectRoot,
    place: &str,
    env: &GitEnv,
    formats: &FormatCache,
) -> Result<GitInspection, String> {
    let repo = match open_repo(sub, place, env, formats)? {
        Gate::Ready(repo) => repo,
        Gate::None => return Ok(GitInspection::None),
        Gate::Linked => return Ok(GitInspection::Linked),
        Gate::Unavailable => return Ok(GitInspection::Unavailable),
        Gate::Refused(reason) => return Ok(GitInspection::Refused { reason }),
        Gate::Failed(outcome) => {
            let last = match &outcome {
                GitOutcome::Timeout => GitOutcome::Timeout,
                GitOutcome::TooLarge => GitOutcome::TooLarge,
                GitOutcome::Failed { reason } => GitOutcome::Failed {
                    reason: reason.clone(),
                },
                GitOutcome::Ok { .. } => unreachable!("an Err never carries Ok"),
            };
            return Ok(GitInspection::Facts {
                branch: outcome,
                last,
            });
        }
    };
    let place_path = repo.path;
    let tree = repo.tree;
    let branch = match git_run(env, &place_path, Some(&tree), &["branch", "--show-current"]) {
        Ok(out) => GitOutcome::Ok {
            value: String::from_utf8_lossy(&out).trim().to_string(),
        },
        Err(e) => GitOutcome::from(e),
    };
    let last = match git_run(
        env,
        &place_path,
        Some(&tree),
        &["log", "-1", "--format=%s%x00%ct"],
    ) {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out);
            let text = text.trim_end_matches('\n');
            match text.split_once('\0') {
                Some((subject, time)) => match time.trim().parse::<u64>() {
                    Ok(time) => GitOutcome::Ok {
                        value: Some(Commit {
                            subject: subject.to_string(),
                            time,
                        }),
                    },
                    Err(_) => GitOutcome::Failed {
                        reason: "unexpected commit time".to_string(),
                    },
                },
                None => GitOutcome::Failed {
                    reason: "unexpected log output".to_string(),
                },
            }
        }
        Err(ProcessError::Exit { stderr, .. }) if is_unborn(&stderr) => {
            GitOutcome::Ok { value: None }
        }
        Err(e) => GitOutcome::from(e),
    };
    Ok(GitInspection::Facts { branch, last })
}

// ---- Step 6: change queries and the Terminal launcher ----

/// One question about a place's repository, from the Changes and Task tabs.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitQuery {
    /// The current commit (`None` before the first commit) and whether the
    /// working tree is clean, recorded as the handoff baseline.
    Head,
    /// `Not yet committed`: the NUL-delimited status listing.
    Status,
    /// `Commits since task started`: names and states between the baseline and HEAD.
    Committed { baseline: String },
    /// `Since task started`: names and states between the baseline and the
    /// files on disk, plus the current untracked files.
    Since { baseline: String },
    /// One side of a comparison: the file at `path` in revision `rev`.
    Blob { rev: String, path: String },
}

/// The answer to a `GitQuery`, or the named reason there is none.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitQueryResult {
    /// No `.git`: an ordinary folder.
    None,
    /// `.git` is a file or a link: not supported yet; nothing spawned.
    Linked,
    /// The Command Line Tools probe failed; nothing spawned.
    Unavailable,
    /// The repository cannot be inspected safely; nothing spawned.
    Refused {
        reason: String,
    },
    Timeout,
    TooLarge,
    Failed {
        reason: String,
    },
    Head {
        commit: Option<String>,
        clean: bool,
    },
    /// NUL-delimited status or name-status text, exactly as git wrote it.
    Files {
        text: String,
    },
    Since {
        diff: String,
        untracked: String,
    },
    /// The baseline commit is no longer in the repository.
    BaselineMissing,
    Blob {
        text: String,
    },
    /// The file at that revision holds NUL bytes or is not UTF-8.
    Binary,
    /// Nothing exists at that path in that revision.
    Missing,
}

impl From<ProcessError> for GitQueryResult {
    fn from(e: ProcessError) -> Self {
        match GitOutcome::<()>::from(e) {
            GitOutcome::Timeout => GitQueryResult::Timeout,
            GitOutcome::TooLarge => GitQueryResult::TooLarge,
            GitOutcome::Failed { reason } => GitQueryResult::Failed { reason },
            GitOutcome::Ok { .. } => unreachable!("a ProcessError never converts to Ok"),
        }
    }
}

/// A full hex object name: 40 (SHA-1) or 64 (SHA-256) lowercase hex digits.
fn is_object_name(text: &str) -> bool {
    (text.len() == 40 || text.len() == 64) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A revision alabs may name: `HEAD` or a full hex object name. Never a
/// branch name or anything that could be read as an option.
fn validate_rev(rev: &str) -> Result<(), String> {
    if rev == "HEAD" || is_object_name(rev) {
        Ok(())
    } else {
        Err(format!("invalid revision: {}", rev))
    }
}

/// A place-relative file path as git listed it: non-empty, no NUL, no
/// leading `/` or `-`, no empty, `.` or `..` component.
fn validate_tree_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains('\0')
        || path.starts_with('/')
        || path.starts_with('-')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("invalid path: {}", path));
    }
    Ok(())
}

/// True for git's message that `rev:path` names nothing.
fn is_missing_object(reason: &str) -> bool {
    reason.contains("does not exist in")
        || reason.contains("exists on disk, but not in")
        || reason.contains("invalid object name")
        || reason.contains("Not a valid object name")
        || is_unborn(reason)
}

fn lossy(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Whether `baseline` is still a commit in the repository. `cat-file -e`
/// exits non-zero for an unknown or non-commit object.
fn baseline_exists(env: &GitEnv, repo: &Repo, baseline: &str) -> Result<bool, ProcessError> {
    let spec = format!("{}^{{commit}}", baseline);
    match git_run(
        env,
        &repo.path,
        Some(&repo.tree),
        &["cat-file", "-e", &spec],
    ) {
        Ok(_) => Ok(true),
        Err(ProcessError::Exit { .. }) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Answer one query for the repository the gate let through. Every call is
/// `git_run` with the fixed hardened arguments; arguments alabs adds are
/// validated first so nothing can be read as an option.
fn answer(env: &GitEnv, repo: &Repo, query: &GitQuery) -> Result<GitQueryResult, ProcessError> {
    let run = |args: &[&str]| git_run(env, &repo.path, Some(&repo.tree), args);
    match query {
        GitQuery::Head => {
            let commit = match run(&["rev-parse", "--verify", "-q", "HEAD"]) {
                Ok(out) => Some(lossy(out).trim().to_string()),
                Err(ProcessError::Exit {
                    code: Some(1),
                    stderr,
                }) if stderr.is_empty() => None,
                Err(e) => return Err(e),
            };
            let status = run(&["status", "--porcelain=v1", "-z", "-uall", "--no-renames"])?;
            Ok(GitQueryResult::Head {
                commit,
                clean: status.is_empty(),
            })
        }
        GitQuery::Status => {
            let out = run(&["status", "--porcelain=v1", "-z", "-uall", "--no-renames"])?;
            Ok(GitQueryResult::Files { text: lossy(out) })
        }
        GitQuery::Committed { baseline } => {
            if let Err(reason) = validate_rev(baseline).and_then(|_| {
                if baseline == "HEAD" {
                    Err("invalid revision: HEAD".to_string())
                } else {
                    Ok(())
                }
            }) {
                return Ok(GitQueryResult::Failed { reason });
            }
            if !baseline_exists(env, repo, baseline)? {
                return Ok(GitQueryResult::BaselineMissing);
            }
            let range = format!("{}..HEAD", baseline);
            let out = run(&["diff", "--name-status", "-z", "--no-renames", &range])?;
            Ok(GitQueryResult::Files { text: lossy(out) })
        }
        GitQuery::Since { baseline } => {
            if !is_object_name(baseline) {
                return Ok(GitQueryResult::Failed {
                    reason: format!("invalid revision: {}", baseline),
                });
            }
            if !baseline_exists(env, repo, baseline)? {
                return Ok(GitQueryResult::BaselineMissing);
            }
            let diff = run(&["diff", "--name-status", "-z", "--no-renames", baseline])?;
            let untracked = run(&["ls-files", "--others", "--exclude-standard", "-z"])?;
            Ok(GitQueryResult::Since {
                diff: lossy(diff),
                untracked: lossy(untracked),
            })
        }
        GitQuery::Blob { rev, path } => {
            if let Err(reason) = validate_rev(rev).and_then(|_| validate_tree_path(path)) {
                return Ok(GitQueryResult::Failed { reason });
            }
            let spec = format!("{}:{}", rev, path);
            match run(&["cat-file", "blob", &spec]) {
                Ok(bytes) => {
                    if bytes.contains(&0) {
                        return Ok(GitQueryResult::Binary);
                    }
                    Ok(match String::from_utf8(bytes) {
                        Ok(text) => GitQueryResult::Blob { text },
                        Err(_) => GitQueryResult::Binary,
                    })
                }
                Err(ProcessError::Exit { stderr, .. }) if is_missing_object(&stderr) => {
                    Ok(GitQueryResult::Missing)
                }
                Err(e) => Err(e),
            }
        }
    }
}

/// Answer `query` for the place `place`. The gate (`open_repo`) runs first,
/// so nothing is spawned for a non-repository, a linked `.git`, a
/// `.git/info/attributes` file, or a failed tools probe. An error is a
/// handle failure, never a Git result.
pub fn query(
    sub: &SubjectRoot,
    place: &str,
    env: &GitEnv,
    formats: &FormatCache,
    query: &GitQuery,
) -> Result<GitQueryResult, String> {
    let repo = match open_repo(sub, place, env, formats)? {
        Gate::Ready(repo) => repo,
        Gate::None => return Ok(GitQueryResult::None),
        Gate::Linked => return Ok(GitQueryResult::Linked),
        Gate::Unavailable => return Ok(GitQueryResult::Unavailable),
        Gate::Refused(reason) => return Ok(GitQueryResult::Refused { reason }),
        Gate::Failed(outcome) => {
            return Ok(match outcome {
                GitOutcome::Timeout => GitQueryResult::Timeout,
                GitOutcome::TooLarge => GitQueryResult::TooLarge,
                GitOutcome::Failed { reason } => GitQueryResult::Failed { reason },
                GitOutcome::Ok { .. } => unreachable!("an Err never carries Ok"),
            })
        }
    };
    Ok(answer(env, &repo, query).unwrap_or_else(GitQueryResult::from))
}

/// `open -a Terminal <path>`: the fixed command that hands a folder to
/// Terminal.app. `path` is absolute (read back from the place handle), so it
/// can never be read as an option.
pub fn terminal_command(program: &Path, path: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.arg("-a").arg("Terminal").arg(path);
    cmd
}

/// Open Terminal.app at the place `place`. The place is opened through the
/// root handle and its canonical path read back from that handle; `open`
/// returns as soon as it has asked for the window, so this never waits on
/// Terminal itself. A failure is a named reason.
pub fn open_terminal(sub: &SubjectRoot, place: &str, program: &Path) -> Result<(), String> {
    let dir = open_scope_dir(sub, place)?;
    let path = dir_path(&dir).map_err(|e| format!("cannot resolve {}: {}", place, e))?;
    match run_bounded(terminal_command(program, &path), PROCESS_TIMEOUT, 4096) {
        Ok(_) => Ok(()),
        Err(ProcessError::Timeout) => Err("open took too long".to_string()),
        Err(ProcessError::TooLarge) => Err("open returned too much output".to_string()),
        Err(ProcessError::Spawn(reason)) => Err(format!("cannot start open: {}", reason)),
        Err(ProcessError::Exit { code, stderr }) => Err(if stderr.is_empty() {
            format!("open exited with status {}", code.unwrap_or(-1))
        } else {
            stderr
        }),
    }
}

#[cfg(test)]
#[path = "git_tests.rs"]
mod tests;
