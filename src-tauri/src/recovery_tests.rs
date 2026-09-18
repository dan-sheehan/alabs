use super::*;

/// A disposable state folder, removed on drop.
struct TempState {
    base: PathBuf,
}

impl TempState {
    fn new(name: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "alabs-recovery-test-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        TempState { base }
    }
    fn dir(&self) -> PathBuf {
        dir_in(&self.base)
    }
}

impl Drop for TempState {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn stamp() -> FileStamp {
    FileStamp {
        identity: "16777232:1234".to_string(),
        mtime_secs: 1_700_000_000,
        mtime_nanos: 5,
        len: 12,
    }
}

fn draft(root: &str, rel: &str, revision: u64, contents: &str) -> Draft {
    Draft {
        version: FORMAT,
        root: root.to_string(),
        rel_path: rel.to_string(),
        stamp: Some(stamp()),
        revision,
        server_id: "server-one".to_string(),
        session_id: "tab-one".to_string(),
        updated_at: 1_000 + revision,
        contents: contents.to_string(),
    }
}

#[test]
fn a_draft_is_kept_and_read_back_whole() {
    let t = TempState::new("round-trip");
    put(&t.dir(), &draft("/r", "notes.md", 1, "hello")).unwrap();
    let listing = list(&t.dir(), "/r").unwrap();
    assert_eq!(listing.drafts.len(), 1);
    assert_eq!(listing.drafts[0], draft("/r", "notes.md", 1, "hello"));
    assert!(listing.unreadable.is_empty());
}

/// The recovery folder is not the layout folder. Throwing the layout away
/// must never mean throwing unsaved work away.
#[test]
fn recovery_lives_beside_the_layout_and_not_in_it() {
    let t = TempState::new("separate");
    put(&t.dir(), &draft("/r", "a.md", 1, "x")).unwrap();
    assert_eq!(t.dir(), t.base.join("recovery"));
    assert!(t.dir().is_dir());
    // The layout file's own name is untouched by anything here.
    assert!(!t.base.join(super::super::STATE_FILE).exists());
}

/// A draft is the user's unsaved work. Nothing else on the machine has any
/// business reading it.
#[test]
fn the_folder_and_its_records_are_readable_only_by_their_owner() {
    let t = TempState::new("permissions");
    put(&t.dir(), &draft("/r", "a.md", 1, "x")).unwrap();
    let folder = fs::metadata(t.dir()).unwrap().permissions().mode() & 0o777;
    assert_eq!(folder, 0o700, "folder mode was {:o}", folder);
    let record = fs::read_dir(t.dir())
        .unwrap()
        .flatten()
        .find(|e| e.file_name().to_string_lossy().ends_with(SUFFIX))
        .unwrap();
    let mode = record.metadata().unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "record mode was {:o}", mode);
}

/// A folder the user has made unwritable stays unwritable: the write is
/// refused and says so, rather than alabs quietly putting the mode back and
/// carrying on as though nothing were wrong.
#[test]
fn an_existing_folder_keeps_the_mode_it_has() {
    let t = TempState::new("folder-mode");
    put(&t.dir(), &draft("/r", "a.md", 1, "first")).unwrap();
    fs::set_permissions(t.dir(), fs::Permissions::from_mode(0o500)).unwrap();

    let err = put(&t.dir(), &draft("/r", "b.md", 1, "second"))
        .expect_err("an unwritable folder must refuse");
    assert!(err.contains("cannot write a recovery file"), "{}", err);
    assert_eq!(
        fs::metadata(t.dir()).unwrap().permissions().mode() & 0o777,
        0o500
    );
    // What was already kept is still there and still readable.
    assert_eq!(list(&t.dir(), "/r").unwrap().drafts[0].contents, "first");
    fs::set_permissions(t.dir(), fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn a_later_revision_replaces_the_record_rather_than_adding_one() {
    let t = TempState::new("replace");
    put(&t.dir(), &draft("/r", "a.md", 1, "one")).unwrap();
    put(&t.dir(), &draft("/r", "a.md", 2, "two")).unwrap();
    let listing = list(&t.dir(), "/r").unwrap();
    assert_eq!(listing.drafts.len(), 1);
    assert_eq!(listing.drafts[0].revision, 2);
    assert_eq!(listing.drafts[0].contents, "two");
}

/// The hard one: a write that finished late must not put an older draft back.
#[test]
fn an_older_revision_can_never_overwrite_a_newer_one() {
    let t = TempState::new("ordering");
    put(&t.dir(), &draft("/r", "a.md", 7, "newer")).unwrap();
    let err = put(&t.dir(), &draft("/r", "a.md", 6, "older"))
        .expect_err("an older revision must be refused");
    assert!(err.contains("newer draft"), "{}", err);
    assert_eq!(list(&t.dir(), "/r").unwrap().drafts[0].contents, "newer");
}

/// A caller that never learned whether its last write landed may write the
/// same revision again; that is a retry, not a step backwards.
#[test]
fn the_same_revision_may_be_written_again() {
    let t = TempState::new("retry");
    put(&t.dir(), &draft("/r", "a.md", 3, "text")).unwrap();
    put(&t.dir(), &draft("/r", "a.md", 3, "text")).unwrap();
    assert_eq!(list(&t.dir(), "/r").unwrap().drafts.len(), 1);
}

#[test]
fn an_unreadable_record_cannot_be_overwritten_by_a_new_draft() {
    let t = TempState::new("preserve-unreadable");
    ensure_dir(&t.dir()).unwrap();
    let path = t.dir().join(record_name("/r", "a.md"));
    fs::write(&path, "{ damaged but potentially recoverable text").unwrap();
    assert!(put(&t.dir(), &draft("/r", "a.md", 2, "new text")).is_err());
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "{ damaged but potentially recoverable text"
    );
}

#[test]
fn concurrent_recovery_writes_keep_the_highest_revision_whole() {
    let t = TempState::new("concurrent");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
    let workers: Vec<_> = (1..=16)
        .map(|revision| {
            let dir = t.dir();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let text = format!("revision {revision}\n").repeat(20_000);
                barrier.wait();
                let _ = put(&dir, &draft("/r", "a.md", revision, &text));
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let found = list(&t.dir(), "/r").unwrap();
    assert!(found.unreadable.is_empty());
    assert_eq!(found.drafts.len(), 1);
    assert_eq!(found.drafts[0].revision, 16);
    assert_eq!(found.drafts[0].contents, "revision 16\n".repeat(20_000));
}

#[test]
fn drafts_of_other_roots_are_neither_listed_nor_disturbed() {
    let t = TempState::new("roots");
    put(&t.dir(), &draft("/one", "a.md", 1, "first")).unwrap();
    put(&t.dir(), &draft("/two", "a.md", 1, "second")).unwrap();
    let one = list(&t.dir(), "/one").unwrap();
    assert_eq!(one.drafts.len(), 1);
    assert_eq!(one.drafts[0].contents, "first");
    // The other root's draft is still there afterwards.
    assert_eq!(list(&t.dir(), "/two").unwrap().drafts[0].contents, "second");
}

#[test]
fn a_draft_is_removed_only_once_its_revision_is_dealt_with() {
    let t = TempState::new("drop");
    put(&t.dir(), &draft("/r", "a.md", 4, "text")).unwrap();

    // A save of an older revision leaves the newer draft alone.
    let err = drop_draft(&t.dir(), "/r", "a.md", 3).expect_err("a newer draft must be kept");
    assert!(err.contains("edited since"), "{}", err);
    assert_eq!(list(&t.dir(), "/r").unwrap().drafts.len(), 1);

    // The revision that was saved, or anything past it, removes it.
    assert!(drop_draft(&t.dir(), "/r", "a.md", 4).unwrap());
    assert!(list(&t.dir(), "/r").unwrap().drafts.is_empty());
    // Removing what is not there is not a failure.
    assert!(!drop_draft(&t.dir(), "/r", "a.md", 4).unwrap());
}

#[test]
fn dropping_one_draft_never_touches_another() {
    let t = TempState::new("drop-one");
    put(&t.dir(), &draft("/r", "a.md", 1, "a")).unwrap();
    put(&t.dir(), &draft("/r", "b.md", 1, "b")).unwrap();
    assert!(drop_draft(&t.dir(), "/r", "a.md", 1).unwrap());
    let left = list(&t.dir(), "/r").unwrap();
    assert_eq!(left.drafts.len(), 1);
    assert_eq!(left.drafts[0].rel_path, "b.md");
}

/// A recovery file alabs cannot read is exactly what the user must be told
/// about. It is never skipped quietly and never deleted.
#[test]
fn an_unreadable_record_is_reported_and_left_alone() {
    let t = TempState::new("unreadable");
    put(&t.dir(), &draft("/r", "a.md", 1, "good")).unwrap();
    let broken = t.dir().join("0000000000000000000000000000ffff.json");
    fs::write(&broken, "{ not json").unwrap();
    let listing = list(&t.dir(), "/r").unwrap();
    assert_eq!(listing.drafts.len(), 1);
    assert_eq!(
        listing.unreadable,
        vec!["0000000000000000000000000000ffff.json"]
    );
    assert!(broken.exists(), "an unreadable record must not be removed");
}

#[test]
fn a_record_from_a_later_version_is_reported_rather_than_guessed_at() {
    let t = TempState::new("format");
    let mut future = draft("/r", "a.md", 1, "x");
    future.version = FORMAT + 1;
    let path = t.dir().join(record_name("/r", "a.md"));
    ensure_dir(&t.dir()).unwrap();
    fs::write(&path, serde_json::to_string(&future).unwrap()).unwrap();
    let listing = list(&t.dir(), "/r").unwrap();
    assert!(listing.drafts.is_empty());
    assert_eq!(listing.unreadable.len(), 1);
}

/// Two drafts must never share a record. The name is only an index; the root
/// and path inside it are the authority, and a mismatch refuses.
#[test]
fn a_record_belonging_to_another_draft_is_never_overwritten() {
    let t = TempState::new("collision");
    ensure_dir(&t.dir()).unwrap();
    // Write a record for one draft under the name another draft would use.
    let name = record_name("/r", "wanted.md");
    let squatter = draft("/r", "different.md", 1, "not mine");
    fs::write(
        t.dir().join(&name),
        serde_json::to_string(&squatter).unwrap(),
    )
    .unwrap();
    let err = put(&t.dir(), &draft("/r", "wanted.md", 1, "mine"))
        .expect_err("a foreign record must not be replaced");
    assert!(err.contains("another draft"), "{}", err);
    let kept = read_record(&t.dir().join(&name)).unwrap().unwrap();
    assert_eq!(kept.contents, "not mine");
}

#[test]
fn a_draft_larger_than_the_editor_would_open_is_refused() {
    let t = TempState::new("too-large");
    let huge = "x".repeat(MAX_CONTENTS_BYTES + 1);
    let err = put(&t.dir(), &draft("/r", "a.md", 1, &huge))
        .expect_err("an oversized draft must be refused");
    assert!(err.contains("larger than"), "{}", err);
    assert!(list(&t.dir(), "/r").unwrap().drafts.is_empty());
}

/// The rule that matters most: reaching the budget refuses the write. It
/// never deletes somebody's unsaved work to store somebody else's.
#[test]
fn a_full_recovery_folder_refuses_and_evicts_nothing() {
    let t = TempState::new("full");
    let big = "x".repeat(MAX_CONTENTS_BYTES);
    // Fill with the largest drafts the editor could produce until one is
    // refused. The refusal is the behaviour under test; how many fit is an
    // implementation detail of the envelope around the text.
    let mut stored = 0;
    let refusal = loop {
        match put(
            &t.dir(),
            &draft("/r", &format!("big-{}.md", stored), 1, &big),
        ) {
            Ok(_) => stored += 1,
            Err(e) => break e,
        }
        assert!(stored < 1000, "the budget was never reached");
    };
    assert!(refusal.contains("full"), "{}", refusal);
    assert!(refusal.contains("nothing was deleted"), "{}", refusal);
    // Everything that was already kept is still kept: the refusal removed
    // nothing, which is the whole point of refusing.
    let after = list(&t.dir(), "/r").unwrap();
    assert_eq!(after.drafts.len(), stored);
    for i in 0..stored {
        assert!(after
            .drafts
            .iter()
            .any(|d| d.rel_path == format!("big-{}.md", i)));
    }
}

/// A replacement of an existing record does not count twice against the
/// budget: a full folder can still be saved into by the drafts already in it.
#[test]
fn a_full_folder_still_accepts_a_new_revision_of_what_is_already_there() {
    let t = TempState::new("full-replace");
    let big = "x".repeat(MAX_CONTENTS_BYTES);
    let mut stored = 0;
    while put(
        &t.dir(),
        &draft("/r", &format!("big-{}.md", stored), 1, &big),
    )
    .is_ok()
    {
        stored += 1;
        assert!(stored < 1000, "the budget was never reached");
    }
    assert!(stored > 0);
    put(&t.dir(), &draft("/r", "big-0.md", 2, &big)).unwrap();
    let listing = list(&t.dir(), "/r").unwrap();
    assert_eq!(listing.drafts.len(), stored);
    let updated = listing
        .drafts
        .iter()
        .find(|d| d.rel_path == "big-0.md")
        .unwrap();
    assert_eq!(updated.revision, 2);
}

#[test]
fn a_missing_recovery_folder_is_an_empty_listing_not_a_failure() {
    let t = TempState::new("missing");
    let listing = list(&t.dir(), "/r").unwrap();
    assert!(listing.drafts.is_empty() && listing.unreadable.is_empty());
    assert!(!drop_draft(&t.dir(), "/r", "a.md", 1).unwrap());
}

#[test]
fn a_record_name_is_stable_and_distinguishes_roots_and_paths() {
    assert_eq!(record_name("/r", "a.md"), record_name("/r", "a.md"));
    assert_ne!(record_name("/r", "a.md"), record_name("/other", "a.md"));
    assert_ne!(record_name("/r", "a.md"), record_name("/r", "b.md"));
    // The separator is not something a path can contain, so "/r" + "a/b" and
    // "/r/a" + "b" cannot be made to collide.
    assert_ne!(record_name("/r", "a/b"), record_name("/r/a", "b"));
    assert!(record_name("/r", "a.md").ends_with(".json"));
    assert_eq!(record_name("/r", "a.md").len(), 32 + SUFFIX.len());
}

/// A draft is written whole or not at all: the temporary file is never left
/// behind for the listing to find, and is never itself a record.
#[test]
fn no_temporary_file_survives_a_write() {
    let t = TempState::new("atomic");
    put(&t.dir(), &draft("/r", "a.md", 1, "x")).unwrap();
    let leftovers: Vec<String> = fs::read_dir(t.dir())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "left behind: {:?}", leftovers);
}
