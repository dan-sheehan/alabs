use super::*;
use std::os::unix::fs::{symlink, MetadataExt as _};
use std::sync::atomic::{AtomicUsize, Ordering};

/// A fresh subject folder under the system temp dir, removed on drop. `sub`
/// is the open handle every helper takes; `root` and `outside` are paths for
/// the test to set up and inspect the disk. `trash` stands in for the user's
/// Trash folder, on the same volume.
struct TempSubject {
    root: PathBuf,
    outside: PathBuf,
    trash: PathBuf,
    sub: SubjectRoot,
}

impl TempSubject {
    fn new() -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("alabs-test-{}-{}", std::process::id(), id));
        let root = base.join("subject");
        let outside = base.join("outside");
        let trash = base.join("trash");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&trash).unwrap();
        let sub = SubjectRoot::open(&root).unwrap();
        Self {
            root: root.canonicalize().unwrap(),
            outside,
            trash,
            sub,
        }
    }

    fn write(&self, rel: &str, bytes: &[u8]) {
        fs::write(self.root.join(rel), bytes).unwrap();
    }

    fn stamp(&self, rel: &str) -> FileStamp {
        FileStamp::of_std(&fs::metadata(self.root.join(rel)).unwrap()).unwrap()
    }

    fn trash_dir(&self) -> Dir {
        Dir::open_ambient_dir(&self.trash, ambient_authority()).unwrap()
    }

    fn trash(&self, rel: &str) -> Result<(), String> {
        trash_in(&self.sub, rel, &self.trash_dir())
    }

    fn names(&self, dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for TempSubject {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.root.parent().unwrap());
    }
}

#[test]
fn reads_utf8_text_file() {
    let t = TempSubject::new();
    t.write("notes.md", "# hello\n".as_bytes());
    let file = read_file_in(&t.sub, "notes.md").unwrap();
    let stamp = t.stamp("notes.md");
    assert_eq!(
        file,
        FileContent {
            name: "notes.md".into(),
            content: "# hello\n".into(),
            stamp: stamp.clone(),
        }
    );
    assert_eq!(stamp.len, 8);
}

#[test]
fn reads_nested_file() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("src")).unwrap();
    t.write("src/main.rs", b"fn main() {}");
    let file = read_file_in(&t.sub, "src/main.rs").unwrap();
    assert_eq!(file.name, "main.rs");
    assert_eq!(file.content, "fn main() {}");
}

#[test]
fn reads_through_symlink_inside_subject() {
    let t = TempSubject::new();
    t.write("real.txt", b"real");
    symlink("real.txt", t.root.join("link.txt")).unwrap();
    assert_eq!(read_file_in(&t.sub, "link.txt").unwrap().content, "real");
}

#[test]
fn rejects_symlink_with_absolute_target_even_inside_subject() {
    // An absolute link target can only be interpreted through the host
    // filesystem, which the rooted model never consults; such a link is
    // treated as leaving the subject even when it points back inside.
    let t = TempSubject::new();
    t.write("real.txt", b"real");
    symlink(t.root.join("real.txt"), t.root.join("abs-link.txt")).unwrap();
    let err = read_file_in(&t.sub, "abs-link.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    let err = stat_file_in(&t.sub, "abs-link.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
}

#[test]
fn rejects_parent_traversal() {
    let t = TempSubject::new();
    fs::write(t.outside.join("secret.txt"), b"secret").unwrap();
    let err = read_file_in(&t.sub, "../outside/secret.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
}

#[test]
fn rejects_absolute_path() {
    let t = TempSubject::new();
    let abs = t.outside.join("secret.txt");
    fs::write(&abs, b"secret").unwrap();
    let err = read_file_in(&t.sub, abs.to_str().unwrap()).unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
}

#[test]
fn rejects_symlink_escaping_subject() {
    let t = TempSubject::new();
    let target = t.outside.join("secret.txt");
    fs::write(&target, b"secret").unwrap();
    symlink(&target, t.root.join("link.txt")).unwrap();
    let err = read_file_in(&t.sub, "link.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
}

#[test]
fn rejects_directory() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("dir")).unwrap();
    let err = read_file_in(&t.sub, "dir").unwrap_err();
    assert!(err.contains("not a file"), "{}", err);
}

#[test]
fn fifo_and_socket_reads_return_without_blocking() {
    // A timeout makes a blocking-open regression fail instead of hanging the suite.
    let (done, result) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let t = TempSubject::new();
        t.write("file.txt", b"needle");
        let stamp = t.stamp("file.txt");
        let path = CString::new(t.root.join("pipe").as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: path is a valid NUL-terminated pathname; mode is permission bits.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let _socket = std::os::unix::net::UnixListener::bind(t.root.join("socket")).unwrap();
        symlink("pipe", t.root.join("pipe-link")).unwrap();
        for rel in ["pipe", "pipe-link", "socket"] {
            assert!(read_file_in(&t.sub, rel).is_err());
            assert!(stat_file_in(&t.sub, rel).is_err());
            assert!(write_file_in(&t.sub, rel, "edits", stamp.clone()).is_err());
        }
        assert!(read_regular_text(&t.sub.dir, "pipe").is_none());
        let (hits, summary) = search_all(&t.sub, "needle");
        assert_eq!(rel_paths(&hits), vec!["file.txt"]);
        assert_eq!(summary.files, 1);
        done.send(()).unwrap();
    });
    result
        .recv_timeout(std::time::Duration::from_secs(3))
        .expect("special-file access must finish without a FIFO writer");
    worker.join().unwrap();
}

#[test]
fn rejects_missing_file() {
    let t = TempSubject::new();
    let err = read_file_in(&t.sub, "missing.txt").unwrap_err();
    assert!(err.contains("cannot access"), "{}", err);
}

#[test]
fn rejects_file_over_limit() {
    let t = TempSubject::new();
    let big = vec![b'a'; (MAX_FILE_BYTES + 1) as usize];
    t.write("big.txt", &big);
    let err = read_file_in(&t.sub, "big.txt").unwrap_err();
    assert!(err.contains("larger than 2 MB"), "{}", err);
}

#[test]
fn accepts_file_at_limit() {
    let t = TempSubject::new();
    let exact = vec![b'a'; MAX_FILE_BYTES as usize];
    t.write("exact.txt", &exact);
    let file = read_file_in(&t.sub, "exact.txt").unwrap();
    assert_eq!(file.content.len(), MAX_FILE_BYTES as usize);
}

#[test]
fn read_is_bounded_even_when_file_grows_after_it_was_measured() {
    let t = TempSubject::new();
    t.write("grow.txt", &vec![b'a'; MAX_FILE_BYTES as usize]);
    let file = t.sub.dir.open("grow.txt").unwrap();
    let measured = file.metadata().unwrap();
    assert_eq!(measured.len(), MAX_FILE_BYTES, "passes the size check");
    // The file grows between the size check and the read.
    let mut append = fs::OpenOptions::new()
        .append(true)
        .open(t.root.join("grow.txt"))
        .unwrap();
    append.write_all(b"needle-in-the-tail-of-the-file").unwrap();
    drop(append);
    let err = read_text_bounded(&file, measured.len(), "grow.txt").unwrap_err();
    assert!(err.contains("larger than 2 MB"), "{}", err);
    let again = t.sub.dir.open("grow.txt").unwrap();
    let bytes = read_bytes_bounded(&again, measured.len()).unwrap();
    assert!(bytes.is_none(), "search content read also refuses it");
}

#[test]
fn save_replaces_content_and_preserves_permissions() {
    let t = TempSubject::new();
    t.write("run.sh", b"#!/bin/sh\necho old\n");
    fs::set_permissions(t.root.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    let file = read_file_in(&t.sub, "run.sh").unwrap();

    let stamp = write_file_in(&t.sub, "run.sh", "#!/bin/sh\necho new\n", file.stamp).unwrap();

    let meta = fs::metadata(t.root.join("run.sh")).unwrap();
    assert_eq!(
        fs::read_to_string(t.root.join("run.sh")).unwrap(),
        "#!/bin/sh\necho new\n"
    );
    assert_eq!(meta.permissions().mode() & 0o777, 0o755);
    assert_eq!(stamp, FileStamp::of_std(&meta).unwrap());
    assert_eq!(stamp.len, "#!/bin/sh\necho new\n".len() as u64);
    assert_eq!(t.names(&t.root), vec!["run.sh"]);
}

#[test]
fn save_keeps_restrictive_permissions_and_stages_with_mode_0600() {
    let t = TempSubject::new();
    t.write("secret.txt", b"old");
    fs::set_permissions(t.root.join("secret.txt"), fs::Permissions::from_mode(0o600)).unwrap();
    let file = read_file_in(&t.sub, "secret.txt").unwrap();
    let root = t.root.clone();
    write_file_in_with(&t.sub, "secret.txt", "new", file.stamp, || {
        // Just before the commit the staged file already carries the final
        // (restrictive) mode; it was never wider than 0600.
        let tmp = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap())
            .find(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .expect("staged temp file exists before commit");
        assert_eq!(tmp.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    })
    .unwrap();
    let meta = fs::metadata(t.root.join("secret.txt")).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    assert_eq!(
        fs::read_to_string(t.root.join("secret.txt")).unwrap(),
        "new"
    );

    // A wider source keeps its wider mode on the final file only.
    t.write("open.txt", b"old");
    fs::set_permissions(t.root.join("open.txt"), fs::Permissions::from_mode(0o644)).unwrap();
    let file = read_file_in(&t.sub, "open.txt").unwrap();
    write_file_in(&t.sub, "open.txt", "new", file.stamp).unwrap();
    let mode = fs::metadata(t.root.join("open.txt"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o644);
}

#[test]
fn temp_file_is_created_with_mode_0600_before_any_content() {
    let t = TempSubject::new();
    let tmp = temp_name();
    // Creation and the restrictive mode are one `open` call; a wide final
    // permission is applied only after the content is written and never
    // widens the file before then. Observe the created file directly.
    let staged = stage_temp(&t.sub.dir, &tmp, "", None, "x").unwrap();
    assert_eq!(staged.metadata().unwrap().mode() & 0o777, 0o600);
    assert_eq!(
        fs::metadata(t.root.join(&tmp))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn save_can_be_repeated_with_returned_stamp() {
    let t = TempSubject::new();
    t.write("a.txt", b"one");
    let file = read_file_in(&t.sub, "a.txt").unwrap();
    let stamp = write_file_in(&t.sub, "a.txt", "two", file.stamp).unwrap();
    write_file_in(&t.sub, "a.txt", "three", stamp).unwrap();
    assert_eq!(fs::read_to_string(t.root.join("a.txt")).unwrap(), "three");
}

#[test]
fn save_rejects_path_outside_subject() {
    let t = TempSubject::new();
    let target = t.outside.join("secret.txt");
    fs::write(&target, b"secret").unwrap();
    let stamp = FileStamp::of_std(&fs::metadata(&target).unwrap()).unwrap();
    let err = write_file_in(&t.sub, "../outside/secret.txt", "owned", stamp).unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    assert_eq!(fs::read_to_string(&target).unwrap(), "secret");
}

#[test]
fn save_rejects_missing_file_without_creating_it() {
    let t = TempSubject::new();
    let stamp = FileStamp {
        identity: "0:0".into(),
        mtime_secs: 0,
        mtime_nanos: 0,
        len: 0,
    };
    let err = write_file_in(&t.sub, "missing.txt", "new", stamp).unwrap_err();
    assert!(err.contains("cannot access"), "{}", err);
    assert!(!t.root.join("missing.txt").exists());
    assert_eq!(fs::read_dir(&t.root).unwrap().count(), 0);
}

#[test]
fn save_rejects_file_changed_on_disk() {
    let t = TempSubject::new();
    t.write("notes.md", b"original");
    let file = read_file_in(&t.sub, "notes.md").unwrap();

    // Someone else rewrites the file after alabs read it.
    t.write("notes.md", b"changed elsewhere!");

    let err = write_file_in(&t.sub, "notes.md", "my edits", file.stamp).unwrap_err();
    assert!(err.contains("changed on disk"), "{}", err);
    assert_eq!(
        fs::read_to_string(t.root.join("notes.md")).unwrap(),
        "changed elsewhere!"
    );
    assert_eq!(
        t.names(&t.root),
        vec!["notes.md"],
        "no temp file left behind"
    );
}

#[test]
fn save_rejects_replacement_with_same_size_and_mtime() {
    let t = TempSubject::new();
    t.write("notes.md", b"original");
    let file = read_file_in(&t.sub, "notes.md").unwrap();
    let modified = fs::metadata(t.root.join("notes.md"))
        .unwrap()
        .modified()
        .unwrap();
    t.write("replacement.tmp", b"external");
    fs::File::options()
        .write(true)
        .open(t.root.join("replacement.tmp"))
        .unwrap()
        .set_modified(modified)
        .unwrap();
    fs::rename(t.root.join("replacement.tmp"), t.root.join("notes.md")).unwrap();

    let replaced = stat_file_in(&t.sub, "notes.md").unwrap().unwrap();
    assert_eq!(replaced.len, file.stamp.len);
    assert_eq!(replaced.mtime_secs, file.stamp.mtime_secs);
    assert_eq!(replaced.mtime_nanos, file.stamp.mtime_nanos);
    assert_ne!(replaced.identity, file.stamp.identity);
    let err = write_file_in(&t.sub, "notes.md", "my edits", file.stamp).unwrap_err();
    assert!(err.contains("changed on disk"), "{}", err);
    assert_eq!(
        fs::read_to_string(t.root.join("notes.md")).unwrap(),
        "external"
    );
    assert_eq!(t.names(&t.root), vec!["notes.md"]);
}

#[test]
fn save_detects_target_replaced_between_check_and_commit() {
    // The race the pre-check cannot see: the target is replaced by another
    // process after alabs validated it and staged its content, but before
    // the atomic swap.
    let t = TempSubject::new();
    t.write("notes.md", b"original");
    let file = read_file_in(&t.sub, "notes.md").unwrap();
    let root = t.root.clone();
    let err = write_file_in_with(&t.sub, "notes.md", "my edits", file.stamp, || {
        // An editor elsewhere does its own atomic replace (new inode).
        fs::write(root.join("other.tmp"), b"outside update").unwrap();
        fs::rename(root.join("other.tmp"), root.join("notes.md")).unwrap();
    })
    .unwrap_err();
    assert!(err.contains("changed on disk during save"), "{}", err);
    assert_eq!(
        fs::read_to_string(t.root.join("notes.md")).unwrap(),
        "outside update",
        "the outside version is what remains at the target"
    );
    assert_eq!(
        t.names(&t.root),
        vec!["notes.md"],
        "staged copy removed, nothing else left"
    );
}

#[test]
fn save_detects_target_rewritten_in_place_between_check_and_commit() {
    // Same inode, new content: an in-place write lands after the pre-check.
    let t = TempSubject::new();
    t.write("notes.md", b"original");
    let file = read_file_in(&t.sub, "notes.md").unwrap();
    let ino = fs::metadata(t.root.join("notes.md")).unwrap().ino();
    let root = t.root.clone();
    let err = write_file_in_with(&t.sub, "notes.md", "my edits", file.stamp, || {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(root.join("notes.md"))
            .unwrap();
        f.write_all(b"outside in-place update").unwrap();
    })
    .unwrap_err();
    assert!(err.contains("changed on disk during save"), "{}", err);
    assert_eq!(
        fs::read_to_string(t.root.join("notes.md")).unwrap(),
        "outside in-place update"
    );
    assert_eq!(
        fs::metadata(t.root.join("notes.md")).unwrap().ino(),
        ino,
        "same inode restored"
    );
    assert_eq!(t.names(&t.root), vec!["notes.md"]);
}

#[test]
fn save_returns_stamp_of_committed_content_only() {
    let t = TempSubject::new();
    t.write("a.txt", b"one");
    let file = read_file_in(&t.sub, "a.txt").unwrap();
    let stamp = write_file_in(&t.sub, "a.txt", "two", file.stamp).unwrap();
    assert_eq!(
        stamp,
        t.stamp("a.txt"),
        "stamp describes the committed inode"
    );
    assert_eq!(stamp.len, 3);
    // A later outside update is not what the returned stamp describes, so the
    // next save is refused instead of clobbering it.
    t.write("a.txt", b"outside later");
    let err = write_file_in(&t.sub, "a.txt", "three", stamp).unwrap_err();
    assert!(err.contains("changed on disk"), "{}", err);
    assert_eq!(
        fs::read_to_string(t.root.join("a.txt")).unwrap(),
        "outside later"
    );
}

#[test]
fn save_through_symlink_inside_subject_replaces_the_target_not_the_link() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("dir")).unwrap();
    t.write("dir/real.txt", b"real");
    symlink("dir/real.txt", t.root.join("link.txt")).unwrap();
    let file = read_file_in(&t.sub, "link.txt").unwrap();
    write_file_in(&t.sub, "link.txt", "edited", file.stamp).unwrap();
    assert!(t
        .root
        .join("link.txt")
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read_to_string(t.root.join("dir/real.txt")).unwrap(),
        "edited"
    );
}

#[test]
fn save_refuses_when_entry_became_a_symlink() {
    let t = TempSubject::new();
    t.write("a.txt", b"one");
    let file = read_file_in(&t.sub, "a.txt").unwrap();
    // The regular file is swapped for a link to an outside file that happens
    // to carry the same stamp.
    let outside = t.outside.join("keep.txt");
    fs::copy(t.root.join("a.txt"), &outside).unwrap();
    fs::remove_file(t.root.join("a.txt")).unwrap();
    symlink(&outside, t.root.join("a.txt")).unwrap();
    let err = write_file_in(&t.sub, "a.txt", "owned", file.stamp).unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    assert_eq!(fs::read_to_string(&outside).unwrap(), "one");
}

#[test]
fn save_is_anchored_to_the_parent_handle_not_its_path() {
    // After the parent folder was resolved, its pathname is swapped for a
    // symlink to an outside folder. The save keeps operating on the folder it
    // holds open; the outside folder is never touched.
    let t = TempSubject::new();
    fs::create_dir(t.root.join("dir")).unwrap();
    t.write("dir/a.txt", b"one");
    fs::write(t.outside.join("a.txt"), b"outside").unwrap();
    let file = read_file_in(&t.sub, "dir/a.txt").unwrap();
    let root = t.root.clone();
    let outside = t.outside.clone();
    write_file_in_with(&t.sub, "dir/a.txt", "two", file.stamp, || {
        fs::rename(root.join("dir"), root.join("dir-moved")).unwrap();
        symlink(&outside, root.join("dir")).unwrap();
    })
    .unwrap();
    assert_eq!(
        fs::read_to_string(t.root.join("dir-moved/a.txt")).unwrap(),
        "two"
    );
    assert_eq!(
        fs::read_to_string(t.outside.join("a.txt")).unwrap(),
        "outside"
    );
    assert_eq!(t.names(&t.outside), vec!["a.txt"]);
}

#[test]
fn create_is_anchored_to_the_parent_handle_not_its_path() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("dir")).unwrap();
    let (dir, name) = t.sub.parent_of("dir/new.txt").unwrap();
    // Validation done; now the pathname is redirected outside.
    fs::rename(t.root.join("dir"), t.root.join("dir-moved")).unwrap();
    symlink(&t.outside, t.root.join("dir")).unwrap();
    create_at(&dir, &name, false, "dir/new.txt").unwrap();
    assert!(t.root.join("dir-moved/new.txt").is_file());
    assert_eq!(fs::read_dir(&t.outside).unwrap().count(), 0);
}

#[test]
fn save_rejects_directory() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("dir")).unwrap();
    let stamp = t.stamp("dir");
    let err = write_file_in(&t.sub, "dir", "x", stamp).unwrap_err();
    assert!(err.contains("not a file"), "{}", err);
}

#[test]
fn creates_empty_file_at_root() {
    let t = TempSubject::new();
    let rel = create_in(&t.sub, "", "notes.md", false).unwrap();
    assert_eq!(rel, "notes.md");
    assert_eq!(fs::read(t.root.join("notes.md")).unwrap(), b"");
    assert_eq!(
        fs::read_dir(&t.root).unwrap().count(),
        1,
        "nothing else written"
    );
}

#[test]
fn creates_file_in_nested_folder() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("src")).unwrap();
    let rel = create_in(&t.sub, "src", "main.rs", false).unwrap();
    assert_eq!(rel, "src/main.rs");
    assert!(t.root.join("src/main.rs").is_file());
    assert_eq!(read_file_in(&t.sub, &rel).unwrap().content, "");
}

#[test]
fn creates_folder() {
    let t = TempSubject::new();
    let rel = create_in(&t.sub, "", "docs", true).unwrap();
    assert_eq!(rel, "docs");
    assert!(t.root.join("docs").is_dir());
    let nested = create_in(&t.sub, "docs", "img", true).unwrap();
    assert_eq!(nested, "docs/img");
    assert!(t.root.join("docs/img").is_dir());
}

#[test]
fn create_rejects_existing_file() {
    let t = TempSubject::new();
    t.write("a.txt", b"keep me");
    let err = create_in(&t.sub, "", "a.txt", false).unwrap_err();
    assert!(err.contains("already exists"), "{}", err);
    assert_eq!(fs::read_to_string(t.root.join("a.txt")).unwrap(), "keep me");
    let err = create_in(&t.sub, "", "a.txt", true).unwrap_err();
    assert!(err.contains("already exists"), "{}", err);
    assert!(t.root.join("a.txt").is_file());
}

#[test]
fn create_rejects_existing_folder() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("dir")).unwrap();
    t.write("dir/inner.txt", b"x");
    let err = create_in(&t.sub, "", "dir", true).unwrap_err();
    assert!(err.contains("already exists"), "{}", err);
    let err = create_in(&t.sub, "", "dir", false).unwrap_err();
    assert!(err.contains("already exists"), "{}", err);
    assert!(t.root.join("dir/inner.txt").is_file());
}

#[test]
fn create_rejects_bad_names() {
    let t = TempSubject::new();
    for name in ["", ".", "..", "a/b", "a\\b", "../x", "/abs", "nul\0x"] {
        for is_dir in [false, true] {
            let err = create_in(&t.sub, "", name, is_dir).unwrap_err();
            assert!(
                err.contains("invalid name") || err.contains("empty"),
                "{:?}: {}",
                name,
                err
            );
        }
    }
    assert_eq!(fs::read_dir(&t.root).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&t.outside).unwrap().count(), 0);
}

#[test]
fn create_rejects_parent_outside_subject() {
    let t = TempSubject::new();
    let err = create_in(&t.sub, "../outside", "leak.txt", false).unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    let err = create_in(&t.sub, "../outside", "leak", true).unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    let abs = t.outside.to_str().unwrap();
    let err = create_in(&t.sub, abs, "leak.txt", false).unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    assert_eq!(fs::read_dir(&t.outside).unwrap().count(), 0);
}

#[test]
fn create_rejects_symlinked_parent_outside_subject() {
    let t = TempSubject::new();
    symlink(&t.outside, t.root.join("link")).unwrap();
    let err = create_in(&t.sub, "link", "leak.txt", false).unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    assert_eq!(fs::read_dir(&t.outside).unwrap().count(), 0);
}

#[test]
fn create_rejects_file_as_parent() {
    let t = TempSubject::new();
    t.write("a.txt", b"");
    let err = create_in(&t.sub, "a.txt", "child", true).unwrap_err();
    assert!(err.contains("not a folder"), "{}", err);
}

#[test]
fn renames_file() {
    let t = TempSubject::new();
    t.write("old.md", b"body");
    let rel = move_in(&t.sub, "old.md", "", "new.md").unwrap();
    assert_eq!(rel, "new.md");
    assert!(!t.root.join("old.md").exists());
    assert_eq!(fs::read_to_string(t.root.join("new.md")).unwrap(), "body");
}

#[test]
fn rename_preserves_stamp_so_save_still_works() {
    let t = TempSubject::new();
    t.write("old.md", b"body");
    let file = read_file_in(&t.sub, "old.md").unwrap();
    move_in(&t.sub, "old.md", "", "new.md").unwrap();
    let stamp = write_file_in(&t.sub, "new.md", "edited", file.stamp).unwrap();
    assert_eq!(fs::read_to_string(t.root.join("new.md")).unwrap(), "edited");
    assert_eq!(stamp.len, 6);
}

#[test]
fn renames_folder_with_contents() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("docs/img")).unwrap();
    t.write("docs/a.md", b"a");
    t.write("docs/img/b.png", b"b");
    let rel = move_in(&t.sub, "docs", "", "notes").unwrap();
    assert_eq!(rel, "notes");
    assert!(!t.root.join("docs").exists());
    assert_eq!(fs::read_to_string(t.root.join("notes/a.md")).unwrap(), "a");
    assert_eq!(
        fs::read_to_string(t.root.join("notes/img/b.png")).unwrap(),
        "b"
    );
}

#[test]
fn moves_file_between_folders() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("src")).unwrap();
    fs::create_dir(t.root.join("lib")).unwrap();
    t.write("src/main.rs", b"fn main() {}");
    let rel = move_in(&t.sub, "src/main.rs", "lib", "main.rs").unwrap();
    assert_eq!(rel, "lib/main.rs");
    assert!(!t.root.join("src/main.rs").exists());
    assert_eq!(
        read_file_in(&t.sub, "lib/main.rs").unwrap().content,
        "fn main() {}"
    );
    let up = move_in(&t.sub, "lib/main.rs", "", "main.rs").unwrap();
    assert_eq!(up, "main.rs");
    assert!(t.root.join("main.rs").is_file());
}

#[test]
fn moves_folder_between_folders() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("a/inner")).unwrap();
    fs::create_dir(t.root.join("b")).unwrap();
    t.write("a/inner/x.txt", b"x");
    let rel = move_in(&t.sub, "a/inner", "b", "inner").unwrap();
    assert_eq!(rel, "b/inner");
    assert!(!t.root.join("a/inner").exists());
    assert_eq!(
        fs::read_to_string(t.root.join("b/inner/x.txt")).unwrap(),
        "x"
    );
    assert!(t.root.join("a").is_dir(), "old parent kept");
}

#[test]
fn move_rejects_existing_destination() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("dir")).unwrap();
    t.write("a.txt", b"a");
    t.write("dir/a.txt", b"keep");
    t.write("b.txt", b"b");
    fs::create_dir(t.root.join("other")).unwrap();
    t.write("other/k.txt", b"k");

    let err = move_in(&t.sub, "a.txt", "", "b.txt").unwrap_err();
    assert!(err.contains("already exists"), "{}", err);
    let err = move_in(&t.sub, "a.txt", "dir", "a.txt").unwrap_err();
    assert!(err.contains("already exists"), "{}", err);
    let err = move_in(&t.sub, "a.txt", "", "dir").unwrap_err();
    assert!(err.contains("already exists"), "{}", err);
    let err = move_in(&t.sub, "dir", "", "other").unwrap_err();
    assert!(err.contains("already exists"), "{}", err);
    let err = move_in(&t.sub, "dir", "", "a.txt").unwrap_err();
    assert!(err.contains("already exists"), "{}", err);

    assert_eq!(fs::read_to_string(t.root.join("a.txt")).unwrap(), "a");
    assert_eq!(fs::read_to_string(t.root.join("b.txt")).unwrap(), "b");
    assert_eq!(
        fs::read_to_string(t.root.join("dir/a.txt")).unwrap(),
        "keep"
    );
    assert_eq!(fs::read_to_string(t.root.join("other/k.txt")).unwrap(), "k");
}

#[test]
fn move_rejects_source_outside_subject() {
    let t = TempSubject::new();
    fs::write(t.outside.join("secret.txt"), b"secret").unwrap();
    let err = move_in(&t.sub, "../outside/secret.txt", "", "stolen.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    assert!(t.outside.join("secret.txt").is_file());
    assert_eq!(fs::read_dir(&t.root).unwrap().count(), 0);
}

#[test]
fn move_rejects_destination_outside_subject() {
    let t = TempSubject::new();
    t.write("a.txt", b"a");
    let err = move_in(&t.sub, "a.txt", "../outside", "a.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    let abs = t.outside.to_str().unwrap();
    let err = move_in(&t.sub, "a.txt", abs, "a.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    assert!(t.root.join("a.txt").is_file());
    assert_eq!(fs::read_dir(&t.outside).unwrap().count(), 0);
}

#[test]
fn move_rejects_symlinked_destination_outside_subject() {
    let t = TempSubject::new();
    t.write("a.txt", b"a");
    symlink(&t.outside, t.root.join("link")).unwrap();
    let err = move_in(&t.sub, "a.txt", "link", "a.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    assert!(t.root.join("a.txt").is_file());
    assert_eq!(fs::read_dir(&t.outside).unwrap().count(), 0);
}

#[test]
fn move_rejects_folder_into_itself_or_descendant() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("a/b/c")).unwrap();
    let err = move_in(&t.sub, "a", "a", "a").unwrap_err();
    assert!(err.contains("into itself"), "{}", err);
    let err = move_in(&t.sub, "a", "a/b/c", "a").unwrap_err();
    assert!(err.contains("into itself"), "{}", err);
    let err = move_in(&t.sub, "a/b", "a/b/c", "moved").unwrap_err();
    assert!(err.contains("into itself"), "{}", err);
    assert!(t.root.join("a/b/c").is_dir());
    assert_eq!(fs::read_dir(t.root.join("a/b/c")).unwrap().count(), 0);
}

#[test]
fn move_rejects_missing_or_file_destination_parent() {
    let t = TempSubject::new();
    t.write("a.txt", b"a");
    t.write("f.txt", b"f");
    let err = move_in(&t.sub, "a.txt", "nope", "a.txt").unwrap_err();
    assert!(err.contains("cannot access"), "{}", err);
    assert!(
        !t.root.join("nope").exists(),
        "destination folder not created"
    );
    let err = move_in(&t.sub, "a.txt", "f.txt", "a.txt").unwrap_err();
    assert!(err.contains("not a folder"), "{}", err);
    assert!(t.root.join("a.txt").is_file());
}

#[test]
fn move_rejects_bad_names_and_root() {
    let t = TempSubject::new();
    t.write("a.txt", b"a");
    for name in ["", ".", "..", "x/y", "x\\y", "../x", "/abs", "nul\0x"] {
        let err = move_in(&t.sub, "a.txt", "", name).unwrap_err();
        assert!(
            err.contains("invalid name") || err.contains("empty"),
            "{:?}: {}",
            name,
            err
        );
    }
    let err = move_in(&t.sub, "", "", "renamed").unwrap_err();
    assert!(err.contains("subject folder"), "{}", err);
    let err = move_in(&t.sub, "a.txt", "", "a.txt").unwrap_err();
    assert!(err.contains("nothing to change"), "{}", err);
    assert!(t.root.join("a.txt").is_file());
    assert!(t.root.is_dir());
}

#[test]
fn trashes_file() {
    let t = TempSubject::new();
    t.write("gone.txt", b"bye");
    t.trash("gone.txt").unwrap();
    assert!(!t.root.join("gone.txt").exists());
    assert_eq!(fs::read_to_string(t.trash.join("gone.txt")).unwrap(), "bye");
}

#[test]
fn trashes_folder_with_contents() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("dir/sub")).unwrap();
    t.write("dir/a.txt", b"a");
    t.write("dir/sub/b.txt", b"b");
    t.trash("dir").unwrap();
    assert!(!t.root.join("dir").exists());
    assert!(t.root.is_dir());
    assert_eq!(
        fs::read_to_string(t.trash.join("dir/sub/b.txt")).unwrap(),
        "b"
    );
}

#[test]
fn trash_never_replaces_an_item_already_in_the_trash() {
    let t = TempSubject::new();
    fs::write(t.trash.join("a.txt"), b"earlier").unwrap();
    fs::write(t.trash.join("a 2.txt"), b"earlier 2").unwrap();
    t.write("a.txt", b"now");
    t.trash("a.txt").unwrap();
    assert_eq!(
        fs::read_to_string(t.trash.join("a.txt")).unwrap(),
        "earlier"
    );
    assert_eq!(
        fs::read_to_string(t.trash.join("a 2.txt")).unwrap(),
        "earlier 2"
    );
    assert_eq!(fs::read_to_string(t.trash.join("a 3.txt")).unwrap(), "now");
    fs::write(t.trash.join("noext"), b"x").unwrap();
    t.write("noext", b"y");
    t.trash("noext").unwrap();
    assert_eq!(fs::read_to_string(t.trash.join("noext 2")).unwrap(), "y");
}

#[test]
fn trash_rejects_root_and_missing() {
    let t = TempSubject::new();
    let err = t.trash("").unwrap_err();
    assert!(err.contains("subject folder"), "{}", err);
    let err = t.trash("missing.txt").unwrap_err();
    assert!(err.contains("cannot access"), "{}", err);
    assert!(t.root.is_dir());
}

#[test]
fn trash_rejects_path_outside_subject() {
    let t = TempSubject::new();
    let abs = t.outside.join("keep.txt");
    fs::write(&abs, b"keep").unwrap();
    let err = t.trash("../outside/keep.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    let err = t.trash(abs.to_str().unwrap()).unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    assert!(abs.exists());
}

#[test]
fn trash_moves_symlink_itself_and_never_its_target() {
    let t = TempSubject::new();
    let outside_target = t.outside.join("keep.txt");
    fs::write(&outside_target, b"keep").unwrap();
    symlink(&outside_target, t.root.join("link.txt")).unwrap();
    t.trash("link.txt").unwrap();
    assert!(
        t.root.join("link.txt").symlink_metadata().is_err(),
        "link gone"
    );
    assert!(t
        .trash
        .join("link.txt")
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_to_string(&outside_target).unwrap(), "keep");

    t.write("inside.txt", b"inside");
    symlink(t.root.join("inside.txt"), t.root.join("in-link")).unwrap();
    t.trash("in-link").unwrap();
    assert!(t.root.join("in-link").symlink_metadata().is_err());
    assert_eq!(
        fs::read_to_string(t.root.join("inside.txt")).unwrap(),
        "inside"
    );

    // A dangling link is still an entry and can be trashed.
    symlink(t.root.join("nowhere"), t.root.join("dangling")).unwrap();
    t.trash("dangling").unwrap();
    assert!(t.root.join("dangling").symlink_metadata().is_err());
}

#[test]
fn trash_rejects_entry_whose_parent_is_outside_subject() {
    let t = TempSubject::new();
    let target = t.outside.join("keep.txt");
    fs::write(&target, b"keep").unwrap();
    symlink(&t.outside, t.root.join("linkdir")).unwrap();
    let err = t.trash("linkdir/keep.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    assert!(target.exists());
}

#[test]
fn trash_is_anchored_to_the_parent_handle_not_its_path() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("dir")).unwrap();
    t.write("dir/a.txt", b"mine");
    fs::write(t.outside.join("a.txt"), b"outside").unwrap();
    let (dir, name) = t.sub.parent_of("dir/a.txt").unwrap();
    // Validation done; now the pathname is redirected outside.
    fs::rename(t.root.join("dir"), t.root.join("dir-moved")).unwrap();
    symlink(&t.outside, t.root.join("dir")).unwrap();
    rename_noreplace(&dir, &name, &t.trash_dir(), &name).unwrap();
    assert_eq!(fs::read_to_string(t.trash.join("a.txt")).unwrap(), "mine");
    assert!(!t.root.join("dir-moved/a.txt").exists());
    assert_eq!(
        fs::read_to_string(t.outside.join("a.txt")).unwrap(),
        "outside"
    );
}

#[test]
fn trash_refuses_a_different_volume_instead_of_copying() {
    let t = TempSubject::new();
    t.write("a.txt", b"a");
    // /dev is its own filesystem on macOS; nothing is ever moved there.
    let other = Dir::open_ambient_dir("/dev", ambient_authority()).unwrap();
    let err = trash_in(&t.sub, "a.txt", &other).unwrap_err();
    assert!(err.contains("different volume"), "{}", err);
    assert!(t.root.join("a.txt").is_file());
}

#[test]
fn trash_dir_must_be_owned_by_the_user() {
    let t = TempSubject::new();
    // No `.Trash` under this home: refused, never created.
    let err = open_trash_dir(&t.outside).unwrap_err();
    assert!(err.contains("cannot open the Trash"), "{}", err);
    assert!(!t.outside.join(".Trash").exists());
    fs::create_dir(t.outside.join(".Trash")).unwrap();
    assert!(open_trash_dir(&t.outside).is_ok());
    // A system folder owned by root is not a usable Trash.
    let err = open_trash_dir(Path::new("/private/var/root")).unwrap_err();
    assert!(err.contains("Trash"), "{}", err);
}

#[test]
fn move_renames_symlink_itself_and_never_its_target() {
    let t = TempSubject::new();
    let outside_target = t.outside.join("keep.txt");
    fs::write(&outside_target, b"keep").unwrap();
    symlink(&outside_target, t.root.join("link.txt")).unwrap();
    fs::create_dir(t.root.join("dir")).unwrap();

    let rel = move_in(&t.sub, "link.txt", "", "renamed.txt").unwrap();
    assert_eq!(rel, "renamed.txt");
    assert!(t.root.join("link.txt").symlink_metadata().is_err());
    let meta = t.root.join("renamed.txt").symlink_metadata().unwrap();
    assert!(meta.file_type().is_symlink());
    assert_eq!(
        fs::read_link(t.root.join("renamed.txt")).unwrap(),
        outside_target
    );
    assert_eq!(fs::read_to_string(&outside_target).unwrap(), "keep");
    assert_eq!(fs::read_dir(&t.outside).unwrap().count(), 1);

    let rel = move_in(&t.sub, "renamed.txt", "dir", "renamed.txt").unwrap();
    assert_eq!(rel, "dir/renamed.txt");
    assert!(t
        .root
        .join("dir/renamed.txt")
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_dir(&t.outside).unwrap().count(), 1);
}

#[test]
fn move_rejects_source_through_symlink_outside_subject() {
    let t = TempSubject::new();
    fs::write(t.outside.join("secret.txt"), b"secret").unwrap();
    symlink(&t.outside, t.root.join("linkdir")).unwrap();
    let err = move_in(&t.sub, "linkdir/secret.txt", "", "stolen.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    assert!(t.outside.join("secret.txt").is_file());
    assert!(t.root.join("stolen.txt").symlink_metadata().is_err());
}

#[test]
fn move_never_replaces_a_destination_that_appears_late() {
    // Simulates the race window: the destination exists at rename time.
    let t = TempSubject::new();
    t.write("a.txt", b"a");
    t.write("late.txt", b"late");
    let err = rename_noreplace(&t.sub.dir, "a.txt", &t.sub.dir, "late.txt").unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read_to_string(t.root.join("a.txt")).unwrap(), "a");
    assert_eq!(fs::read_to_string(t.root.join("late.txt")).unwrap(), "late");
    rename_noreplace(&t.sub.dir, "a.txt", &t.sub.dir, "b.txt").unwrap();
    assert_eq!(fs::read_to_string(t.root.join("b.txt")).unwrap(), "a");
}

#[test]
fn move_allows_case_only_rename() {
    let t = TempSubject::new();
    t.write("readme.md", b"r");
    // On a case-sensitive filesystem this is an ordinary rename.
    let rel = move_in(&t.sub, "readme.md", "", "README.md").unwrap();
    assert_eq!(rel, "README.md");
    assert_eq!(t.names(&t.root), vec!["README.md"]);
    assert_eq!(fs::read_to_string(t.root.join("README.md")).unwrap(), "r");
}

#[test]
fn recreates_missing_file_only_where_nothing_exists() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("dir")).unwrap();
    let stamp = recreate_file_in(&t.sub, "dir/back.txt", "restored").unwrap();
    assert_eq!(
        fs::read_to_string(t.root.join("dir/back.txt")).unwrap(),
        "restored"
    );
    assert_eq!(
        stamp,
        stat_file_in(&t.sub, "dir/back.txt").unwrap().unwrap()
    );
    // Saving with the returned stamp works like any other file.
    write_file_in(&t.sub, "dir/back.txt", "again", stamp).unwrap();
    assert_eq!(
        fs::read_to_string(t.root.join("dir/back.txt")).unwrap(),
        "again"
    );

    let err = recreate_file_in(&t.sub, "dir/back.txt", "clobber").unwrap_err();
    assert!(err.contains("already exists"), "{}", err);
    assert_eq!(
        fs::read_to_string(t.root.join("dir/back.txt")).unwrap(),
        "again"
    );

    let err = recreate_file_in(&t.sub, "gone/back.txt", "x").unwrap_err();
    assert!(err.contains("cannot access"), "{}", err);
    assert!(!t.root.join("gone").exists());

    let err = recreate_file_in(&t.sub, "dir", "x").unwrap_err();
    assert!(err.contains("already exists"), "{}", err);
    assert!(t.root.join("dir").is_dir());

    let err = recreate_file_in(&t.sub, "../outside/x.txt", "x").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    assert_eq!(fs::read_dir(&t.outside).unwrap().count(), 0);

    let err = recreate_file_in(&t.sub, "dir/..", "x").unwrap_err();
    assert!(err.contains("invalid name"), "{}", err);

    // No temporary file is left behind by any refusal.
    let leftovers: Vec<_> = t
        .names(&t.root.join("dir"))
        .into_iter()
        .filter(|n| n.contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{:?}", leftovers);
}

#[test]
fn recreate_refuses_existing_symlink_at_target() {
    let t = TempSubject::new();
    let outside_target = t.outside.join("keep.txt");
    fs::write(&outside_target, b"keep").unwrap();
    symlink(&outside_target, t.root.join("link.txt")).unwrap();
    let err = recreate_file_in(&t.sub, "link.txt", "x").unwrap_err();
    assert!(err.contains("already exists"), "{}", err);
    assert_eq!(fs::read_to_string(&outside_target).unwrap(), "keep");
}

#[test]
fn recreate_ends_with_the_default_mode_of_a_new_file() {
    let t = TempSubject::new();
    recreate_file_in(&t.sub, "back.txt", "x").unwrap();
    let mode = fs::metadata(t.root.join("back.txt"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    fs::File::create(t.outside.join("plain.txt")).unwrap();
    let plain = fs::metadata(t.outside.join("plain.txt"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, plain, "same mode as a plain create under this umask");
}

#[test]
fn subject_path_is_read_back_from_the_open_handle() {
    let t = TempSubject::new();
    let base = t.root.parent().unwrap();
    symlink(&t.root, base.join("subject-link")).unwrap();
    let sub = SubjectRoot::open(&base.join("subject-link")).unwrap();
    assert_eq!(
        sub.path, t.root,
        "the canonical path of the folder actually held open"
    );
    let err = SubjectRoot::open(&t.root.join("nope")).unwrap_err();
    assert!(err.contains("cannot open"), "{}", err);
    t.write("file.txt", b"");
    let err = SubjectRoot::open(&t.root.join("file.txt")).unwrap_err();
    assert!(err.contains("not a folder"), "{}", err);
}

#[test]
fn save_temp_name_is_short_and_fixed_form() {
    let t = TempSubject::new();
    let long = "n".repeat(250) + ".txt";
    t.write(&long, b"one");
    let file = read_file_in(&t.sub, &long).unwrap();
    write_file_in(&t.sub, &long, "two", file.stamp).unwrap();
    assert_eq!(fs::read_to_string(t.root.join(&long)).unwrap(), "two");
    let name = temp_name();
    assert!(
        name.starts_with(".alabs-") && name.ends_with(".tmp"),
        "{}",
        name
    );
    assert!(name.len() < 64, "{}", name);
    assert_ne!(temp_name(), name, "each call is unique");
}

#[test]
fn list_dir_skips_nothing_readable_and_sorts() {
    let t = TempSubject::new();
    t.write("b.txt", b"b");
    fs::create_dir(t.root.join("a")).unwrap();
    symlink(t.root.join("a"), t.root.join("c-link")).unwrap();
    let entries = list_entries(&t.sub, "").unwrap();
    let names: Vec<_> = entries
        .iter()
        .map(|e| (e.name.as_str(), e.is_dir))
        .collect();
    assert_eq!(
        names,
        vec![("a", true), ("b.txt", false), ("c-link", false)]
    );
    let err = list_entries(&t.sub, "../outside").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
}

#[test]
fn search_ignores_ignore_files_above_the_subject() {
    let t = TempSubject::new();
    // The parent of the subject ignores everything, including the subject folder itself.
    let base = t.root.parent().unwrap();
    fs::write(base.join(".gitignore"), b"*\n").unwrap();
    fs::write(base.join(".ignore"), b"subject\n").unwrap();
    fs::create_dir_all(base.join(".git/info")).unwrap();
    fs::write(base.join(".git/info/exclude"), b"*.txt\n").unwrap();
    t.write("inside.txt", b"needle\n");
    let (results, summary) = search_all(&t.sub, "needle");
    assert_eq!(rel_paths(&results), vec!["inside.txt"]);
    assert_eq!(summary.files, 1);
}

#[test]
fn search_never_loads_symlinked_ignore_files() {
    let t = TempSubject::new();
    // Each ignore file would hide everything if it were honoured.
    fs::write(t.outside.join("gitignore"), b"*\n").unwrap();
    fs::write(t.outside.join("ignore"), b"*\n").unwrap();
    fs::create_dir_all(t.outside.join("gitdir/info")).unwrap();
    fs::write(t.outside.join("gitdir/info/exclude"), b"*\n").unwrap();
    symlink(t.outside.join("gitignore"), t.root.join(".gitignore")).unwrap();
    symlink(t.outside.join("ignore"), t.root.join(".ignore")).unwrap();
    symlink(t.outside.join("gitdir"), t.root.join(".git")).unwrap();
    fs::create_dir(t.root.join("sub")).unwrap();
    // Even a link to an ignore file inside the subject is not a regular file.
    t.write("real-ignore", b"*\n");
    symlink("../real-ignore", t.root.join("sub/.gitignore")).unwrap();
    t.write("inside.txt", b"needle\n");
    t.write("sub/deep.txt", b"needle\n");
    let (results, _) = search_all(&t.sub, "needle");
    let mut paths = rel_paths(&results);
    paths.sort();
    assert_eq!(paths, vec!["inside.txt", "sub/deep.txt"]);
    // And the outside files were never read as ignore files even via
    // `.git/info/exclude` when `.git` itself is a link.
    fs::remove_file(t.root.join(".git")).unwrap();
    fs::create_dir_all(t.root.join(".git/info")).unwrap();
    symlink(
        t.outside.join("gitdir/info/exclude"),
        t.root.join(".git/info/exclude"),
    )
    .unwrap();
    let (results, _) = search_all(&t.sub, "needle");
    assert_eq!(results.len(), 2);
}

#[test]
fn search_cancellation_is_reset_by_subject_change_and_clear() {
    let subject = Subject::default();
    subject.latest_search.store(7, Ordering::SeqCst);
    assert!(subject.search_is_current(7));
    subject.cancel_searches();
    assert!(!subject.search_is_current(7));
    assert!(!subject.search_is_current(NO_SEARCH + 1));
}

#[test]
fn stat_reports_current_stamp_and_changes() {
    let t = TempSubject::new();
    t.write("a.txt", b"one");
    let file = read_file_in(&t.sub, "a.txt").unwrap();
    assert_eq!(
        stat_file_in(&t.sub, "a.txt").unwrap(),
        Some(file.stamp.clone())
    );

    t.write("a.txt", b"one more");
    let after = stat_file_in(&t.sub, "a.txt").unwrap().unwrap();
    assert_ne!(after, file.stamp);
    assert_eq!(after.len, 8);
}

#[test]
fn stat_reports_missing_file_as_none() {
    let t = TempSubject::new();
    assert_eq!(stat_file_in(&t.sub, "missing.txt").unwrap(), None);
    assert_eq!(stat_file_in(&t.sub, "gone/deep.txt").unwrap(), None);
    t.write("a.txt", b"a");
    fs::remove_file(t.root.join("a.txt")).unwrap();
    assert_eq!(stat_file_in(&t.sub, "a.txt").unwrap(), None);
    symlink("nowhere", t.root.join("dangling")).unwrap();
    assert_eq!(stat_file_in(&t.sub, "dangling").unwrap(), None);
    assert_eq!(
        fs::read_dir(&t.root).unwrap().count(),
        1,
        "nothing recreated"
    );
}

#[test]
fn stat_follows_contained_parent_relative_symlink_from_subject_root() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("sub")).unwrap();
    t.write("real.txt", b"real");
    symlink("../real.txt", t.root.join("sub/link.txt")).unwrap();
    let file = read_file_in(&t.sub, "sub/link.txt").unwrap();
    assert_eq!(
        stat_file_in(&t.sub, "sub/link.txt").unwrap(),
        Some(file.stamp)
    );
    t.write("real.txt", b"updated outside alabs");
    assert_eq!(
        stat_file_in(&t.sub, "sub/link.txt").unwrap(),
        Some(t.stamp("real.txt"))
    );
    fs::remove_file(t.root.join("real.txt")).unwrap();
    assert_eq!(stat_file_in(&t.sub, "sub/link.txt").unwrap(), None);

    symlink("../../outside/secret.txt", t.root.join("sub/escape.txt")).unwrap();
    fs::write(t.outside.join("secret.txt"), b"secret").unwrap();
    let err = stat_file_in(&t.sub, "sub/escape.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    t.write("parent-file", b"not a folder");
    assert_eq!(
        stat_file_in(&t.sub, "parent-file/missing.txt").unwrap(),
        None
    );
}

#[test]
fn stat_rejects_directory() {
    let t = TempSubject::new();
    fs::create_dir(t.root.join("dir")).unwrap();
    let err = stat_file_in(&t.sub, "dir").unwrap_err();
    assert!(err.contains("not a file"), "{}", err);
}

#[test]
fn stat_rejects_path_outside_subject() {
    let t = TempSubject::new();
    let abs = t.outside.join("secret.txt");
    fs::write(&abs, b"secret").unwrap();
    let err = stat_file_in(&t.sub, "../outside/secret.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    let err = stat_file_in(&t.sub, abs.to_str().unwrap()).unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
    // A missing path outside the subject is still refused, never reported as gone.
    let err = stat_file_in(&t.sub, "../outside/nope.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
}

#[test]
fn stat_rejects_symlink_escaping_subject() {
    let t = TempSubject::new();
    let target = t.outside.join("secret.txt");
    fs::write(&target, b"secret").unwrap();
    symlink(&target, t.root.join("link.txt")).unwrap();
    let err = stat_file_in(&t.sub, "link.txt").unwrap_err();
    assert!(err.contains("outside the subject"), "{}", err);
}

#[test]
fn rejects_invalid_utf8() {
    let t = TempSubject::new();
    t.write("blob.bin", &[0x00, 0xff, 0xfe, 0x80, 0x41]);
    let err = read_file_in(&t.sub, "blob.bin").unwrap_err();
    assert!(err.contains("not a UTF-8 text file"), "{}", err);
}

/// Run a search to completion and collect its results.
fn search_all(sub: &SubjectRoot, query: &str) -> (Vec<SearchResult>, SearchSummary) {
    // Walks the whole test folder as one scope, the way a place is walked.
    let mut results = Vec::new();
    let summary = search_walk(&sub.dir, "", query, &|| false, &mut |r| results.push(r));
    (results, summary)
}

/// Search one scope through the command path: prefix validated and opened
/// through the root handle.
fn search_scope(sub: &SubjectRoot, prefix: &str, query: &str) -> Result<Vec<String>, String> {
    let mut results = Vec::new();
    search_in(sub, prefix, query, &|| false, &mut |r| results.push(r))?;
    Ok(rel_paths(&results))
}

#[test]
fn scoped_search_stays_inside_its_place_and_reports_root_relative_paths() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("defiance/src")).unwrap();
    fs::create_dir_all(t.root.join("cockpit")).unwrap();
    fs::create_dir_all(t.root.join("views/defiance")).unwrap();
    t.write("defiance/src/ingest.py", b"needle\n");
    t.write("defiance/needle.md", b"nothing\n");
    t.write("cockpit/notes.txt", b"needle\n");
    t.write("views/defiance/index.html", b"needle\n");
    t.write("needle-at-root.txt", b"needle\n");
    let mut hits = search_scope(&t.sub, "defiance", "needle").unwrap();
    hits.sort();
    assert_eq!(hits, vec!["defiance/needle.md", "defiance/src/ingest.py"]);
    assert!(hits.iter().all(|h| h.starts_with("defiance/")));
    // The sibling place, the view folder and the root file are never reported.
    assert!(!hits
        .iter()
        .any(|h| h.contains("cockpit") || h.contains("views") || h.contains("at-root")));
    // A nested scope works and is still bounded to that folder.
    assert_eq!(
        search_scope(&t.sub, "defiance/src", "needle").unwrap(),
        vec!["defiance/src/ingest.py"]
    );
    // The other place sees only its own file.
    assert_eq!(
        search_scope(&t.sub, "cockpit", "needle").unwrap(),
        vec!["cockpit/notes.txt"]
    );
}

#[test]
fn scoped_search_refuses_the_root_and_invalid_prefixes() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("place")).unwrap();
    t.write("place/a.txt", b"needle\n");
    t.write("root.txt", b"needle\n");
    for bad in [
        "",
        "/",
        "/place",
        "place/",
        "..",
        "place/..",
        "../outside",
        "./place",
        "a//b",
        "pl\\ace",
    ] {
        let err = search_scope(&t.sub, bad, "needle").unwrap_err();
        assert!(
            err.contains("scope") || err.contains("outside the subject"),
            "{:?} -> {}",
            bad,
            err
        );
    }
    assert!(validate_scope_prefix("place").is_ok());
    assert!(validate_scope_prefix("place/sub").is_ok());
    assert!(validate_scope_prefix("").is_err());
    // Nothing in the root is reachable through a refused prefix.
    let err = search_scope(&t.sub, "missing", "needle").unwrap_err();
    assert!(err.contains("cannot access"), "{}", err);
    let err = search_scope(&t.sub, "root.txt", "needle").unwrap_err();
    assert!(err.contains("not a folder"), "{}", err);
}

#[test]
fn scoped_search_refuses_a_symlinked_scope() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("real")).unwrap();
    t.write("real/a.txt", b"needle\n");
    symlink("real", t.root.join("alias")).unwrap();
    fs::write(t.outside.join("leak.txt"), b"needle\n").unwrap();
    symlink(&t.outside, t.root.join("escape")).unwrap();
    let err = search_scope(&t.sub, "alias", "needle").unwrap_err();
    assert!(err.contains("not a folder"), "{}", err);
    let err = search_scope(&t.sub, "escape", "needle").unwrap_err();
    assert!(
        err.contains("outside the subject") || err.contains("not a folder"),
        "{}",
        err
    );
    assert_eq!(
        search_scope(&t.sub, "real", "needle").unwrap(),
        vec!["real/a.txt"]
    );
}

#[test]
fn entry_kind_reports_file_dir_none_and_refuses_outside() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("views/defiance")).unwrap();
    t.write("views/defiance/index.html", b"<svg/>");
    fs::write(t.outside.join("secret.txt"), b"x").unwrap();
    symlink(t.outside.join("secret.txt"), t.root.join("leak")).unwrap();
    symlink("nowhere", t.root.join("dangling")).unwrap();
    symlink("views/defiance/index.html", t.root.join("inside-link")).unwrap();
    assert_eq!(
        entry_kind_in(&t.sub, "views/defiance/index.html").unwrap(),
        EntryKind::File
    );
    assert_eq!(
        entry_kind_in(&t.sub, "views/defiance").unwrap(),
        EntryKind::Dir
    );
    assert_eq!(
        entry_kind_in(&t.sub, "views/cockpit/index.html").unwrap(),
        EntryKind::None
    );
    assert_eq!(entry_kind_in(&t.sub, "dangling").unwrap(), EntryKind::None);
    assert_eq!(
        entry_kind_in(&t.sub, "inside-link").unwrap(),
        EntryKind::File
    );
    // A file where a folder was expected in the path is absent, not an error.
    assert_eq!(
        entry_kind_in(&t.sub, "views/defiance/index.html/x").unwrap(),
        EntryKind::None
    );
    for bad in [
        "leak",
        "../outside/secret.txt",
        t.outside.join("secret.txt").to_str().unwrap(),
    ] {
        let err = entry_kind_in(&t.sub, bad).unwrap_err();
        assert!(err.contains("outside the subject"), "{} -> {}", bad, err);
    }
    assert!(entry_kind_in(&t.sub, "").is_err());
    let path = CString::new(t.root.join("pipe").as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: path is a valid NUL-terminated pathname; mode is permission bits.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    assert_eq!(entry_kind_in(&t.sub, "pipe").unwrap(), EntryKind::None);
}

#[test]
fn two_paths_to_one_file_open_as_two_stamps_and_the_second_save_is_a_conflict() {
    // An in-root symlink alias (Step 2 item 28): both paths read, the first
    // save lands, the second save is refused by the stamp check and the
    // disk keeps the first save's content.
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("a")).unwrap();
    fs::create_dir_all(t.root.join("b")).unwrap();
    t.write("b/real.txt", b"original");
    symlink("../b/real.txt", t.root.join("a/link.txt")).unwrap();
    let via_link = read_file_in(&t.sub, "a/link.txt").unwrap();
    let direct = read_file_in(&t.sub, "b/real.txt").unwrap();
    assert_eq!(via_link.content, "original");
    write_file_in(&t.sub, "a/link.txt", "from link", via_link.stamp).unwrap();
    let err = write_file_in(&t.sub, "b/real.txt", "from direct", direct.stamp).unwrap_err();
    assert!(err.contains("changed on disk"), "{}", err);
    assert_eq!(
        fs::read_to_string(t.root.join("b/real.txt")).unwrap(),
        "from link"
    );
    assert_eq!(
        t.names(&t.root.join("b")),
        vec!["real.txt"],
        "no temp file left behind"
    );
}

#[test]
fn log_rotates_once_at_the_limit_and_never_grows_a_second_backup() {
    let t = TempSubject::new();
    let dir = t.outside.join("data");
    append_log_in(&dir, "first line\n with a break").unwrap();
    let text = fs::read_to_string(dir.join(LOG_FILE)).unwrap();
    assert_eq!(text, "first line with a break\n", "one call is one line");
    let line = "x".repeat(1000);
    let mut written = text.len() as u64;
    while written + 1001 <= MAX_LOG_BYTES {
        append_log_in(&dir, &line).unwrap();
        written += 1001;
    }
    assert!(
        !dir.join(LOG_BACKUP).exists(),
        "no rotation before the limit"
    );
    assert_eq!(fs::metadata(dir.join(LOG_FILE)).unwrap().len(), written);
    // Less than one more full line fits, so this line rotates the file.
    assert!(written + 1001 > MAX_LOG_BYTES);
    append_log_in(&dir, &line).unwrap();
    assert_eq!(
        fs::metadata(dir.join(LOG_BACKUP)).unwrap().len(),
        written,
        "the full file became the backup"
    );
    assert_eq!(
        fs::read_to_string(dir.join(LOG_FILE)).unwrap(),
        format!("{}\n", line)
    );
    // Fill and rotate again: the old backup is replaced, never a second one.
    for _ in 0..1100 {
        append_log_in(&dir, &line).unwrap();
    }
    assert!(fs::metadata(dir.join(LOG_BACKUP)).unwrap().len() <= MAX_LOG_BYTES);
    assert!(fs::metadata(dir.join(LOG_FILE)).unwrap().len() <= MAX_LOG_BYTES);
    assert_eq!(
        t.names(&dir),
        vec![LOG_FILE.to_string(), LOG_BACKUP.to_string()]
    );
    let long = "y".repeat(MAX_LOG_LINE_CHARS + 100);
    append_log_in(&dir, &long).unwrap();
    let last = fs::read_to_string(dir.join(LOG_FILE)).unwrap();
    assert!(
        last.lines().last().unwrap().len() == MAX_LOG_LINE_CHARS,
        "a long line is cut"
    );
    assert!(!t.root.join(LOG_FILE).exists(), "never inside the root");
}

fn rel_paths(results: &[SearchResult]) -> Vec<String> {
    results.iter().map(|r| r.rel_path.clone()).collect()
}

#[test]
fn search_matches_filenames_case_insensitively() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("src")).unwrap();
    t.write("README.md", b"nothing here\n");
    t.write("src/readme_helper.rs", b"fn main() {}\n");
    t.write("src/other.rs", b"fn main() {}\n");
    let (results, summary) = search_all(&t.sub, "readme");
    let mut paths = rel_paths(&results);
    paths.sort();
    assert_eq!(paths, vec!["README.md", "src/readme_helper.rs"]);
    assert!(results.iter().all(|r| r.line.is_none() && r.text.is_none()));
    assert_eq!(summary.files, 3);
    assert!(!summary.truncated && !summary.cancelled);
}

#[test]
fn search_matches_content_with_line_numbers() {
    let t = TempSubject::new();
    t.write(
        "notes.txt",
        b"first line\nHello World\nthird\n  hello again  \n",
    );
    let (results, _) = search_all(&t.sub, "hello");
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].rel_path, "notes.txt");
    assert_eq!(results[0].name, "notes.txt");
    assert_eq!(results[0].line, Some(2));
    assert_eq!(results[0].text.as_deref(), Some("Hello World"));
    assert_eq!(results[1].line, Some(4));
    assert_eq!(results[1].text.as_deref(), Some("hello again"));
}

#[test]
fn search_reports_name_and_content_hits_for_the_same_file() {
    let t = TempSubject::new();
    t.write("config.toml", b"[config]\nname = \"x\"\n");
    let (results, _) = search_all(&t.sub, "config");
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].line, None);
    assert_eq!(results[1].line, Some(1));
}

#[test]
fn search_trims_long_lines() {
    let t = TempSubject::new();
    let long = format!("{}needle{}", "a".repeat(300), "b".repeat(300));
    t.write("long.txt", long.as_bytes());
    let (results, _) = search_all(&t.sub, "needle");
    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0].text.as_ref().unwrap().chars().count(),
        MAX_LINE_CHARS
    );
}

#[test]
fn search_ignores_empty_query() {
    let t = TempSubject::new();
    t.write("a.txt", b"anything\n");
    let (results, summary) = search_all(&t.sub, "   ");
    assert!(results.is_empty());
    assert_eq!(summary.files, 0);
}

#[test]
fn search_respects_gitignore_without_git_folder() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("build")).unwrap();
    fs::create_dir_all(t.root.join("src")).unwrap();
    t.write(".gitignore", b"build/\n*.log\n");
    t.write("build/out.txt", b"needle\n");
    t.write("debug.log", b"needle\n");
    t.write("src/main.rs", b"needle\n");
    let (results, _) = search_all(&t.sub, "needle");
    assert_eq!(rel_paths(&results), vec!["src/main.rs"]);
}

#[test]
fn search_respects_nested_gitignore_and_git_exclude() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join(".git/info")).unwrap();
    fs::create_dir_all(t.root.join("sub")).unwrap();
    t.write(".git/info/exclude", b"secret.txt\n");
    t.write(".git/config", b"needle\n");
    t.write("secret.txt", b"needle\n");
    t.write("sub/.gitignore", b"skipped.txt\n");
    t.write("sub/skipped.txt", b"needle\n");
    t.write("sub/kept.txt", b"needle\n");
    let (results, _) = search_all(&t.sub, "needle");
    assert_eq!(rel_paths(&results), vec!["sub/kept.txt"]);
}

#[test]
fn search_honours_ignore_precedence_and_whitelists() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("sub")).unwrap();
    // `.ignore` outranks `.gitignore` in the same folder; a deeper folder's
    // rule outranks its parent's.
    t.write(".gitignore", b"*.txt\n!keep.txt\n");
    t.write(".ignore", b"!lost.txt\n");
    t.write("lost.txt", b"needle\n");
    t.write("keep.txt", b"needle\n");
    t.write("gone.txt", b"needle\n");
    t.write("sub/.gitignore", b"!back.txt\n");
    t.write("sub/back.txt", b"needle\n");
    t.write("sub/gone.txt", b"needle\n");
    let (results, _) = search_all(&t.sub, "needle");
    let mut paths = rel_paths(&results);
    paths.sort();
    assert_eq!(paths, vec!["keep.txt", "lost.txt", "sub/back.txt"]);
}

#[test]
fn search_includes_hidden_files_but_never_git_folder() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join(".git")).unwrap();
    t.write(".git/HEAD", b"needle\n");
    t.write(".env", b"needle=1\n");
    let (results, _) = search_all(&t.sub, "needle");
    assert_eq!(rel_paths(&results), vec![".env"]);
}

#[test]
fn search_never_leaves_the_subject() {
    let t = TempSubject::new();
    fs::create_dir_all(t.outside.join("dir")).unwrap();
    fs::write(t.outside.join("leak.txt"), b"needle\n").unwrap();
    fs::write(t.outside.join("dir/deep.txt"), b"needle\n").unwrap();
    symlink(t.outside.join("leak.txt"), t.root.join("link.txt")).unwrap();
    symlink(t.outside.join("dir"), t.root.join("linkdir")).unwrap();
    // A filename that would match through the link must not be reported either.
    symlink(t.outside.join("leak.txt"), t.root.join("needle-link")).unwrap();
    t.write("inside.txt", b"needle\n");
    let (results, summary) = search_all(&t.sub, "needle");
    assert_eq!(rel_paths(&results), vec!["inside.txt"]);
    assert_eq!(summary.files, 1);
    assert!(results
        .iter()
        .all(|r| !r.rel_path.contains("..") && !r.rel_path.starts_with('/')));
}

#[test]
fn search_skips_binary_files_for_content_but_matches_their_names() {
    let t = TempSubject::new();
    t.write("image.bin", b"needle\0needle\n");
    t.write("latin1.txt", b"needle \xe9\n");
    t.write("needle.png", b"\x89PNG\0\0");
    t.write("plain.txt", b"needle\n");
    let (results, _) = search_all(&t.sub, "needle");
    let mut hits: Vec<(String, Option<u64>)> = results
        .iter()
        .map(|r| (r.rel_path.clone(), r.line))
        .collect();
    hits.sort();
    assert_eq!(
        hits,
        vec![
            ("needle.png".to_string(), None),
            ("plain.txt".to_string(), Some(1)),
        ]
    );
}

#[test]
fn search_skips_content_of_files_over_limit() {
    let t = TempSubject::new();
    let mut big = vec![b'a'; MAX_FILE_BYTES as usize];
    big.push(b'\n');
    big.extend_from_slice(b"needle\n");
    t.write("big-needle.txt", &big);
    t.write("small.txt", b"needle\n");
    let (results, _) = search_all(&t.sub, "needle");
    let mut hits: Vec<(String, Option<u64>)> = results
        .iter()
        .map(|r| (r.rel_path.clone(), r.line))
        .collect();
    hits.sort();
    assert_eq!(
        hits,
        vec![
            ("big-needle.txt".to_string(), None),
            ("small.txt".to_string(), Some(1)),
        ]
    );
}

#[test]
fn search_stops_at_result_cap() {
    let t = TempSubject::new();
    let content = "needle\n".repeat(MAX_SEARCH_RESULTS + 50);
    t.write("many.txt", content.as_bytes());
    let (results, summary) = search_all(&t.sub, "needle");
    assert_eq!(results.len(), MAX_SEARCH_RESULTS);
    assert!(summary.truncated);
    assert_eq!(summary.results as usize, MAX_SEARCH_RESULTS);
}

#[test]
fn search_stops_when_cancelled() {
    let t = TempSubject::new();
    for i in 0..20 {
        t.write(&format!("f{}.txt", i), b"needle\n");
    }
    let mut results = Vec::new();
    let summary = search_walk(&t.sub.dir, "", "needle", &|| true, &mut |r| results.push(r));
    assert!(summary.cancelled);
    assert!(results.is_empty());
    assert_eq!(summary.files, 0);
}

#[test]
fn subject_and_app_data_never_overlap() {
    let t = TempSubject::new();
    let state = t.outside.join("Application Support/me.dannysheehan.alabs");
    fs::create_dir_all(&state).unwrap();
    let state = state.canonicalize().unwrap();
    let parent = state.parent().unwrap().to_path_buf();

    let err = state_dir_conflict(&state, &state).unwrap();
    assert!(
        err.contains("overlaps the alabs application data folder"),
        "{}",
        err
    );
    let err = state_dir_conflict(&parent, &state).unwrap();
    assert!(err.contains("overlaps"), "{}", err);
    let err = state_dir_conflict(&state.join("nested"), &state).unwrap();
    assert!(err.contains("overlaps"), "{}", err);
    assert_eq!(state_dir_conflict(&t.root, &state), None);
    // A sibling that merely shares a name prefix is unrelated.
    let sibling = parent.join("me.dannysheehan.alabs-notes");
    assert_eq!(state_dir_conflict(&sibling, &state), None);
}

#[test]
fn app_data_dir_is_projected_canonically_even_before_it_exists() {
    let t = TempSubject::new();
    let missing = t.outside.join("no-such/app-data");
    let projected = canonical_projection(&missing);
    assert_eq!(
        projected,
        t.outside.canonicalize().unwrap().join("no-such/app-data")
    );
    // Through a symlinked ancestor the existing part is resolved.
    symlink(&t.outside, t.root.parent().unwrap().join("via-link")).unwrap();
    let via = t.root.parent().unwrap().join("via-link/no-such/app-data");
    assert_eq!(canonical_projection(&via), projected);
    assert!(!missing.exists(), "projection creates nothing");
}

#[test]
fn ui_state_absent_reads_as_none() {
    let t = TempSubject::new();
    assert_eq!(load_state_in(&t.outside.join("state")), Ok(None));
}

#[test]
fn ui_state_round_trips_and_creates_dir() {
    let t = TempSubject::new();
    let dir = t.outside.join("nested").join("state");
    save_state_in(&dir, "{\"version\":1}").unwrap();
    assert_eq!(load_state_in(&dir), Ok(Some("{\"version\":1}".to_string())));
    save_state_in(&dir, "{\"version\":2}").unwrap();
    assert_eq!(load_state_in(&dir), Ok(Some("{\"version\":2}".to_string())));
    assert_eq!(
        t.names(&dir),
        vec![STATE_FILE.to_string()],
        "no temp file left behind"
    );
}

#[test]
fn ui_state_rejects_oversized_write_and_names_unusable_files() {
    let t = TempSubject::new();
    let dir = t.outside.join("state");
    let big = "x".repeat(MAX_STATE_BYTES as usize + 1);
    assert!(save_state_in(&dir, &big).is_err());
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(STATE_FILE), big).unwrap();
    let err = load_state_in(&dir).unwrap_err();
    assert!(err.contains("larger than 1 MB"), "{}", err);
    // Only an absent file is a silent fresh start; a folder at the path is named.
    fs::remove_file(dir.join(STATE_FILE)).unwrap();
    assert_eq!(load_state_in(&dir), Ok(None));
    fs::create_dir(dir.join(STATE_FILE)).unwrap();
    let err = load_state_in(&dir).unwrap_err();
    assert!(err.contains("not a file"), "{}", err);
}

#[test]
fn ui_state_never_lands_in_the_subject() {
    let t = TempSubject::new();
    save_state_in(&t.outside, "{}").unwrap();
    assert!(!t.root.join(STATE_FILE).exists());
}

// Step 3: rename and move stay inside the owning place (BUILD_PLAN item 17).

#[test]
fn move_in_scope_allows_rename_and_move_inside_the_place() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("defiance/src")).unwrap();
    fs::create_dir_all(t.root.join("defiance/lib")).unwrap();
    t.write("defiance/src/main.rs", b"fn main() {}");
    let rel = move_in_scope(
        &t.sub,
        "defiance",
        "defiance/src/main.rs",
        "defiance/src",
        "app.rs",
    )
    .unwrap();
    assert_eq!(rel, "defiance/src/app.rs");
    let rel = move_in_scope(
        &t.sub,
        "defiance",
        "defiance/src/app.rs",
        "defiance/lib",
        "app.rs",
    )
    .unwrap();
    assert_eq!(rel, "defiance/lib/app.rs");
    assert!(t.root.join("defiance/lib/app.rs").is_file());
    // The place folder itself is a valid destination parent.
    let rel = move_in_scope(
        &t.sub,
        "defiance",
        "defiance/lib/app.rs",
        "defiance",
        "app.rs",
    )
    .unwrap();
    assert_eq!(rel, "defiance/app.rs");
}

#[test]
fn move_in_scope_refuses_a_destination_in_another_place_before_touching_disk() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("defiance")).unwrap();
    fs::create_dir_all(t.root.join("cockpit")).unwrap();
    t.write("defiance/a.txt", b"a");
    let err = move_in_scope(&t.sub, "defiance", "defiance/a.txt", "cockpit", "a.txt").unwrap_err();
    assert!(
        err.starts_with("path is outside the scope defiance: cockpit"),
        "{}",
        err
    );
    let err = move_in_scope(&t.sub, "defiance", "defiance/a.txt", "", "a.txt").unwrap_err();
    assert!(err.contains("outside the scope defiance"), "{}", err);
    // A source in another place is refused too, even with a destination inside the scope.
    t.write("cockpit/c.txt", b"c");
    let err = move_in_scope(&t.sub, "defiance", "cockpit/c.txt", "defiance", "c.txt").unwrap_err();
    assert!(
        err.contains("outside the scope defiance: cockpit/c.txt"),
        "{}",
        err
    );
    // A prefix that merely starts with the place name is not inside it.
    fs::create_dir_all(t.root.join("defiance2")).unwrap();
    let err =
        move_in_scope(&t.sub, "defiance", "defiance/a.txt", "defiance2", "a.txt").unwrap_err();
    assert!(err.contains("outside the scope"), "{}", err);
    assert!(t.root.join("defiance/a.txt").is_file());
    assert!(t.root.join("cockpit/c.txt").is_file());
    assert!(!t.root.join("cockpit/a.txt").exists());
    assert!(!t.root.join("defiance2/a.txt").exists());
    assert!(!t.root.join("a.txt").exists());
}

#[test]
fn move_in_scope_refuses_a_symlinked_destination_that_resolves_into_another_place() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("defiance")).unwrap();
    fs::create_dir_all(t.root.join("cockpit")).unwrap();
    t.write("defiance/a.txt", b"a");
    // A relative link stays inside the root, so only the place check can refuse it.
    symlink("../cockpit", t.root.join("defiance/link")).unwrap();
    let err = move_in_scope(
        &t.sub,
        "defiance",
        "defiance/a.txt",
        "defiance/link",
        "a.txt",
    )
    .unwrap_err();
    assert!(err.contains("outside the scope defiance"), "{}", err);
    assert!(t.root.join("defiance/a.txt").is_file());
    assert!(!t.root.join("cockpit/a.txt").exists());
}

#[test]
fn move_in_scope_rejects_an_empty_or_invalid_scope() {
    let t = TempSubject::new();
    fs::create_dir_all(t.root.join("defiance")).unwrap();
    t.write("defiance/a.txt", b"a");
    let err = move_in_scope(&t.sub, "", "defiance/a.txt", "defiance", "b.txt").unwrap_err();
    assert!(err.contains("scope is empty"), "{}", err);
    let err = move_in_scope(&t.sub, "../x", "defiance/a.txt", "defiance", "b.txt").unwrap_err();
    assert!(err.contains("invalid scope"), "{}", err);
    assert!(t.root.join("defiance/a.txt").is_file());
}

#[test]
fn search_cleanup_only_cancels_its_own_request() {
    let subject = Subject::default();
    subject.latest_search.store(2, Ordering::SeqCst);
    subject.cancel_search(1);
    assert!(subject.search_is_current(2));
    subject.cancel_search(2);
    assert!(!subject.search_is_current(2));
    subject.latest_search.store(3, Ordering::SeqCst);
    subject.cancel_search(2);
    assert!(subject.search_is_current(3));
    subject.cancel_searches();
    assert!(!subject.search_is_current(3));
}

#[test]
fn raven_session_rejects_reads_and_pair_writes_after_a_b_and_a_b_a() {
    let a = TempSubject::new();
    let b = TempSubject::new();
    let subject = Subject::default();
    for temp in [&a, &b] {
        fs::create_dir_all(temp.root.join("work")).unwrap();
        fs::create_dir_all(temp.root.join("views/work")).unwrap();
        fs::create_dir_all(temp.root.join("views/.root")).unwrap();
        temp.write("work/evidence.txt", b"fixture evidence");
        for folder in ["work", ".root"] {
            temp.write(&format!("views/{folder}/map.svg"), b"old map");
            temp.write(&format!("views/{folder}/view.json"), b"old facts");
        }
    }
    subject.replace_root(a.sub.try_clone().unwrap()).unwrap();
    let session = subject.root_session.load(Ordering::SeqCst);
    for temp in [&b, &a] {
        subject.replace_root(temp.sub.try_clone().unwrap()).unwrap();
        let read = with_root_session(&subject, Some(session), |root| {
            read_file_in(root, "work/evidence.txt")
        });
        assert!(read.unwrap_err().contains("root changed"));
        let inventory = with_root_session(&subject, Some(session), |root| {
            view_files::collect_inventory(root, "work")
        });
        assert!(inventory.unwrap_err().contains("root changed"));
        for root_map in [false, true] {
            let write = with_root_session(&subject, Some(session), |root| {
                let expected = a.root.to_string_lossy();
                if root_map {
                    view_files::write_root_view_files(root, &expected, "new facts", "new map", true)
                } else {
                    view_files::write_view_files(
                        root,
                        "work",
                        &expected,
                        "new facts",
                        "new map",
                        true,
                    )
                }
            });
            assert!(write.unwrap_err().contains("root changed"));
        }
    }
    for temp in [&a, &b] {
        for folder in ["work", ".root"] {
            assert_eq!(
                fs::read(temp.root.join(format!("views/{folder}/map.svg"))).unwrap(),
                b"old map"
            );
            assert_eq!(
                fs::read(temp.root.join(format!("views/{folder}/view.json"))).unwrap(),
                b"old facts"
            );
        }
    }
    let fresh = subject.root_session.load(Ordering::SeqCst);
    assert!(
        with_root_session(&subject, Some(fresh), |root| read_file_in(
            root,
            "work/evidence.txt"
        ))
        .is_ok()
    );
}

#[test]
fn raven_read_handle_stays_in_original_root_after_switch() {
    let a = TempSubject::new();
    let b = TempSubject::new();
    a.write("evidence.txt", b"fixture A");
    b.write("evidence.txt", b"fixture B");
    let subject = Subject::default();
    subject.replace_root(a.sub.try_clone().unwrap()).unwrap();
    let session = subject.root_session.load(Ordering::SeqCst);
    let captured = with_root_session(&subject, Some(session), SubjectRoot::try_clone).unwrap();
    subject.replace_root(b.sub.try_clone().unwrap()).unwrap();
    assert_eq!(
        read_file_in(&captured, "evidence.txt").unwrap().content,
        "fixture A"
    );
}

#[test]
fn raven_pair_commit_and_root_switch_are_serialized() {
    use std::sync::{mpsc, Arc, TryLockError};
    let a = TempSubject::new();
    let b = TempSubject::new();
    let subject = Arc::new(Subject::default());
    subject.replace_root(a.sub.try_clone().unwrap()).unwrap();
    let session = subject.root_session.load(Ordering::SeqCst);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let writer_subject = subject.clone();
    let writer = std::thread::spawn(move || {
        with_root_session(&writer_subject, Some(session), |root| {
            entered_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
            view_files::write_root_view_files(
                root,
                &root.path.to_string_lossy(),
                "fixture facts",
                "fixture map",
                true,
            )
        })
        .unwrap();
    });
    entered_rx.recv().unwrap();
    // The exact lock used by replace_root cannot be acquired mid-commit.
    assert!(matches!(
        subject.root.try_lock(),
        Err(TryLockError::WouldBlock)
    ));
    finish_tx.send(()).unwrap();
    writer.join().unwrap();
    subject.replace_root(b.sub.try_clone().unwrap()).unwrap();
    assert_eq!(
        fs::read(a.root.join("views/.root/map.svg")).unwrap(),
        b"fixture map"
    );
    assert!(!b.root.join("views").exists());
    assert!(with_root_session(&subject, Some(session), |_| Ok(())).is_err());
}

#[test]
fn unicode_move_conflict_trash_and_recovery_preserve_both_versions() {
    let t = TempSubject::new();
    let place = "長い名前 résumé with spaces";
    fs::create_dir_all(t.root.join(place).join("notes")).unwrap();
    let original = format!("{place}/draft.txt");
    t.write(&original, b"original");
    let opened = read_file_in(&t.sub, &original).unwrap();
    let moved = move_in_scope(
        &t.sub,
        place,
        &original,
        &format!("{place}/notes"),
        "改訂.txt",
    )
    .unwrap();
    assert!(!t.root.join(&original).exists());
    // The open editor's stamp remains valid across the explicit move.
    let saved = write_file_in(&t.sub, &moved, "my edit", opened.stamp).unwrap();
    // An external replacement must survive a stale editor save.
    let replacement = t.root.join(place).join("replacement.txt");
    fs::write(&replacement, "external work").unwrap();
    fs::rename(&replacement, t.root.join(&moved)).unwrap();
    assert!(write_file_in(&t.sub, &moved, "unsaved buffer", saved).is_err());
    assert_eq!(
        read_file_in(&t.sub, &moved).unwrap().content,
        "external work"
    );
    // Only this fixture's fake Trash is touched. Recovery may create only a missing path.
    t.trash(&moved).unwrap();
    assert_eq!(
        fs::read_to_string(t.trash.join("改訂.txt")).unwrap(),
        "external work"
    );
    let recovered = recreate_file_in(&t.sub, &moved, "unsaved buffer").unwrap();
    assert!(recreate_file_in(&t.sub, &moved, "clobber").is_err());
    assert_eq!(
        read_file_in(&t.sub, &moved).unwrap().content,
        "unsaved buffer"
    );
    write_file_in(&t.sub, &moved, "recovered and saved", recovered).unwrap();
    assert_eq!(
        read_file_in(&t.sub, &moved).unwrap().content,
        "recovered and saved"
    );
    assert_eq!(
        fs::read_to_string(t.trash.join("改訂.txt")).unwrap(),
        "external work"
    );
    assert_eq!(t.names(&t.root.join(place).join("notes")), vec!["改訂.txt"]);
}
