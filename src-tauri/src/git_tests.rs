use super::*;
use crate::SubjectRoot;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

/// A root under the system temp dir holding one or more places, removed on
/// drop. `marker` is a path a hostile script would create; every adversarial
/// test asserts it never appears.
struct Root {
    base: PathBuf,
    root: PathBuf,
    sub: SubjectRoot,
    formats: FormatCache,
}

impl Root {
    fn new() -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let id = COUNTER.fetch_add(1, AtomicOrdering::SeqCst);
        let base = std::env::temp_dir().join(format!("alabs-git-{}-{}", std::process::id(), id));
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        let sub = SubjectRoot::open(&root).unwrap();
        Self {
            base: base.clone(),
            root: root.canonicalize().unwrap(),
            sub,
            formats: Mutex::new(HashMap::new()),
        }
    }

    fn marker(&self) -> PathBuf {
        self.base.join("marker")
    }

    /// An executable script that creates the marker and exits at once,
    /// reading nothing, so a plain-git negative control can never hang on it.
    fn marker_script(&self) -> PathBuf {
        let script = self.base.join("evil.sh");
        fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\nexit 0\n", self.marker().display()),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    fn env(&self) -> GitEnv<'static> {
        GitEnv {
            program: Path::new(GIT_PROGRAM),
            available: true,
            no_optional_locks: false,
        }
    }

    /// Run plain git (no hardening) in a place, for setup and for negative controls.
    fn raw(&self, place: &str, args: &[&str]) -> std::process::Output {
        StdCommand::new(GIT_PROGRAM)
            .arg("-C")
            .arg(self.root.join(place))
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .output()
            .unwrap()
    }

    fn init(&self, place: &str) {
        fs::create_dir_all(self.root.join(place)).unwrap();
        assert!(self
            .raw(place, &["init", "-q", "-b", "main"])
            .status
            .success());
        assert!(self
            .raw(place, &["config", "user.email", "t@example.com"])
            .status
            .success());
        assert!(self
            .raw(place, &["config", "user.name", "t"])
            .status
            .success());
    }

    fn commit(&self, place: &str, file: &str, text: &str, subject: &str) {
        fs::write(self.root.join(place).join(file), text).unwrap();
        assert!(self.raw(place, &["add", file]).status.success());
        let out = self.raw(place, &["commit", "-q", "-m", subject]);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn inspect(&self, place: &str) -> Result<GitInspection, String> {
        inspect(&self.sub, place, &self.env(), &self.formats)
    }

    fn inspect_with(&self, place: &str, env: &GitEnv) -> Result<GitInspection, String> {
        inspect(&self.sub, place, env, &self.formats)
    }

    fn place_path(&self, place: &str) -> PathBuf {
        self.root.join(place)
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn sh(script: &str) -> Command {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(script);
    cmd
}

// ---- the bounded process helper, with fake children ----

#[test]
fn bounded_helper_returns_stdout_of_a_quick_child() {
    let out = run_bounded(
        sh("printf hello; printf err >&2"),
        Duration::from_secs(5),
        1024,
    )
    .unwrap();
    assert_eq!(out, b"hello");
}

#[test]
fn bounded_helper_kills_a_child_that_outlives_the_deadline() {
    let start = Instant::now();
    let mut cmd = Command::new("/bin/sleep");
    cmd.arg("5");
    let result = run_bounded(cmd, Duration::from_millis(200), 1024);
    assert_eq!(result, Err(ProcessError::Timeout));
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "the child was killed, not waited for: {:?}",
        start.elapsed()
    );
}

#[test]
fn bounded_helper_stops_a_child_that_passes_the_output_cap() {
    let start = Instant::now();
    let result = run_bounded(
        Command::new("/usr/bin/yes"),
        Duration::from_secs(5),
        64 * 1024,
    );
    assert_eq!(result, Err(ProcessError::TooLarge));
    assert!(
        start.elapsed() < Duration::from_secs(4),
        "{:?}",
        start.elapsed()
    );
    // Exactly at the cap is fine; one byte over is not.
    let at = run_bounded(sh("head -c 100 /dev/zero"), Duration::from_secs(5), 100).unwrap();
    assert_eq!(at.len(), 100);
    let over = run_bounded(sh("head -c 101 /dev/zero"), Duration::from_secs(5), 100);
    assert_eq!(over, Err(ProcessError::TooLarge));
}

#[test]
fn bounded_helper_names_a_non_zero_exit_with_the_first_stderr_line() {
    let result = run_bounded(
        sh("echo out; echo 'fatal: first problem' >&2; echo second >&2; exit 3"),
        Duration::from_secs(5),
        1024,
    );
    assert_eq!(
        result,
        Err(ProcessError::Exit {
            code: Some(3),
            stderr: "first problem".to_string()
        })
    );
    let silent = run_bounded(sh("exit 4"), Duration::from_secs(5), 1024);
    assert_eq!(
        silent,
        Err(ProcessError::Exit {
            code: Some(4),
            stderr: String::new()
        })
    );
}

#[test]
fn bounded_helper_reports_a_missing_program_as_a_spawn_failure() {
    let result = run_bounded(
        Command::new("/nonexistent/alabs-no-such-binary"),
        Duration::from_secs(5),
        1024,
    );
    assert!(
        matches!(result, Err(ProcessError::Spawn(_))),
        "{:?}",
        result
    );
}

#[test]
fn bounded_helper_drains_stderr_so_a_noisy_child_cannot_block() {
    // 1 MB of stderr is far past the kept bound; the child must still finish.
    let out = run_bounded(
        sh("head -c 1048576 /dev/zero | tr '\\0' x >&2; echo done"),
        Duration::from_secs(5),
        1024,
    )
    .unwrap();
    assert_eq!(out, b"done\n");
}

#[test]
fn tools_probe_is_true_only_for_a_program_that_exits_zero() {
    assert!(probe_tools(Path::new("/usr/bin/true")));
    assert!(!probe_tools(Path::new("/usr/bin/false")));
    assert!(!probe_tools(Path::new("/nonexistent/xcode-select")));
}

// ---- git facts on real repositories ----

#[test]
fn facts_report_branch_and_last_commit_of_a_repository() {
    let r = Root::new();
    r.init("defiance");
    r.commit("defiance", "a.txt", "a\n", "fix ingestion");
    let facts = r.inspect("defiance").unwrap();
    match facts {
        GitInspection::Facts { branch, last } => {
            assert_eq!(
                branch,
                GitOutcome::Ok {
                    value: "main".to_string()
                }
            );
            match last {
                GitOutcome::Ok {
                    value: Some(Commit { subject, time }),
                } => {
                    assert_eq!(subject, "fix ingestion");
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs();
                    assert!(
                        time <= now && time + 600 > now,
                        "time {} vs now {}",
                        time,
                        now
                    );
                }
                other => panic!("{:?}", other),
            }
        }
        other => panic!("{:?}", other),
    }
    // The object format was looked up once and cached for the place.
    assert_eq!(
        r.formats
            .lock()
            .unwrap()
            .get("defiance")
            .map(String::as_str),
        Some("sha1")
    );
}

#[test]
fn facts_say_no_commits_yet_for_a_repository_with_no_commits() {
    let r = Root::new();
    r.init("fresh");
    match r.inspect("fresh").unwrap() {
        GitInspection::Facts { branch, last } => {
            assert_eq!(
                branch,
                GitOutcome::Ok {
                    value: "main".to_string()
                }
            );
            assert_eq!(last, GitOutcome::Ok { value: None });
        }
        other => panic!("{:?}", other),
    }
}

#[test]
fn facts_report_an_empty_branch_when_detached_and_work_for_sha256_repositories() {
    let r = Root::new();
    r.init("d");
    r.commit("d", "a.txt", "a\n", "one");
    assert!(r.raw("d", &["checkout", "-q", "--detach"]).status.success());
    match r.inspect("d").unwrap() {
        GitInspection::Facts { branch, .. } => assert_eq!(
            branch,
            GitOutcome::Ok {
                value: String::new()
            }
        ),
        other => panic!("{:?}", other),
    }
    fs::create_dir_all(r.root.join("s256")).unwrap();
    assert!(r
        .raw(
            "s256",
            &["init", "-q", "-b", "main", "--object-format=sha256"]
        )
        .status
        .success());
    assert!(r
        .raw("s256", &["config", "user.email", "t@e.com"])
        .status
        .success());
    assert!(r
        .raw("s256", &["config", "user.name", "t"])
        .status
        .success());
    r.commit("s256", "b.txt", "b\n", "sha256 commit");
    match r.inspect("s256").unwrap() {
        GitInspection::Facts { branch, last } => {
            assert_eq!(
                branch,
                GitOutcome::Ok {
                    value: "main".to_string()
                }
            );
            assert!(
                matches!(last, GitOutcome::Ok { value: Some(ref c) } if c.subject == "sha256 commit"),
                "{:?}",
                last
            );
        }
        other => panic!("{:?}", other),
    }
    assert_eq!(
        r.formats.lock().unwrap().get("s256").map(String::as_str),
        Some("sha256")
    );
}

#[test]
fn a_plain_folder_is_not_a_repository_and_spawns_nothing() {
    let r = Root::new();
    fs::create_dir_all(r.root.join("plain/sub")).unwrap();
    let marker = r.marker_script();
    let env = GitEnv {
        program: &marker,
        available: true,
        no_optional_locks: false,
    };
    assert_eq!(r.inspect_with("plain", &env).unwrap(), GitInspection::None);
    assert!(!r.marker().exists(), "no git process ran");
}

#[test]
fn a_git_file_or_link_is_linked_and_spawns_nothing() {
    let r = Root::new();
    r.init("real");
    fs::create_dir_all(r.root.join("worktree")).unwrap();
    fs::write(
        r.root.join("worktree/.git"),
        format!("gitdir: {}/.git\n", r.place_path("real").display()),
    )
    .unwrap();
    fs::create_dir_all(r.root.join("linked")).unwrap();
    symlink("../real/.git", r.root.join("linked/.git")).unwrap();
    let marker = r.marker_script();
    let env = GitEnv {
        program: &marker,
        available: true,
        no_optional_locks: false,
    };
    assert_eq!(
        r.inspect_with("worktree", &env).unwrap(),
        GitInspection::Linked
    );
    assert_eq!(
        r.inspect_with("linked", &env).unwrap(),
        GitInspection::Linked
    );
    assert!(!r.marker().exists(), "no git process ran");
    // The real repository next to them still inspects.
    assert!(matches!(
        r.inspect("real").unwrap(),
        GitInspection::Facts { .. }
    ));
}

#[test]
fn a_failed_tools_probe_means_unavailable_and_nothing_spawned() {
    let r = Root::new();
    r.init("d");
    let marker = r.marker_script();
    let env = GitEnv {
        program: &marker,
        available: false,
        no_optional_locks: false,
    };
    assert_eq!(
        r.inspect_with("d", &env).unwrap(),
        GitInspection::Unavailable
    );
    assert!(!r.marker().exists());
}

#[test]
fn a_missing_git_program_is_a_named_failure() {
    let r = Root::new();
    r.init("d");
    let env = GitEnv {
        program: Path::new("/nonexistent/git"),
        available: true,
        no_optional_locks: false,
    };
    match r.inspect_with("d", &env).unwrap() {
        GitInspection::Facts { branch, last } => {
            assert!(matches!(branch, GitOutcome::Failed { .. }), "{:?}", branch);
            assert!(matches!(last, GitOutcome::Failed { .. }), "{:?}", last);
        }
        other => panic!("{:?}", other),
    }
}

#[test]
fn place_identifiers_are_validated_through_the_handle_and_spawn_nothing() {
    let r = Root::new();
    r.init("d");
    let outside = r.base.join("outside");
    fs::create_dir_all(&outside).unwrap();
    symlink(&outside, r.root.join("escape")).unwrap();
    let marker = r.marker_script();
    let env = GitEnv {
        program: &marker,
        available: true,
        no_optional_locks: false,
    };
    for bad in [
        "",
        "../root/d",
        "/",
        r.place_path("d").to_str().unwrap(),
        "missing",
        "escape",
        "d/",
        ".",
    ] {
        let err = r.inspect_with(bad, &env).unwrap_err();
        assert!(!err.is_empty(), "{:?}", bad);
    }
    assert!(
        !r.marker().exists(),
        "no git process ran for a refused place"
    );
}

#[test]
fn an_attributes_file_in_git_info_refuses_inspection_and_spawns_nothing() {
    let r = Root::new();
    r.init("d");
    r.commit("d", "a.txt", "a\n", "one");
    let script = r.marker_script();
    fs::create_dir_all(r.root.join("d/.git/info")).unwrap();
    fs::write(r.root.join("d/.git/info/attributes"), "*.txt filter=evil\n").unwrap();
    assert!(r
        .raw(
            "d",
            &["config", "filter.evil.clean", script.to_str().unwrap()]
        )
        .status
        .success());
    let env = GitEnv {
        program: &script,
        available: true,
        no_optional_locks: false,
    };
    assert_eq!(
        r.inspect_with("d", &env).unwrap(),
        GitInspection::Refused {
            reason: ".git/info/attributes is present".to_string()
        }
    );
    assert!(!r.marker().exists(), "no git process ran");
    // Removing the file restores inspection.
    fs::remove_file(r.root.join("d/.git/info/attributes")).unwrap();
    assert!(matches!(
        r.inspect("d").unwrap(),
        GitInspection::Facts { .. }
    ));
}

#[test]
fn hostile_config_programs_never_run_under_the_helper_but_do_under_plain_git() {
    let r = Root::new();
    r.init("d");
    r.commit("d", "a.txt", "a\n", "one");
    let script = r.marker_script();
    let s = script.to_str().unwrap();
    for (key, value) in [
        ("core.fsmonitor", s),
        ("diff.external", s),
        ("core.sshCommand", s),
        ("core.pager", s),
    ] {
        assert!(r.raw("d", &["config", key, value]).status.success());
    }
    fs::write(r.root.join("d/a.txt"), "changed\n").unwrap();
    let path = r.place_path("d");
    let env = r.env();
    // Facts, status and diff through the helper: results return, nothing runs.
    assert!(matches!(
        r.inspect("d").unwrap(),
        GitInspection::Facts { .. }
    ));
    let status = git_run(
        &env,
        &path,
        Some(EMPTY_TREE_SHA1),
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "-uall",
            "--no-renames",
        ],
    )
    .unwrap();
    assert!(String::from_utf8_lossy(&status).contains("a.txt"));
    let diff = git_run(
        &env,
        &path,
        Some(EMPTY_TREE_SHA1),
        &["diff", "--no-ext-diff", "--no-textconv", "--", "a.txt"],
    )
    .unwrap();
    assert!(String::from_utf8_lossy(&diff).contains("+changed"));
    assert!(!r.marker().exists(), "a repository-controlled program ran");
    // Negative control: plain git honours the same config and runs the script.
    let plain = r.raw("d", &["diff", "--", "a.txt"]);
    assert!(
        r.marker().exists(),
        "the hostile config is live for plain git (status {:?})",
        plain.status
    );
}

#[test]
fn a_gitattributes_filter_never_runs_under_the_helper_but_does_under_plain_git() {
    let r = Root::new();
    r.init("d");
    let script = r.marker_script();
    fs::write(r.root.join("d/.gitattributes"), "*.txt filter=evil\n").unwrap();
    assert!(r
        .raw(
            "d",
            &["config", "filter.evil.clean", script.to_str().unwrap()]
        )
        .status
        .success());
    assert!(r
        .raw(
            "d",
            &["config", "filter.evil.smudge", script.to_str().unwrap()]
        )
        .status
        .success());
    assert!(r
        .raw("d", &["config", "filter.evil.required", "true"])
        .status
        .success());
    // Commit with the filter disabled so setup itself runs nothing.
    fs::write(r.root.join("d/a.txt"), "a\n").unwrap();
    assert!(r
        .raw(
            "d",
            &[
                "-c",
                "filter.evil.clean=cat",
                "-c",
                "filter.evil.smudge=cat",
                "add",
                "a.txt",
                ".gitattributes"
            ]
        )
        .status
        .success());
    assert!(r
        .raw(
            "d",
            &[
                "-c",
                "filter.evil.clean=cat",
                "-c",
                "filter.evil.smudge=cat",
                "commit",
                "-q",
                "-m",
                "one"
            ]
        )
        .status
        .success());
    assert!(!r.marker().exists(), "setup must not run the filter");
    fs::write(r.root.join("d/a.txt"), "touched\n").unwrap();
    let path = r.place_path("d");
    let env = r.env();
    assert!(matches!(
        r.inspect("d").unwrap(),
        GitInspection::Facts { .. }
    ));
    let diff = git_run(
        &env,
        &path,
        Some(EMPTY_TREE_SHA1),
        &["diff", "--no-ext-diff", "--no-textconv", "--", "a.txt"],
    )
    .unwrap();
    assert!(String::from_utf8_lossy(&diff).contains("+touched"));
    let blob = git_run(
        &env,
        &path,
        Some(EMPTY_TREE_SHA1),
        &["cat-file", "blob", "HEAD:a.txt"],
    )
    .unwrap();
    assert_eq!(blob, b"a\n");
    assert!(!r.marker().exists(), "the filter ran under the helper");
    // Negative control: plain git runs the clean filter for the diff.
    let _ = r.raw("d", &["diff", "--", "a.txt"]);
    assert!(r.marker().exists(), "the filter is live for plain git");
}

#[test]
fn a_promisor_repository_with_a_missing_object_never_fetches_under_the_helper() {
    let r = Root::new();
    r.init("d");
    r.commit("d", "a.txt", "a\n", "one");
    let script = r.marker_script();
    // A partial-clone shape whose lazy fetch would run our marker as upload-pack.
    let remote = r.base.join("remote.git");
    fs::create_dir_all(&remote).unwrap();
    assert!(StdCommand::new(GIT_PROGRAM)
        .args(["init", "-q", "--bare"])
        .arg(&remote)
        .output()
        .unwrap()
        .status
        .success());
    for (key, value) in [
        ("remote.origin.url", remote.to_str().unwrap()),
        ("remote.origin.promisor", "true"),
        ("remote.origin.partialclonefilter", "blob:none"),
        ("remote.origin.uploadpack", script.to_str().unwrap()),
        ("extensions.partialClone", "origin"),
        ("core.repositoryformatversion", "1"),
    ] {
        assert!(r.raw("d", &["config", key, value]).status.success());
    }
    // Remove the blob so any read of it must be a lazy fetch.
    let blob_id = String::from_utf8(r.raw("d", &["rev-parse", "HEAD:a.txt"]).stdout).unwrap();
    let blob_id = blob_id.trim();
    let object = r
        .root
        .join("d/.git/objects")
        .join(&blob_id[..2])
        .join(&blob_id[2..]);
    fs::remove_file(&object).unwrap();
    let path = r.place_path("d");
    let env = r.env();
    // Facts do not need the blob and still work.
    assert!(matches!(
        r.inspect("d").unwrap(),
        GitInspection::Facts { .. }
    ));
    let result = git_run(
        &env,
        &path,
        Some(EMPTY_TREE_SHA1),
        &["cat-file", "blob", "HEAD:a.txt"],
    );
    assert!(
        matches!(result, Err(ProcessError::Exit { .. })),
        "{:?}",
        result
    );
    assert!(!r.marker().exists(), "a lazy fetch ran under the helper");
    // Negative control: plain git tries the promisor remote and runs upload-pack.
    let _ = r.raw("d", &["cat-file", "blob", "HEAD:a.txt"]);
    assert!(r.marker().exists(), "the lazy fetch is live for plain git");
}

#[test]
fn inherited_git_environment_is_stripped_and_the_fixed_settings_reach_the_child() {
    let r = Root::new();
    r.init("d");
    r.commit("d", "a.txt", "a\n", "one");
    // A GIT_* variable in alabs' own environment is removed for the child.
    std::env::set_var("GIT_ALABS_TEST_VAR", "1");
    let cmd = git_command(
        Path::new(GIT_PROGRAM),
        &r.place_path("d"),
        Some(EMPTY_TREE_SHA1),
        false,
        &["var", "-l"],
    );
    let envs: Vec<(String, Option<String>)> = cmd
        .get_envs()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect();
    assert!(
        envs.contains(&("GIT_ALABS_TEST_VAR".to_string(), None)),
        "{:?}",
        envs
    );
    assert!(envs.contains(&("GIT_NO_LAZY_FETCH".to_string(), Some("1".to_string()))));
    assert!(envs.contains(&("GIT_ATTR_NOSYSTEM".to_string(), Some("1".to_string()))));
    assert!(envs.contains(&("GIT_TERMINAL_PROMPT".to_string(), Some("0".to_string()))));
    let out = run_bounded(cmd, PROCESS_TIMEOUT, 1 << 20).unwrap();
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("core.fsmonitor=false"), "{}", text);
    assert!(text.contains("core.attributesfile=/dev/null"), "{}", text);
    assert!(text.contains("core.hookspath=/dev/null"), "{}", text);
    assert!(text.contains("core.pager=cat"), "{}", text);
}

/// The browser front door asks its questions with `--no-optional-locks`, so a
/// background reader never takes the index lock or rewrites the index of a
/// repository the user is also using elsewhere. The desktop front door does
/// not, and its command line is unchanged.
#[test]
fn optional_index_writes_are_disabled_only_when_asked_for() {
    let r = Root::new();
    r.init("d");
    let args = |no_optional_locks| {
        git_command(
            Path::new(GIT_PROGRAM),
            &r.place_path("d"),
            Some(EMPTY_TREE_SHA1),
            no_optional_locks,
            &["status"],
        )
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
    };
    assert_eq!(
        args(true).first().map(String::as_str),
        Some("--no-optional-locks")
    );
    assert!(!args(false).contains(&"--no-optional-locks".to_string()));

    // And it is the `GitEnv` flag, not the caller, that decides: a run through
    // the one helper every Git call goes through carries it.
    let quiet = GitEnv {
        program: Path::new(GIT_PROGRAM),
        available: true,
        no_optional_locks: true,
    };
    // `git var -l` prints the settings the child actually ran with, which is
    // how the rest of the fixed command line is checked above. Here it only
    // has to succeed: an argument git refused would be a failure, not output.
    assert!(git_run(
        &quiet,
        &r.place_path("d"),
        Some(EMPTY_TREE_SHA1),
        &["var", "-l"]
    )
    .is_ok());
}

// ---- Step 6: change queries ----

impl Root {
    fn query(&self, place: &str, q: GitQuery) -> Result<GitQueryResult, String> {
        query(&self.sub, place, &self.env(), &self.formats, &q)
    }

    fn head(&self, place: &str) -> String {
        let out = self.raw(place, &["rev-parse", "HEAD"]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn write(&self, place: &str, file: &str, text: &[u8]) {
        let path = self.root.join(place).join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}

fn files_text(result: GitQueryResult) -> String {
    match result {
        GitQueryResult::Files { text } => text,
        other => panic!("{:?}", other),
    }
}

const NO_SUCH_COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

#[test]
fn head_query_reports_the_commit_and_cleanliness_and_no_commit_before_the_first() {
    let r = Root::new();
    r.init("d");
    assert_eq!(
        r.query("d", GitQuery::Head).unwrap(),
        GitQueryResult::Head {
            commit: None,
            clean: true
        }
    );
    r.write("d", "new.txt", b"n\n");
    assert_eq!(
        r.query("d", GitQuery::Head).unwrap(),
        GitQueryResult::Head {
            commit: None,
            clean: false
        }
    );
    r.commit("d", "new.txt", "n\n", "one");
    let head = r.head("d");
    assert!(is_object_name(&head));
    assert_eq!(
        r.query("d", GitQuery::Head).unwrap(),
        GitQueryResult::Head {
            commit: Some(head.clone()),
            clean: true
        }
    );
    // An untracked file makes the handoff dirty; so does an edit.
    r.write("d", "extra.txt", b"x");
    assert_eq!(
        r.query("d", GitQuery::Head).unwrap(),
        GitQueryResult::Head {
            commit: Some(head),
            clean: false
        }
    );
}

#[test]
fn status_query_is_nul_delimited_with_spaces_quotes_unicode_deleted_and_nested_repositories() {
    let r = Root::new();
    r.init("d");
    r.commit("d", "a.txt", "a\n", "one");
    r.commit("d", "gone.txt", "g\n", "two");
    r.write("d", "a.txt", b"a2\n");
    fs::remove_file(r.place_path("d").join("gone.txt")).unwrap();
    r.write("d", "sp ace/ünï \"q\".txt", b"u");
    fs::create_dir_all(r.place_path("d").join("nested")).unwrap();
    assert!(r.raw("d/nested", &["init", "-q"]).status.success());
    r.write("d", "nested/inner.txt", b"i");
    let text = files_text(r.query("d", GitQuery::Status).unwrap());
    let entries: Vec<&str> = text.split('\0').filter(|e| !e.is_empty()).collect();
    assert_eq!(
        entries,
        vec![
            " M a.txt",
            " D gone.txt",
            "?? nested/",
            "?? sp ace/ünï \"q\".txt",
        ]
    );
    // An unborn repository lists every file as added or untracked, never as changed.
    r.init("fresh");
    r.write("fresh", "x.txt", b"x");
    assert!(r.raw("fresh", &["add", "x.txt"]).status.success());
    r.write("fresh", "y.txt", b"y");
    let text = files_text(r.query("fresh", GitQuery::Status).unwrap());
    assert_eq!(text, "A  x.txt\0?? y.txt\0");
}

#[test]
fn committed_excludes_uncommitted_work_while_since_includes_committed_uncommitted_and_untracked() {
    let r = Root::new();
    r.init("d");
    r.commit("d", "a.txt", "a\n", "one");
    r.commit("d", "old.txt", "o\n", "two");
    let baseline = r.head("d");
    // The tool commits one change, deletes one file in a commit, then leaves more on disk.
    r.commit("d", "a.txt", "a2\n", "tool: change a");
    assert!(r.raw("d", &["rm", "-q", "old.txt"]).status.success());
    assert!(r
        .raw("d", &["commit", "-q", "-m", "tool: drop old"])
        .status
        .success());
    r.write("d", "b.txt", b"b\n");
    r.write("d", "a.txt", b"a3\n");

    let committed = files_text(
        r.query(
            "d",
            GitQuery::Committed {
                baseline: baseline.clone(),
            },
        )
        .unwrap(),
    );
    assert_eq!(committed, "M\0a.txt\0D\0old.txt\0");
    assert!(
        !committed.contains("b.txt"),
        "uncommitted-only work is not committed work"
    );

    match r
        .query(
            "d",
            GitQuery::Since {
                baseline: baseline.clone(),
            },
        )
        .unwrap()
    {
        GitQueryResult::Since { diff, untracked } => {
            assert_eq!(diff, "M\0a.txt\0D\0old.txt\0");
            assert_eq!(untracked, "b.txt\0");
        }
        other => panic!("{:?}", other),
    }
    // Nothing since the baseline when the baseline is HEAD and the tree is clean.
    r.commit("d", "b.txt", "b\n", "three");
    r.write("d", "a.txt", b"a2\n");
    let now = r.head("d");
    assert_eq!(
        r.query(
            "d",
            GitQuery::Since {
                baseline: now.clone()
            }
        )
        .unwrap(),
        GitQueryResult::Since {
            diff: String::new(),
            untracked: String::new()
        }
    );
    assert_eq!(
        files_text(r.query("d", GitQuery::Committed { baseline: now }).unwrap()),
        ""
    );
}

#[test]
fn a_baseline_that_no_longer_exists_is_named_before_any_diff() {
    let r = Root::new();
    r.init("d");
    r.commit("d", "a.txt", "a\n", "one");
    for q in [
        GitQuery::Committed {
            baseline: NO_SUCH_COMMIT.to_string(),
        },
        GitQuery::Since {
            baseline: NO_SUCH_COMMIT.to_string(),
        },
    ] {
        assert_eq!(r.query("d", q).unwrap(), GitQueryResult::BaselineMissing);
    }
    // A blob object name is not a commit either.
    let out = r.raw("d", &["rev-parse", "HEAD:a.txt"]);
    let blob = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert_eq!(
        r.query("d", GitQuery::Since { baseline: blob }).unwrap(),
        GitQueryResult::BaselineMissing
    );
}

#[test]
fn blob_query_returns_text_binary_or_missing_and_treats_unborn_head_as_missing() {
    let r = Root::new();
    r.init("d");
    r.commit("d", "a.txt", "a\n", "one");
    let first = r.head("d");
    r.write("d", "bin.dat", b"\x00\x01\x02");
    assert!(r.raw("d", &["add", "bin.dat"]).status.success());
    r.write("d", "latin.txt", b"caf\xe9\n");
    assert!(r.raw("d", &["add", "latin.txt"]).status.success());
    assert!(r.raw("d", &["commit", "-q", "-m", "two"]).status.success());
    r.commit("d", "a.txt", "a2\n", "three");
    let blob = |rev: &str, path: &str| {
        r.query(
            "d",
            GitQuery::Blob {
                rev: rev.to_string(),
                path: path.to_string(),
            },
        )
        .unwrap()
    };
    assert_eq!(
        blob("HEAD", "a.txt"),
        GitQueryResult::Blob {
            text: "a2\n".to_string()
        }
    );
    assert_eq!(
        blob(&first, "a.txt"),
        GitQueryResult::Blob {
            text: "a\n".to_string()
        }
    );
    assert_eq!(blob("HEAD", "bin.dat"), GitQueryResult::Binary);
    assert_eq!(blob("HEAD", "latin.txt"), GitQueryResult::Binary);
    assert_eq!(blob(&first, "bin.dat"), GitQueryResult::Missing);
    assert_eq!(blob("HEAD", "nope.txt"), GitQueryResult::Missing);
    assert_eq!(blob(NO_SUCH_COMMIT, "a.txt"), GitQueryResult::Missing);
    r.init("fresh");
    r.write("fresh", "x.txt", b"x");
    assert!(r.raw("fresh", &["add", "x.txt"]).status.success());
    assert_eq!(
        r.query(
            "fresh",
            GitQuery::Blob {
                rev: "HEAD".to_string(),
                path: "x.txt".to_string()
            }
        )
        .unwrap(),
        GitQueryResult::Missing
    );
}

#[test]
fn a_conflict_shows_as_unmerged_in_status_and_in_the_since_listing() {
    let r = Root::new();
    r.init("d");
    r.commit("d", "a.txt", "a\n", "one");
    let baseline = r.head("d");
    assert!(r
        .raw("d", &["checkout", "-q", "-b", "other"])
        .status
        .success());
    r.commit("d", "a.txt", "other\n", "theirs");
    assert!(r.raw("d", &["checkout", "-q", "main"]).status.success());
    r.commit("d", "a.txt", "mine\n", "ours");
    let merge = r.raw("d", &["merge", "other"]);
    assert!(!merge.status.success(), "the merge must conflict");
    assert_eq!(
        files_text(r.query("d", GitQuery::Status).unwrap()),
        "UU a.txt\0"
    );
    // Against the baseline commit the file on disk is simply changed (it
    // holds the conflict markers); only the status listing knows it is unmerged.
    match r.query("d", GitQuery::Since { baseline }).unwrap() {
        GitQueryResult::Since { diff, .. } => assert_eq!(diff, "M\0a.txt\0"),
        other => panic!("{:?}", other),
    }
}

#[test]
fn query_arguments_are_validated_before_anything_spawns() {
    let r = Root::new();
    r.init("d");
    r.commit("d", "a.txt", "a\n", "one");
    let head = r.head("d");
    // The gate runs with a real git (the object format lookup), then every
    // query runs with a program that cannot start: a spawn would be a named
    // spawn failure, a validation refusal is not.
    assert!(matches!(
        r.query("d", GitQuery::Status),
        Ok(GitQueryResult::Files { .. })
    ));
    let env = GitEnv {
        program: Path::new("/nonexistent/git"),
        available: true,
        no_optional_locks: false,
    };
    let q = |q: GitQuery| query(&r.sub, "d", &env, &r.formats, &q).unwrap();
    let invalid = |result: GitQueryResult| match result {
        GitQueryResult::Failed { reason } => {
            assert!(reason.starts_with("invalid"), "{}", reason);
        }
        other => panic!("expected a validation refusal, got {:?}", other),
    };
    for baseline in ["main", "--output=/tmp/x", "HEAD", "HEAD~1", "abc", ""] {
        invalid(q(GitQuery::Committed {
            baseline: baseline.to_string(),
        }));
        invalid(q(GitQuery::Since {
            baseline: baseline.to_string(),
        }));
    }
    for (rev, path) in [
        ("main", "a.txt"),
        ("HEAD", "-a.txt"),
        ("HEAD", "../a.txt"),
        ("HEAD", "/etc/passwd"),
        ("HEAD", "a/./b"),
        ("HEAD", ""),
        ("HEAD", "a\0b"),
    ] {
        invalid(q(GitQuery::Blob {
            rev: rev.to_string(),
            path: path.to_string(),
        }));
    }
    // Valid arguments do reach the program, which cannot start.
    match q(GitQuery::Blob {
        rev: head,
        path: "a.txt".to_string(),
    }) {
        GitQueryResult::Failed { reason } => assert!(reason.contains("No such file"), "{}", reason),
        other => panic!("{:?}", other),
    }
}

#[test]
fn queries_pass_the_same_gate_as_facts_and_spawn_nothing_when_it_closes() {
    let r = Root::new();
    fs::create_dir_all(r.place_path("plain")).unwrap();
    assert_eq!(
        r.query("plain", GitQuery::Status).unwrap(),
        GitQueryResult::None
    );
    fs::create_dir_all(r.place_path("linked")).unwrap();
    fs::write(
        r.place_path("linked").join(".git"),
        "gitdir: ../elsewhere\n",
    )
    .unwrap();
    assert_eq!(
        r.query("linked", GitQuery::Head).unwrap(),
        GitQueryResult::Linked
    );
    r.init("attr");
    r.commit("attr", "a.txt", "a\n", "one");
    fs::create_dir_all(r.place_path("attr").join(".git/info")).unwrap();
    fs::write(
        r.place_path("attr").join(".git/info/attributes"),
        "* filter=x\n",
    )
    .unwrap();
    assert!(matches!(
        r.query("attr", GitQuery::Status).unwrap(),
        GitQueryResult::Refused { .. }
    ));
    r.init("d");
    let env = GitEnv {
        program: Path::new("/nonexistent/git"),
        available: false,
        no_optional_locks: false,
    };
    assert_eq!(
        query(&r.sub, "d", &env, &r.formats, &GitQuery::Head).unwrap(),
        GitQueryResult::Unavailable
    );
    assert!(query(&r.sub, "missing", &r.env(), &r.formats, &GitQuery::Head).is_err());
    assert!(query(&r.sub, "../d", &r.env(), &r.formats, &GitQuery::Head).is_err());
    let outside = r.base.join("outside");
    fs::create_dir_all(&outside).unwrap();
    symlink(&outside, r.place_path("link")).unwrap();
    assert!(query(&r.sub, "link", &r.env(), &r.formats, &GitQuery::Head).is_err());
}

// ---- Step 6: Open in Terminal ----

#[test]
fn terminal_command_is_open_dash_a_terminal_with_the_place_path_and_failures_are_named() {
    let r = Root::new();
    fs::create_dir_all(r.place_path("d")).unwrap();
    let cmd = terminal_command(Path::new(OPEN_PROGRAM), &r.place_path("d"));
    let args: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        args,
        vec![
            "-a".to_string(),
            "Terminal".to_string(),
            r.place_path("d").to_string_lossy().into_owned()
        ]
    );
    assert_eq!(cmd.get_program(), Path::new(OPEN_PROGRAM).as_os_str());
    // A program that exits zero succeeds; nothing waits on Terminal.
    assert_eq!(
        open_terminal(&r.sub, "d", Path::new("/usr/bin/true")),
        Ok(())
    );
    // A program that fails, or cannot start, is a named failure.
    let failed = open_terminal(&r.sub, "d", Path::new("/usr/bin/false")).unwrap_err();
    assert!(failed.contains("status 1"), "{}", failed);
    let missing = open_terminal(&r.sub, "d", Path::new("/nonexistent/open")).unwrap_err();
    assert!(missing.starts_with("cannot start open"), "{}", missing);
    // The place is resolved through the root handle: a missing place, a
    // climbing path or a symlinked place never reaches the program.
    for place in ["nowhere", "../d", "", "d/../../etc"] {
        assert!(
            open_terminal(&r.sub, place, Path::new("/usr/bin/true")).is_err(),
            "{}",
            place
        );
    }
    let outside = r.base.join("outside");
    fs::create_dir_all(&outside).unwrap();
    symlink(&outside, r.place_path("link")).unwrap();
    assert!(open_terminal(&r.sub, "link", Path::new("/usr/bin/true")).is_err());
}
