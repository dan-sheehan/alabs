use super::*;

/// The credential is the only one of the three admission facts a page can
/// supply, so a wrong guess must never be distinguishable from a wrong
/// length, and neither must ever be accepted.
#[test]
fn a_credential_matches_only_itself() {
    let real = "a".repeat(64);
    assert!(credential_matches(&real, &real));
    assert!(!credential_matches(&real, &"b".repeat(64)));
    assert!(!credential_matches(&real, &real[..63]));
    assert!(!credential_matches(&real, &format!("{}c", real)));
    assert!(!credential_matches(&real, ""));
    assert!(!credential_matches("", ""));
    // One wrong byte in the last position is refused like one in the first.
    let mut nearly = real.clone();
    nearly.replace_range(63..64, "b");
    assert!(!credential_matches(&real, &nearly));
}

#[test]
fn a_launch_credential_is_fresh_and_full_length() {
    let one = new_credential().unwrap();
    let two = new_credential().unwrap();
    assert_eq!(one.len(), 64);
    assert!(one
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    assert_ne!(one, two, "two launches must not share a credential");
}

/// The truth table of `admitted`. Anything but all three facts, exactly
/// right, is refused before an operation is reached.
#[test]
fn only_this_page_of_this_launch_is_admitted() {
    let real = "f".repeat(64);
    let ok = |host, origin, credential| admitted(host, origin, credential, &real);

    assert!(ok(Some(ADDR), Some(ORIGIN), Some(real.as_str())));

    // Missing facts.
    assert!(!ok(None, Some(ORIGIN), Some(real.as_str())));
    assert!(!ok(Some(ADDR), None, Some(real.as_str())));
    assert!(!ok(Some(ADDR), Some(ORIGIN), None));

    // A foreign or opaque origin, including the one a sandboxed frame sends.
    assert!(!ok(Some(ADDR), Some("null"), Some(real.as_str())));
    assert!(!ok(
        Some(ADDR),
        Some("https://evil.example"),
        Some(real.as_str())
    ));
    assert!(!ok(
        Some(ADDR),
        Some("http://localhost:43821"),
        Some(real.as_str())
    ));
    assert!(!ok(
        Some(ADDR),
        Some("https://127.0.0.1:43821"),
        Some(real.as_str())
    ));
    assert!(!ok(Some(ADDR), Some(""), Some(real.as_str())));

    // A name that resolves here is still not this host: this is what stops a
    // page on another origin reaching alabs by pointing a name at loopback.
    assert!(!ok(
        Some("alabs.example"),
        Some(ORIGIN),
        Some(real.as_str())
    ));
    assert!(!ok(
        Some("localhost:43821"),
        Some(ORIGIN),
        Some(real.as_str())
    ));
    assert!(!ok(Some("127.0.0.1"), Some(ORIGIN), Some(real.as_str())));
    assert!(!ok(
        Some("127.0.0.1:43822"),
        Some(ORIGIN),
        Some(real.as_str())
    ));

    // A wrong credential.
    assert!(!ok(Some(ADDR), Some(ORIGIN), Some("0")));
    assert!(!ok(Some(ADDR), Some(ORIGIN), Some(&"e".repeat(64))));
}

#[test]
fn the_state_folder_is_this_runtimes_own_and_never_the_desktop_apps() {
    let dir = state_dir_in(Path::new("/Users/someone")).unwrap();
    assert_eq!(
        dir,
        Path::new("/Users/someone/Library/Application Support/alabs-browser")
    );
    assert!(!dir.to_string_lossy().contains("me.dannysheehan.alabs"));
    assert!(state_dir_in(Path::new("relative/home")).is_err());
}

/// A disposable root, assets folder and home, removed on drop.
struct TempLaunch {
    base: PathBuf,
    root: PathBuf,
    assets: PathBuf,
}

impl TempLaunch {
    fn new(name: &str) -> Self {
        let base =
            std::env::temp_dir().join(format!("alabs-serve-test-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        let assets = base.join("assets");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("index.html"), "<!doctype html>").unwrap();
        TempLaunch { base, root, assets }
    }

    /// A server whose state folder is inside this disposable base, so nothing
    /// a test writes can reach the real browser state or its drafts.
    fn server(&self) -> Server {
        Server::open_in(&self.root, self.assets.clone(), self.base.join("state")).unwrap()
    }
}

impl Drop for TempLaunch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

#[test]
fn a_server_opens_its_root_once_and_holds_it() {
    let t = TempLaunch::new("opens");
    let server = Server::open(&t.root, t.assets.clone()).unwrap();
    let info = server.root_info().unwrap();
    // The path is read back from the handle, so it is the folder actually
    // held open rather than the pathname that was asked for.
    assert_eq!(PathBuf::from(&info.path), t.root.canonicalize().unwrap(),);
    assert_eq!(info.name, "root");
    assert_eq!(server.credential.len(), 64);
}

#[test]
fn a_server_without_built_assets_refuses_to_start() {
    let t = TempLaunch::new("no-assets");
    let err = Server::open(&t.root, t.base.join("missing"))
        .err()
        .expect("missing assets must refuse");
    assert!(err.contains("no built browser assets"), "{}", err);
}

#[test]
fn a_root_that_is_not_a_folder_refuses_to_start() {
    let t = TempLaunch::new("not-a-folder");
    let file = t.base.join("a-file");
    std::fs::write(&file, "not a folder").unwrap();
    assert!(Server::open(&file, t.assets.clone()).is_err());
    assert!(Server::open(&t.base.join("missing"), t.assets.clone()).is_err());
}

/// The one overlap rule, applied to this runtime's own state folder: a root
/// that contains it would let ordinary editing rewrite alabs' own state.
#[test]
fn a_root_overlapping_the_state_folder_refuses_to_start() {
    let home = state_dir().unwrap();
    let err = Server::open(&home, std::env::temp_dir())
        .err()
        .expect("the overlap must refuse");
    // It never reaches the assets check, which is the point: the overlap is
    // refused before anything else about the launch is considered.
    assert!(
        err.contains("overlaps the alabs application data folder") || err.contains("cannot open"),
        "{}",
        err
    );
}

/// "Exact" means one. A request carrying the header twice does not have an
/// exact one, and must not be admitted on whichever value arrived first.
#[test]
fn a_header_given_twice_is_not_an_exact_header() {
    use axum::http::{header, HeaderMap, HeaderValue};
    let one = |name: HeaderName, values: &[&str]| {
        let mut headers = HeaderMap::new();
        for v in values {
            headers.append(name.clone(), HeaderValue::from_str(v).unwrap());
        }
        only_header(&headers, name)
    };

    assert_eq!(one(header::HOST, &[ADDR]), Some(ADDR.to_string()));
    assert_eq!(one(header::HOST, &[]), None);
    // The right value first and a foreign one after is the shape that would
    // otherwise slip through.
    assert_eq!(one(header::HOST, &[ADDR, "evil.example"]), None);
    assert_eq!(one(header::HOST, &["evil.example", ADDR]), None);
    assert_eq!(one(header::ORIGIN, &[ORIGIN, "https://evil.example"]), None);
    assert_eq!(
        one(HeaderName::from_static(CREDENTIAL_HEADER), &["a", "b"]),
        None
    );

    // A value that is not text is refused rather than lossily converted.
    let mut headers = HeaderMap::new();
    headers.append(
        header::HOST,
        HeaderValue::from_bytes(&[0xff, 0xfe]).unwrap(),
    );
    assert_eq!(only_header(&headers, header::HOST), None);
}

/// A session name is chosen by the page and ends up in a recovery record on
/// disk, so it is bounded and made of characters that stay themselves.
#[test]
fn a_session_name_is_bounded_and_plain() {
    let ok = |s: &str| session_name(Some(s.to_string())).is_some();
    assert!(ok("a"));
    assert!(ok("0f3a-9c2e_4b1d"));
    assert!(ok(&"a".repeat(MAX_SESSION_CHARS)));

    assert!(!ok(""));
    assert!(!ok(&"a".repeat(MAX_SESSION_CHARS + 1)));
    assert!(!ok("../escape"));
    assert!(!ok("has space"));
    assert!(!ok("dot.dot"));
    assert!(!ok("null\0byte"));
    assert!(session_name(None).is_none());
}

/// The one-writer rule, as state: opening another window never disturbs the
/// window that is editing, and only an explicit takeover moves the role.
#[tokio::test]
async fn one_window_edits_and_another_starts_read_only() {
    let t = TempLaunch::new("one-writer");
    let server = Arc::new(t.server());
    let ask = |who: &str, take_over: bool| {
        let server = server.clone();
        let who = who.to_string();
        async move {
            claim_writing(
                State(server),
                Extension(Session(Some(who))),
                Json(Claim { take_over }),
            )
            .await
            .map(|Json(w)| w)
            .map_err(|Refusal(_, why)| why)
        }
    };

    // Nobody is editing, so the first window that asks gets the role.
    assert_eq!(
        ask("one", false).await.unwrap(),
        Writer {
            writing: true,
            holder: Some("one".to_string())
        }
    );
    // Asking again is not a takeover from itself.
    assert!(ask("one", false).await.unwrap().writing);

    // A second window opens. It is told who is editing, and is not.
    assert_eq!(
        ask("two", false).await.unwrap(),
        Writer {
            writing: false,
            holder: Some("one".to_string())
        }
    );
    // And the first window still is.
    let Json(status) = writing_status(
        State(server.clone()),
        Extension(Session(Some("one".into()))),
    )
    .await
    .unwrap();
    assert!(status.writing);

    // The user takes over in the second window.
    assert_eq!(
        ask("two", true).await.unwrap(),
        Writer {
            writing: true,
            holder: Some("two".to_string())
        }
    );

    // The old writer is now refused, and finds out by being told so.
    let refused = save_file(
        State(server.clone()),
        Extension(Session(Some("one".into()))),
        Json(SaveArgs {
            rel_path: "a.md".to_string(),
            content: "text".to_string(),
            expected: FileStamp {
                identity: "1:1".to_string(),
                mtime_secs: 0,
                mtime_nanos: 0,
                len: 0,
            },
        }),
    )
    .await;
    let Err(Refusal(status, why)) = refused else {
        panic!("the old writer must be refused");
    };
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(why.contains("another alabs window is editing"), "{}", why);

    // Giving it up is only ever the holder's to do.
    let Json(ignored) = release_writing(
        State(server.clone()),
        Extension(Session(Some("one".into()))),
    )
    .await
    .unwrap();
    assert_eq!(ignored.holder, Some("two".to_string()));
    let Json(given) = release_writing(
        State(server.clone()),
        Extension(Session(Some("two".into()))),
    )
    .await
    .unwrap();
    assert_eq!(given.holder, None);
}

/// A page that does not say which window it is cannot change a file and
/// cannot claim the editing role.
#[tokio::test]
async fn a_request_with_no_window_name_changes_nothing() {
    let t = TempLaunch::new("no-session");
    let server = Arc::new(t.server());
    let refused = claim_writing(
        State(server.clone()),
        Extension(Session(None)),
        Json(Claim { take_over: true }),
    )
    .await;
    assert!(matches!(refused, Err(Refusal(_, why)) if why.contains("which alabs window")));

    let created = create_file(
        State(server.clone()),
        Extension(Session(None)),
        Json(CreateArgs {
            parent_rel: String::new(),
            name: "new.md".to_string(),
        }),
    )
    .await;
    assert!(created.is_err());
    assert!(!t.root.join("new.md").exists());
}

/// The rule that a takeover must not cut a save in half: the role does not
/// move while a mutation is running, and a mutation that arrives during a
/// takeover is decided against the new holder, not the old one.
#[tokio::test]
async fn a_takeover_waits_for_the_save_that_is_already_running() {
    let t = TempLaunch::new("drain");
    let server = Arc::new(t.server());
    let Json(editing) = claim_writing(
        State(server.clone()),
        Extension(Session(Some("one".into()))),
        Json(Claim { take_over: false }),
    )
    .await
    .unwrap();
    assert!(editing.writing);

    // Stand in for a save that is on the disk: exactly the guard a mutation
    // holds, for as long as it holds it.
    let in_flight = writing(&server, &Session(Some("one".into())))
        .await
        .unwrap();

    let taking = tokio::spawn({
        let server = server.clone();
        async move {
            claim_writing(
                State(server),
                Extension(Session(Some("two".into()))),
                Json(Claim { take_over: true }),
            )
            .await
            .map(|Json(w)| w)
            .ok()
        }
    });

    // While the mutation is in flight the takeover cannot complete, and the
    // role has not moved.
    tokio::task::yield_now().await;
    assert!(!taking.is_finished());
    assert!(server.writing.held_by("one"));

    // The save finishes; only then does the role change hands.
    drop(in_flight);
    let taken = taking.await.unwrap().expect("the takeover must complete");
    assert_eq!(taken.holder, Some("two".to_string()));
    assert!(server.writing.held_by("two"));
}

#[test]
fn a_cancelled_request_keeps_the_gate_until_its_disk_work_finishes() {
    let t = TempLaunch::new("cancelled-mutation");
    let server = Arc::new(t.server());
    server.writing.claim_free("one").unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        // Occupy the disk worker so the real create-file handler queues its
        // mutation. Cancelling its request cannot cancel queued disk work.
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let occupied = tokio::task::spawn_blocking(move || {
            started_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
        });
        started_rx.await.unwrap();
        let request = tokio::spawn({
            let server = server.clone();
            async move {
                create_file(
                    State(server),
                    Extension(Session(Some("one".into()))),
                    Json(CreateArgs {
                        parent_rel: "".into(),
                        name: "queued.txt".into(),
                    }),
                )
                .await
            }
        });
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        let queued = server.writing.gate.try_write().is_err();
        request.abort();
        let _ = request.await;
        let gate_still_held = server.writing.gate.try_write().is_err();
        finish_tx.send(()).unwrap();
        occupied.await.unwrap();
        let _drained = server.writing.gate.write().await;
        assert!(
            queued,
            "the actual mutation must have reached the disk queue"
        );
        assert!(
            gate_still_held,
            "request cancellation must not admit a takeover while disk work remains"
        );
        assert!(t.root.join("queued.txt").is_file());
    });
}

#[tokio::test]
async fn releasing_editing_waits_for_in_flight_mutations() {
    let t = TempLaunch::new("release-mutation");
    let server = Arc::new(t.server());
    server.writing.claim_free("one").unwrap();
    let in_flight = writing(&server, &Session(Some("one".into())))
        .await
        .unwrap();
    let releasing = tokio::spawn({
        let server = server.clone();
        async move { release_writing(State(server), Extension(Session(Some("one".into())))).await }
    });
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    let still_owned = server.writing.held_by("one");
    drop(in_flight);
    let _ = releasing.await.unwrap().unwrap();
    assert!(
        still_owned,
        "page unload must not hand editing away while a mutation runs"
    );
}

/// A process's name for itself: one per lifetime, never the credential, and
/// never something a request is admitted on.
#[tokio::test]
async fn a_server_names_this_lifetime_and_only_this_lifetime() {
    let t = TempLaunch::new("identity");
    let one = t.server();
    let two = t.server();
    assert_eq!(one.server_id.len(), 32);
    assert_ne!(
        one.server_id, two.server_id,
        "a restart must be tellable from a reconnect"
    );
    assert_ne!(one.server_id, one.credential);

    let Json(sent) = bootstrap(State(Arc::new(one))).await.unwrap();
    assert_eq!(sent.server_id.len(), 32);
    // The browser can write now; a read-only window is the editing role's
    // doing, not this flag's.
    assert!(sent.can_edit);
}

/// Holding the editing role says who may write. It says nothing about whether
/// this particular write is still the right one. The two checks are separate
/// and both have to pass.
#[tokio::test]
async fn the_editing_role_does_not_excuse_a_stale_save() {
    let t = TempLaunch::new("stale");
    std::fs::write(t.root.join("a.md"), "on disk").unwrap();
    let server = Arc::new(t.server());
    let Json(editing) = claim_writing(
        State(server.clone()),
        Extension(Session(Some("one".into()))),
        Json(Claim { take_over: false }),
    )
    .await
    .unwrap();
    assert!(editing.writing);

    let stale = FileStamp {
        identity: "1:1".to_string(),
        mtime_secs: 1,
        mtime_nanos: 0,
        len: 7,
    };
    let refused = save_file(
        State(server.clone()),
        Extension(Session(Some("one".into()))),
        Json(SaveArgs {
            rel_path: "a.md".to_string(),
            content: "mine".to_string(),
            expected: stale,
        }),
    )
    .await;
    let Err(Refusal(_, why)) = refused else {
        panic!("a stale stamp must be refused even for the writer");
    };
    assert!(why.contains("changed on disk"), "{}", why);
    assert_eq!(
        std::fs::read_to_string(t.root.join("a.md")).unwrap(),
        "on disk"
    );
}

/// Recovery is deliberately not behind the editing role: a takeover must not
/// strand the other window's unsaved work at the moment it most needs keeping.
#[tokio::test]
async fn a_window_that_is_not_editing_can_still_keep_its_draft() {
    let t = TempLaunch::new("recovery-role");
    let server = Arc::new(t.server());
    let Json(editing) = claim_writing(
        State(server.clone()),
        Extension(Session(Some("one".into()))),
        Json(Claim { take_over: false }),
    )
    .await
    .unwrap();
    assert!(editing.writing);

    // "two" is read-only, and still keeps what it had typed.
    let Json(stored) = recovery_put(
        State(server.clone()),
        Extension(Session(Some("two".into()))),
        Json(DraftArgs {
            rel_path: "a.md".to_string(),
            stamp: None,
            revision: 1,
            contents: "unsaved work".to_string(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(stored.revision, 1);

    let Json(listing) = recovery_list(State(server.clone())).await.unwrap();
    assert_eq!(listing.drafts.len(), 1);
    assert_eq!(listing.drafts[0].contents, "unsaved work");
    assert_eq!(listing.drafts[0].session_id, "two");
    assert_eq!(listing.drafts[0].server_id, server.server_id);

    // And it is kept under this server's own state folder, not the root.
    assert!(server.recovery_dir().starts_with(&server.state_dir));
    assert!(!server.recovery_dir().starts_with(&t.root));
}

// ---------------------------------------------------------------------------
// Checkpoint 4: search, Git questions and the Terminal handoff.
// ---------------------------------------------------------------------------

/// Read one streamed search to its end: the batches it sent, in order, and
/// the summary that ended it. A stream with no summary is a failure here, as
/// it is in the page.
async fn read_search(response: Response) -> (Vec<serde_json::Value>, serde_json::Value) {
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("application/x-ndjson"),
    );
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the search body");
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    let mut batches = Vec::new();
    let mut summary = None;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let value: serde_json::Value = serde_json::from_str(line).expect(line);
        match value["kind"].as_str() {
            Some("batch") => batches.push(value),
            Some("summary") => {
                assert!(summary.is_none(), "one summary, and it is the last line");
                summary = Some(value["summary"].clone());
            }
            other => panic!("unknown line kind {:?}", other),
        }
    }
    (batches, summary.expect("the summary ends a search"))
}

async fn search(
    server: &Arc<Server>,
    query: &str,
    id: u64,
    scope: &str,
) -> Result<Response, String> {
    search_subject(
        State(server.clone()),
        Json(SearchArgs {
            query: query.to_string(),
            search_id: id,
            scope: scope.to_string(),
            expected_session: None,
        }),
    )
    .await
    .map_err(|Refusal(_, why)| why)
}

/// A search answers in pieces down the one request that asked for it: batches
/// of hits as they are found, then the summary, and nothing after it.
#[tokio::test]
async fn a_search_streams_its_hits_and_ends_with_its_summary() {
    let t = TempLaunch::new("search");
    std::fs::create_dir_all(t.root.join("work/src")).unwrap();
    std::fs::write(t.root.join("work/notes.md"), "a needle in here\n").unwrap();
    std::fs::write(t.root.join("work/src/a.py"), "# nothing\n").unwrap();
    // Beside the place, never inside it: a search is bound to its scope.
    std::fs::write(t.root.join("elsewhere.md"), "a needle out here\n").unwrap();
    let server = Arc::new(t.server());

    let (batches, summary) = read_search(search(&server, "needle", 1, "work").await.unwrap()).await;
    assert_eq!(batches.len(), 1, "{:?}", batches);
    assert_eq!(batches[0]["search_id"], 1);
    let results = batches[0]["results"].as_array().unwrap();
    assert_eq!(results.len(), 1, "{:?}", results);
    assert_eq!(results[0]["rel_path"], "work/notes.md");
    assert_eq!(results[0]["line"], 1);
    assert_eq!(summary["results"], 1);
    assert_eq!(summary["cancelled"], false);
    assert_eq!(summary["truncated"], false);

    // The file with the same word outside the place was never reached.
    let (batches, summary) =
        read_search(search(&server, "out here", 2, "work").await.unwrap()).await;
    assert!(batches.is_empty(), "{:?}", batches);
    assert_eq!(summary["results"], 0);
}

/// A scope that is not a folder inside the root is refused before one byte of
/// an answer exists, because after that there is no way left to say no.
#[tokio::test]
async fn a_search_outside_the_root_is_refused_before_anything_streams() {
    let t = TempLaunch::new("search-scope");
    std::fs::create_dir_all(t.root.join("work")).unwrap();
    let server = Arc::new(t.server());
    for scope in ["..", "../work", "", "nowhere", "/etc"] {
        assert!(
            search(&server, "x", 1, scope).await.is_err(),
            "scope {:?} must be refused",
            scope
        );
    }
    // And the one good scope still works, so the refusals are about the path.
    assert!(search(&server, "x", 2, "work").await.is_ok());
}

/// Starting a search cancels the one before it, and a cleanup arriving late
/// never stops a newer walk. Both are the shared core's rule; the route only
/// has to name the right search.
#[tokio::test]
async fn a_later_search_cancels_an_earlier_one_and_a_late_cleanup_does_not() {
    let t = TempLaunch::new("search-cancel");
    std::fs::create_dir_all(t.root.join("work")).unwrap();
    std::fs::write(t.root.join("work/a.md"), "needle\n").unwrap();
    let server = Arc::new(t.server());

    let (_, summary) = read_search(search(&server, "needle", 7, "work").await.unwrap()).await;
    assert_eq!(summary["results"], 1);
    assert!(server.subject.search_is_current(7));

    // The cleanup of a search that has already been replaced must not stop
    // the one that is running now.
    let Json(()) = cancel_search(State(server.clone()), Json(CancelArgs { search_id: 6 }))
        .await
        .unwrap();
    assert!(server.subject.search_is_current(7));

    let Json(()) = cancel_search(State(server.clone()), Json(CancelArgs { search_id: 7 }))
        .await
        .unwrap();
    assert!(!server.subject.search_is_current(7));
}

/// The browser asks Git its questions with optional index writes disabled: a
/// process the user is not looking at never takes the index lock of a
/// repository they are also using in Terminal.
#[test]
fn the_browsers_git_never_takes_the_index_lock() {
    assert!(git_env().no_optional_locks);
}

/// The change questions and the Terminal handoff are routed, go through the
/// same gate as every other Git call, and spawn nothing for a folder that is
/// not a repository.
#[tokio::test]
async fn change_questions_answer_for_a_place_that_is_not_a_repository() {
    let t = TempLaunch::new("git-query");
    std::fs::create_dir_all(t.root.join("work")).unwrap();
    let server = Arc::new(t.server());
    let Json(answer) = git_query(
        State(server.clone()),
        Json(QueryArgs {
            place: "work".to_string(),
            query: git::GitQuery::Head,
        }),
    )
    .await
    .unwrap();
    assert_eq!(answer, git::GitQueryResult::None);

    // A place outside the root never reaches the helper at all.
    let refused = git_query(
        State(server.clone()),
        Json(QueryArgs {
            place: "../work".to_string(),
            query: git::GitQuery::Status,
        }),
    )
    .await;
    assert!(refused.is_err());

    // The same gate guards the Terminal handoff: the path it would hand over
    // is read back from the place's own handle, so this one is refused too.
    let refused = open_terminal(
        State(server.clone()),
        Json(Place {
            place: "../work".to_string(),
        }),
    )
    .await;
    assert!(refused.is_err());
}

/// Batched, not collected: a search with more hits than one batch holds sends
/// several, so the page fills as the walk goes rather than after it.
#[tokio::test]
async fn a_long_search_arrives_in_more_than_one_batch() {
    let t = TempLaunch::new("search-batches");
    std::fs::create_dir_all(t.root.join("work")).unwrap();
    for i in 0..(SEARCH_BATCH * 2 + 3) {
        std::fs::write(t.root.join(format!("work/f{}.txt", i)), "needle\n").unwrap();
    }
    let server = Arc::new(t.server());
    let (batches, summary) = read_search(search(&server, "needle", 1, "work").await.unwrap()).await;
    assert!(batches.len() >= 3, "{} batches", batches.len());
    for batch in &batches {
        assert!(
            batch["results"].as_array().unwrap().len() <= SEARCH_BATCH,
            "a batch is at most {} hits",
            SEARCH_BATCH
        );
    }
    let sent: usize = batches
        .iter()
        .map(|b| b["results"].as_array().unwrap().len())
        .sum();
    assert_eq!(sent as u64, summary["results"].as_u64().unwrap());
}

/// A streamed search outlives the request that started it, so the walk itself
/// is what has to be bounded. With every walk permit held, a search waits for
/// one rather than starting a fifth walk of the disk; it runs as soon as one
/// is free, and never fails for having had to wait.
#[tokio::test]
async fn a_walk_is_bounded_for_as_long_as_it_walks() {
    let t = TempLaunch::new("search-bound");
    std::fs::create_dir_all(t.root.join("work")).unwrap();
    std::fs::write(t.root.join("work/a.md"), "needle\n").unwrap();
    let server = Arc::new(t.server());
    assert_eq!(server.walks.available_permits(), MAX_CONCURRENT_WALKS);

    let held = server
        .walks
        .clone()
        .acquire_many_owned(MAX_CONCURRENT_WALKS as u32)
        .await
        .unwrap();
    let asking = tokio::spawn({
        let server = server.clone();
        async move { search(&server, "needle", 1, "work").await }
    });
    // Nothing else can take a permit, so the search cannot have got past the
    // bound however long it is given.
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert!(
        !asking.is_finished(),
        "a search must wait for a walk permit rather than start a fifth walk"
    );

    drop(held);
    let (_, summary) = read_search(asking.await.unwrap().unwrap()).await;
    assert_eq!(summary["results"], 1);
}

#[test]
fn disconnect_cancels_a_search_even_before_its_first_match() {
    let (_tx, rx) = tokio::sync::mpsc::channel::<String>(SEARCH_QUEUE);
    let gone = Arc::new(AtomicBool::new(false));
    let body = Body::from_stream(SearchStream(rx, gone.clone()));
    assert!(!gone.load(Ordering::SeqCst));
    drop(body);
    assert!(gone.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_blocked_stream_holds_its_walk_permit_until_disconnect() {
    let t = TempLaunch::new("search-disconnect");
    std::fs::create_dir_all(t.root.join("work")).unwrap();
    std::fs::write(t.root.join("work/a.txt"), "needle\n".repeat(1000)).unwrap();
    let server = Arc::new(t.server());
    let response = search(&server, "needle", 1, "work").await.unwrap();
    // The response head is complete, but its unread body fills the bounded
    // queue and keeps the walk alive. Its permit must still be held.
    assert_eq!(server.walks.available_permits(), MAX_CONCURRENT_WALKS - 1);
    drop(response);
    let _permits = tokio::time::timeout(
        Duration::from_secs(2),
        server.walks.acquire_many(MAX_CONCURRENT_WALKS as u32),
    )
    .await
    .expect("disconnect must stop the walk and release its permit")
    .unwrap();
}

/// Exercise the real router, including admission, extraction and serialization.
async fn api(
    server: &Arc<Server>,
    route: &str,
    who: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    use tower::ServiceExt;
    let response = router(server.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/{route}"))
                .header(header::HOST, ADDR)
                .header(header::ORIGIN, ORIGIN)
                .header(CREDENTIAL_HEADER, &server.credential)
                .header(SESSION_HEADER, who)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), MAX_BODY_BYTES)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
async fn view_routes_share_the_root_and_write_only_for_the_current_editor() {
    use serde_json::json;
    let t = TempLaunch::new("view-routes");
    std::fs::create_dir(t.root.join("work")).unwrap();
    std::fs::write(t.root.join("work/README.md"), "# Work\n").unwrap();
    let server = Arc::new(t.server());
    let root = server.root_info().unwrap().path;
    let (status, session) = api(
        &server,
        "view-session",
        "one",
        json!({"expectedRoot": root}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        api(
            &server,
            "view-session",
            "one",
            json!({"expectedRoot": "/wrong"})
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let inventory = api(
        &server,
        "collect-inventory",
        "one",
        json!({"place":"work", "expectedSession":session}),
    )
    .await;
    assert_eq!(inventory.0, StatusCode::OK);
    assert_eq!(inventory.1["entries"][0]["path"], "README.md");
    for place in ["../outside", "/outside", "work/../work"] {
        assert_eq!(
            api(
                &server,
                "collect-inventory",
                "one",
                json!({"place":place, "expectedSession":session})
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(
        api(
            &server,
            "collect-inventory",
            "one",
            json!({"place":"work", "expectedSession":999})
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut args = json!({"place":"work", "expectedRoot":root, "expectedSession":session, "viewJson":"{}", "mapSvg":"<svg/>", "replace":true});
    for (route, folder) in [
        ("write-view-files", "work"),
        ("write-root-view-files", ".root"),
    ] {
        assert_eq!(
            api(&server, route, "two", args.clone()).await.0,
            StatusCode::CONFLICT
        );
        server.writing.claim_free("one").unwrap();
        assert_eq!(
            api(&server, route, "one", args.clone()).await.0,
            StatusCode::OK
        );
        let map = t.root.join(format!("views/{folder}/map.svg"));
        assert_eq!(std::fs::read_to_string(&map).unwrap(), "<svg/>");
        args["expectedSession"] = json!(999);
        args["mapSvg"] = json!("changed");
        assert_eq!(
            api(&server, route, "one", args.clone()).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        args["expectedSession"] = session.clone();
        args["expectedRoot"] = json!("/wrong");
        assert_eq!(
            api(&server, route, "one", args.clone()).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        args["expectedRoot"] = json!(root);
        assert_eq!(std::fs::read_to_string(&map).unwrap(), "<svg/>");
        args["mapSvg"] = json!("<svg/>");
    }
    api(&server, "claim-writing", "two", json!({"takeOver":true})).await;
    for route in ["write-view-files", "write-root-view-files"] {
        assert_eq!(
            api(&server, route, "one", args.clone()).await.0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            api(&server, route, "two", args.clone()).await.0,
            StatusCode::OK
        );
    }
}

#[tokio::test]
async fn model_routes_refuse_stale_sessions_and_oversized_input_without_inference() {
    use serde_json::json;
    let t = TempLaunch::new("model-routes");
    let server = Arc::new(t.server());
    let session = server.subject.root_session.load(Ordering::SeqCst);
    for route in ["ask-local-model", "generate-local-model-json"] {
        let mut args = json!({"model":"", "system":"", "prompt":"", "expectedSession":999});
        assert_eq!(
            api(&server, route, "one", args.clone()).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        args["expectedSession"] = json!(session);
        let answer = api(&server, route, "one", args.clone()).await;
        assert_eq!(answer.0, StatusCode::OK);
        assert_eq!(answer.1["kind"], "not_installed");
        args["model"] = json!("unused-test-model");
        args["prompt"] = json!("x".repeat(local_model::MAX_INPUT_BYTES + 1));
        let answer = api(&server, route, "one", args).await;
        assert_eq!(answer.0, StatusCode::OK);
        assert_eq!(answer.1["reason"], "input too large");
    }
}

#[test]
fn only_inference_has_a_longer_transport_deadline() {
    assert_eq!(
        request_timeout("/api/v1/generate-local-model-json"),
        Duration::from_secs(610)
    );
    assert_eq!(
        request_timeout("/api/v1/ask-local-model"),
        Duration::from_secs(130)
    );
    for path in [
        "/",
        "/api/v1/save-file",
        "/api/v1/list-local-models",
        "/api/v1/write-view-files",
        "/api/v1/write-root-view-files",
        "/api/v1/generate-local-model-json/extra",
    ] {
        assert_eq!(request_timeout(path), Duration::from_secs(30));
    }
}

#[test]
fn cancelled_inference_keeps_its_permit_without_blocking_navigation_or_takeover() {
    let t = TempLaunch::new("cancelled-inference");
    let server = Arc::new(t.server());
    server.writing.claim_free("one").unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let occupied = tokio::task::spawn_blocking(move || {
            started_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
        });
        started_rx.await.unwrap();
        let args = || ModelArgs {
            model: "".into(),
            system: "".into(),
            prompt: "".into(),
            expected_session: server.subject.root_session.load(Ordering::SeqCst),
        };
        let request = tokio::spawn(model_call(server.clone(), args(), true));
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        let queued = server.models.available_permits() == 0;
        request.abort();
        let _ = request.await;
        let retained = server.models.available_permits() == 0;
        let refused = model_call(server.clone(), args(), true)
            .await
            .unwrap_err()
            .0;
        assert!(bootstrap(State(server.clone())).await.is_ok());
        let takeover = claim_writing(
            State(server.clone()),
            Extension(Session(Some("two".into()))),
            Json(Claim { take_over: true }),
        )
        .await
        .unwrap();
        finish_tx.send(()).unwrap();
        occupied.await.unwrap();
        let _finished = server.models.acquire().await.unwrap();
        assert!(queued && retained);
        assert_eq!(refused, StatusCode::TOO_MANY_REQUESTS);
        assert!(takeover.0.writing);
    });
}

#[tokio::test]
async fn every_new_operation_requires_exact_transport_admission() {
    use tower::ServiceExt;
    let t = TempLaunch::new("view-model-admission");
    let server = Arc::new(t.server());
    for route in [
        "view-session",
        "collect-inventory",
        "list-local-models",
        "ask-local-model",
        "generate-local-model-json",
        "write-view-files",
        "write-root-view-files",
    ] {
        let response = router(server.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/v1/{route}"))
                    .header(header::HOST, ADDR)
                    .header(header::ORIGIN, "https://foreign.example")
                    .header(CREDENTIAL_HEADER, &server.credential)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{route}");
    }
}

#[test]
fn cancelled_view_writes_hold_editing_until_both_files_finish() {
    for root_view in [false, true] {
        let t = TempLaunch::new(if root_view {
            "cancelled-root-view"
        } else {
            "cancelled-place-view"
        });
        std::fs::create_dir(t.root.join("work")).unwrap();
        let server = Arc::new(t.server());
        server.writing.claim_free("one").unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (finish_tx, finish_rx) = std::sync::mpsc::channel();
            let occupied = tokio::task::spawn_blocking(move || {
                started_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
            });
            started_rx.await.unwrap();
            let request = tokio::spawn({
                let server = server.clone();
                async move {
                    let args = ViewWriteArgs {
                        expected_root: server.root_info().unwrap().path,
                        expected_session: server.subject.root_session.load(Ordering::SeqCst),
                        view_json: "{}".into(),
                        map_svg: "<svg/>".into(),
                        replace: true,
                    };
                    let session = Extension(Session(Some("one".into())));
                    if root_view {
                        write_root_view_files(State(server), session, Json(args)).await
                    } else {
                        write_view_files(
                            State(server),
                            session,
                            Json(PlaceViewWriteArgs {
                                place: "work".into(),
                                view: args,
                            }),
                        )
                        .await
                    }
                }
            });
            for _ in 0..10 {
                tokio::task::yield_now().await;
            }
            let queued = server.writing.gate.try_write().is_err();
            request.abort();
            let _ = request.await;
            let held = server.writing.gate.try_write().is_err();
            finish_tx.send(()).unwrap();
            occupied.await.unwrap();
            let _drained = server.writing.gate.write().await;
            assert!(queued && held);
            let dir = t.root.join(if root_view {
                "views/.root"
            } else {
                "views/work"
            });
            assert_eq!(
                std::fs::read_to_string(dir.join("map.svg")).unwrap(),
                "<svg/>"
            );
            assert_eq!(
                std::fs::read_to_string(dir.join("view.json")).unwrap(),
                "{}"
            );
        });
    }
}
