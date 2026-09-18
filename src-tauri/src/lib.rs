//! alabs backend: every filesystem command is anchored to one open directory
//! handle, the alabs root (called the subject in the code and its errors).
//! Paths from the frontend are root-relative and are resolved component by
//! component from that handle (`cap-std`), so no pathname is ever validated
//! first and reopened later. Work places are root-relative prefixes inside
//! that one handle, never a second handle.
//!
//! alabs supports macOS only: atomic no-replace and swap renames use
//! `renameatx_np`, and Delete moves entries into the user's `~/.Trash`.

// The core below is one whole; a front door decides how much of it to offer.
// The browser front door is still being filled in checkpoint by checkpoint,
// so building it alone leaves the operations it does not serve yet unused.
// The default build is the desktop one, which offers all of them, so nothing
// genuinely dead can hide behind this.
#![cfg_attr(not(feature = "desktop"), allow(dead_code))]

#[cfg(not(target_os = "macos"))]
compile_error!("alabs supports macOS only");

use std::ffi::CString;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use cap_std::ambient_authority;
use cap_std::fs::{Dir, File, Metadata, MetadataExt, OpenOptions, OpenOptionsExt, Permissions};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;
use serde::{Deserialize, Serialize};
use std::os::unix::fs::PermissionsExt;

mod git;
mod local_model;
mod view_files;

/// Largest file (in bytes) that may be loaded into the editor or searched.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// The active subject: one folder on disk, held open as a directory handle.
/// Every file operation resolves its subject-relative path from this handle
/// and never through an ambient pathname.
#[derive(Debug)]
struct SubjectRoot {
    /// Canonical absolute path, for display and for the app-data overlap rule.
    path: PathBuf,
    dir: Dir,
}

impl SubjectRoot {
    /// Open `path` as a subject. This is the one ambient pathname lookup:
    /// the folder the user chose is opened as a directory handle, and the
    /// canonical path is then read back from that handle, so it always
    /// describes the folder actually held open.
    fn open(path: &Path) -> Result<Self, String> {
        let dir = Dir::open_ambient_dir(path, ambient_authority()).map_err(|e| {
            if e.kind() == io::ErrorKind::NotADirectory {
                format!("not a folder: {}", path.display())
            } else {
                format!("cannot open {}: {}", path.display(), e)
            }
        })?;
        let root = dir_path(&dir).map_err(|e| format!("cannot open {}: {}", path.display(), e))?;
        Ok(SubjectRoot { path: root, dir })
    }

    /// A second handle to the same directory (a duplicated descriptor).
    fn try_clone(&self) -> Result<Self, String> {
        Ok(SubjectRoot {
            path: self.path.clone(),
            dir: self.dir.try_clone().map_err(|e| e.to_string())?,
        })
    }

    /// Open the folder at `rel` (empty means the subject itself) inside the
    /// subject. Fails with the raw io error so callers can tell "missing"
    /// from "outside" from "not a folder".
    fn open_dir_raw(&self, rel: &str) -> io::Result<Dir> {
        if rel.is_empty() {
            self.dir.try_clone()
        } else {
            self.dir.open_dir(rel)
        }
    }

    fn open_dir(&self, rel: &str) -> Result<Dir, String> {
        self.open_dir_raw(rel).map_err(|e| dir_err(rel, e))
    }

    /// The parent folder handle and bare name of the entry at `rel`, without
    /// touching the entry itself. `rel` must not be empty. Used by every
    /// operation that acts on a directory entry (create, save, rename, move,
    /// Trash) so the final syscall is made relative to a validated handle.
    fn parent_of(&self, rel: &str) -> Result<(Dir, String), String> {
        let (parent_rel, name) = match rel.rsplit_once('/') {
            Some((parent, name)) => (parent, name),
            None => ("", rel),
        };
        validate_name(name)?;
        let dir = self
            .open_dir_raw(parent_rel)
            .map_err(|e| access_err(rel, e))?;
        Ok((dir, name.to_string()))
    }

    /// Canonical subject-relative path of an existing `rel` ("" for the root).
    fn canonical_rel(&self, rel: &str) -> Result<PathBuf, String> {
        if rel.is_empty() {
            return Ok(PathBuf::new());
        }
        let canon = self.dir.canonicalize(rel).map_err(|e| access_err(rel, e))?;
        Ok(if canon == Path::new(".") {
            PathBuf::new()
        } else {
            canon
        })
    }
}

#[derive(Default)]
struct Subject {
    root: Mutex<Option<SubjectRoot>>,
    /// Changes on every successful root open, including A → B → A. Guarded by root.
    root_session: AtomicU64,
    /// Id of the most recent search. A running search stops as soon as a
    /// newer one starts, so at most one search touches the disk at a time.
    latest_search: AtomicU64,
    /// Git object format per place, looked up once per place per root.
    git_formats: git::FormatCache,
}

#[derive(Serialize)]
struct SubjectInfo {
    name: String,
    path: String,
}

/// True for the error `cap-std` returns when a path would leave the subject
/// (an absolute path, `..` past the root, or a symlink pointing outside).
fn is_escape(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied
        && e.to_string().contains("outside of the filesystem")
}

fn access_err(rel: &str, e: io::Error) -> String {
    if is_escape(&e) {
        format!("path is outside the subject: {}", rel)
    } else {
        format!("cannot access {}: {}", rel, e)
    }
}

fn dir_err(rel: &str, e: io::Error) -> String {
    if e.kind() == io::ErrorKind::NotADirectory {
        format!("not a folder: {}", rel)
    } else {
        access_err(rel, e)
    }
}

/// On-disk state of a file at the moment it was read. A save is refused when
/// the file's current stamp no longer matches the one recorded at read time.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    /// Decimal device/inode pair; a string keeps full precision through JavaScript.
    identity: String,
    mtime_secs: u64,
    mtime_nanos: u32,
    len: u64,
}

impl FileStamp {
    fn of(meta: &Metadata) -> Result<Self, String> {
        Self::from_parts(
            meta.modified().map_err(|e| e.to_string())?.into_std(),
            meta.len(),
            meta.dev(),
            meta.ino(),
        )
    }

    #[cfg(test)]
    fn of_std(meta: &fs::Metadata) -> Result<Self, String> {
        use std::os::unix::fs::MetadataExt;
        Self::from_parts(
            meta.modified().map_err(|e| e.to_string())?,
            meta.len(),
            meta.dev(),
            meta.ino(),
        )
    }

    fn from_parts(modified: SystemTime, len: u64, dev: u64, ino: u64) -> Result<Self, String> {
        let since = modified
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?;
        Ok(FileStamp {
            identity: format!("{dev}:{ino}"),
            mtime_secs: since.as_secs(),
            mtime_nanos: since.subsec_nanos(),
            len,
        })
    }
}

#[derive(Serialize, Debug, PartialEq)]
struct FileContent {
    name: String,
    content: String,
    stamp: FileStamp,
}

#[derive(Serialize, Debug)]
struct Entry {
    name: String,
    /// Path relative to the subject root, using "/" separators.
    rel_path: String,
    is_dir: bool,
}

/// Last component of a subject-relative path.
fn base_name(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

/// Join a subject-relative folder and a name with "/".
fn rel_join(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

fn path_to_rel(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// The current absolute path of an open directory, from the kernel
/// (`F_GETPATH`). Informational only: nothing is reopened through it.
fn dir_path(dir: &Dir) -> io::Result<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: the descriptor is open and the buffer is PATH_MAX bytes, which
    // is what F_GETPATH requires.
    let rc = unsafe { libc::fcntl(dir.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
    if rc == -1 {
        return Err(io::Error::last_os_error());
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..end])))
}

/// Mode a newly created file gets by default (0666 masked by the process
/// umask), read once. Recreated files are staged as 0600 and then given
/// this mode, matching what a plain create would have produced.
fn default_file_mode() -> u32 {
    static MODE: OnceLock<u32> = OnceLock::new();
    *MODE.get_or_init(|| {
        // SAFETY: umask has no preconditions; it is set back immediately.
        let mask = unsafe { libc::umask(0o022) };
        unsafe { libc::umask(mask) };
        0o666 & !(mask as u32)
    })
}

/// True when both metadata describe the same filesystem object.
fn same_inode(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}

/// Open without waiting for a FIFO writer, then check the opened object before
/// any text read. O_NONBLOCK has no effect on ordinary regular-file reads.
fn open_regular_file(dir: &Dir, rel: &str) -> io::Result<(File, Metadata)> {
    let mut opts = OpenOptions::new();
    opts.read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
    let file = dir.open_with(rel, &opts)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other(format!("not a file: {}", rel)));
    }
    Ok((file, meta))
}

/// Read at most `MAX_FILE_BYTES + 1` bytes from an open regular file.
/// `None` means the file holds more than `MAX_FILE_BYTES`. The buffer is
/// sized from `len_hint` but never beyond the bound, so a file that grows
/// after it was measured is neither read in full nor trusted for allocation.
fn read_bytes_bounded(file: &File, len_hint: u64) -> io::Result<Option<Vec<u8>>> {
    let cap = len_hint.min(MAX_FILE_BYTES + 1) as usize;
    let mut buf = Vec::with_capacity(cap);
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > MAX_FILE_BYTES {
        return Ok(None);
    }
    Ok(Some(buf))
}

/// UTF-8 text of an open regular file, bounded by `MAX_FILE_BYTES`.
fn read_text_bounded(file: &File, len_hint: u64, rel: &str) -> Result<String, String> {
    let bytes = read_bytes_bounded(file, len_hint)
        .map_err(|e| format!("cannot read {}: {}", rel, e))?
        .ok_or_else(|| {
            format!(
                "file is larger than {} MB: {}",
                MAX_FILE_BYTES / (1024 * 1024),
                rel
            )
        })?;
    String::from_utf8(bytes).map_err(|_| format!("not a UTF-8 text file: {}", rel))
}

/// Read a UTF-8 text file inside the subject. The file is opened through the
/// subject handle (a symlink is followed only while it stays inside), then
/// the open handle itself is checked to be a regular file and read with a
/// hard bound. Refuses non-files, oversized files and invalid UTF-8.
fn read_file_in(sub: &SubjectRoot, rel: &str) -> Result<FileContent, String> {
    let (file, meta) = open_regular_file(&sub.dir, rel).map_err(|e| access_err(rel, e))?;
    // The stamp is taken before the content: a change that lands in between
    // makes the stamp older than the content and only ever costs a spurious
    // conflict at save time, never a silent overwrite.
    let stamp = FileStamp::of(&meta)?;
    let content = read_text_bounded(&file, meta.len(), rel)?;
    Ok(FileContent {
        name: base_name(rel),
        content,
        stamp,
    })
}

/// Rename `from` (relative to `src`) to `to` (relative to `dst`) with the
/// given `renameatx_np` flags. Both names are single components resolved by
/// the kernel relative to the open directory handles, so nothing is looked up
/// by pathname.
fn rename_at(src: &Dir, from: &str, dst: &Dir, to: &str, flags: libc::c_uint) -> io::Result<()> {
    let from = CString::new(from)?;
    let to = CString::new(to)?;
    // SAFETY: both descriptors are open directories owned by the handles and
    // both pointers are valid NUL-terminated C strings for the call.
    let rc = unsafe {
        libc::renameatx_np(
            src.as_raw_fd(),
            from.as_ptr(),
            dst.as_raw_fd(),
            to.as_ptr(),
            flags,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Rename that fails if anything already exists at the destination.
fn rename_noreplace(src: &Dir, from: &str, dst: &Dir, to: &str) -> io::Result<()> {
    rename_at(src, from, dst, to, libc::RENAME_EXCL)
}

/// Atomically exchange two existing entries.
fn rename_swap(src: &Dir, from: &str, dst: &Dir, to: &str) -> io::Result<()> {
    rename_at(src, from, dst, to, libc::RENAME_SWAP)
}

/// Remove the entry `name` in `dir` only if it is still the object described
/// by `expected`. Nothing is ever removed on the strength of a name alone.
fn remove_if_same(dir: &Dir, name: &str, expected: &Metadata) -> io::Result<()> {
    let current = dir.symlink_metadata(name)?;
    if !same_inode(&current, expected) {
        return Err(io::Error::other("entry was replaced"));
    }
    dir.remove_file(name)
}

/// Current on-disk stamp of the file at `rel`, or `None` when nothing exists
/// there any more (a missing parent or a dangling link count as gone). Used by
/// an explicit Refresh and by a refused save. Refuses paths outside the
/// subject and targets that exist but are not files.
fn stat_file_in(sub: &SubjectRoot, rel: &str) -> Result<Option<FileStamp>, String> {
    let name = base_name(rel);
    if name.is_empty() || name == "." || name == ".." {
        return Err(format!("not a file: {}", rel));
    }
    // Keep the entire relative symlink resolution rooted at the subject:
    // e.g. sub/link -> ../real.txt is contained even though it leaves sub/.
    let meta = match sub.dir.metadata(rel) {
        Ok(meta) => meta,
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None)
        }
        Err(e) => return Err(access_err(rel, e)),
    };
    if !meta.is_file() {
        return Err(format!("not a file: {}", rel));
    }
    FileStamp::of(&meta).map(Some)
}

/// Short, fixed-form name for a temporary file: the process id and a
/// per-process counter keep concurrent saves apart, and the name never
/// depends on the target's name so it cannot exceed filename length limits.
fn temp_name() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!(
        ".alabs-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// Create `tmp` in `dir` with mode 0600, then write, set the final
/// permissions when given, and sync. Content is never written before the
/// restrictive mode is in place. On failure the temp entry is removed (after
/// checking it is still ours) and the error returned.
fn stage_temp(
    dir: &Dir,
    tmp: &str,
    content: &str,
    final_perms: Option<Permissions>,
    rel: &str,
) -> Result<File, String> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true).mode(0o600);
    let mut file = dir
        .open_with(tmp, &opts)
        .map_err(|e| format!("cannot create temporary file for {}: {}", rel, e))?;
    let write = || -> Result<(), String> {
        file.write_all(content.as_bytes())
            .map_err(|e| format!("cannot write {}: {}", rel, e))?;
        if let Some(perms) = final_perms {
            file.set_permissions(perms)
                .map_err(|e| format!("cannot set permissions on {}: {}", rel, e))?;
        }
        file.sync_all()
            .map_err(|e| format!("cannot sync {}: {}", rel, e))
    };
    if let Err(e) = write() {
        if let Ok(meta) = file.metadata() {
            let _ = remove_if_same(dir, tmp, &meta);
        }
        return Err(e);
    }
    Ok(file)
}

/// Replace the contents of an existing file inside the subject; see
/// `write_file_in_with`.
fn write_file_in(
    sub: &SubjectRoot,
    rel: &str,
    content: &str,
    expected: FileStamp,
) -> Result<FileStamp, String> {
    write_file_in_with(sub, rel, content, expected, || {})
}

/// Replace the contents of an existing file inside the subject.
///
/// Refuses missing targets (never creates a file; see `recreate_file_in`),
/// non-files, and targets whose on-disk stamp differs from `expected`.
///
/// Protocol. The target is opened through the subject handle and that open
/// descriptor is validated (regular file, stamp equals `expected`, same inode
/// as the directory entry) and held for the whole save. The new content goes
/// to a temporary sibling created with mode 0600, is written, given the
/// target's permission bits and synced. The commit point is one atomic
/// `RENAME_SWAP`: the target name now holds the new content and the temporary
/// name holds whatever inode was at the target at that instant. Only after
/// the displaced entry is proven to be the validated inode with the expected
/// stamp is it unlinked. Otherwise the target was replaced or rewritten
/// before the commit; the swap is undone (after re-checking both entries),
/// the staged copy is removed, and a conflict is returned. An outside update
/// that happened before the commit and is observable through the validated
/// target therefore never disappears silently.
///
/// Platform limitation: a process that already holds a descriptor to the
/// displaced inode keeps writing to that inode, which after the commit is no
/// longer the file at the target name. alabs cannot see or prevent that.
///
/// Returns the stamp of the content alabs staged, taken from the staged
/// descriptor before the commit, so it can never describe a later outside
/// version. `before_commit` runs between staging and the swap; tests use it
/// to reproduce a concurrent update.
fn write_file_in_with(
    sub: &SubjectRoot,
    rel: &str,
    content: &str,
    expected: FileStamp,
    before_commit: impl FnOnce(),
) -> Result<FileStamp, String> {
    // cap-std canonicalization opens the final component on macOS. Reject a
    // normal external replacement with a special file before that can block.
    open_regular_file(&sub.dir, rel).map_err(|e| access_err(rel, e))?;
    // Resolve a symlink inside the subject to its real entry, so saving
    // through a link replaces the target file rather than the link itself.
    let canon = sub.canonical_rel(rel)?;
    let name = match canon.file_name() {
        Some(name) => name.to_string_lossy().into_owned(),
        None => return Err(format!("not a file: {}", rel)),
    };
    let parent_rel = path_to_rel(canon.parent().unwrap_or(Path::new("")));
    let dir = sub.open_dir(&parent_rel)?;

    let (target, meta) = open_regular_file(&dir, &name).map_err(|e| access_err(rel, e))?;
    let entry = dir
        .symlink_metadata(&name)
        .map_err(|e| format!("cannot access {}: {}", rel, e))?;
    let changed = || format!("{} changed on disk since it was opened; save refused", rel);
    if !same_inode(&entry, &meta) || FileStamp::of(&meta)? != expected {
        return Err(changed());
    }

    let tmp = temp_name();
    let staged = stage_temp(&dir, &tmp, content, Some(meta.permissions()), rel)?;
    let staged_meta = staged
        .metadata()
        .map_err(|e| format!("cannot access {}: {}", rel, e))?;
    let stamp = FileStamp::of(&staged_meta)?;

    before_commit();

    // Commit point.
    if let Err(e) = rename_swap(&dir, &tmp, &dir, &name) {
        let _ = remove_if_same(&dir, &tmp, &staged_meta);
        return Err(format!("cannot replace {}: {}", rel, e));
    }

    // Verify through the held descriptor and the directory handle.
    let displaced = dir.symlink_metadata(&tmp);
    let held = target.metadata();
    let intact = matches!((&displaced, &held), (Ok(d), Ok(h))
        if same_inode(d, &meta) && FileStamp::of(h).ok() == Some(expected));
    if intact {
        let _ = remove_if_same(&dir, &tmp, &meta);
        return Ok(stamp);
    }

    // Conflict: put the outside version back. The second swap runs only if
    // the target name still holds the staged inode and the temporary name
    // still holds a foreign entry; the staged copy is removed only if it is
    // ours.
    let target_now = dir.symlink_metadata(&name);
    let can_undo = matches!((&displaced, &target_now), (Ok(d), Ok(t))
        if !same_inode(d, &staged_meta) && same_inode(t, &staged_meta));
    if can_undo && rename_swap(&dir, &tmp, &dir, &name).is_ok() {
        let _ = remove_if_same(&dir, &tmp, &staged_meta);
    }
    Err(format!("{} changed on disk during save; save refused", rel))
}

/// Recreate a file that has disappeared from disk, at its original `rel`,
/// with `content`. Called only after the user explicitly agreed; nothing
/// here is automatic.
///
/// Refuses a parent folder that is missing, not a folder, or outside the
/// subject, an invalid final name, and any existing entry at the target
/// (including a symlink). The content is staged in a 0600 temporary sibling,
/// synced, and moved into place with a no-replace rename relative to the
/// parent handle, so a file that appears at the name in the meantime is
/// never overwritten. Returns the stamp of the new file.
fn recreate_file_in(sub: &SubjectRoot, rel: &str, content: &str) -> Result<FileStamp, String> {
    if rel.is_empty() {
        return Err("name is empty".to_string());
    }
    let (dir, name) = sub.parent_of(rel)?;
    if dir.symlink_metadata(&name).is_ok() {
        return Err(format!("already exists: {}", rel));
    }
    let tmp = temp_name();
    let staged = stage_temp(
        &dir,
        &tmp,
        content,
        Some(Permissions::from_std(fs::Permissions::from_mode(
            default_file_mode(),
        ))),
        rel,
    )?;
    let staged_meta = staged
        .metadata()
        .map_err(|e| format!("cannot access {}: {}", rel, e))?;
    let stamp = FileStamp::of(&staged_meta)?;
    if let Err(e) = rename_noreplace(&dir, &tmp, &dir, &name) {
        let _ = remove_if_same(&dir, &tmp, &staged_meta);
        return Err(if e.kind() == io::ErrorKind::AlreadyExists {
            format!("already exists: {}", rel)
        } else {
            format!("cannot create {}: {}", rel, e)
        });
    }
    Ok(stamp)
}

/// Validate a bare item name: exactly one non-empty path component.
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("name is empty".to_string());
    }
    if name == "." || name == ".." {
        return Err(format!("invalid name: {}", name));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(format!("invalid name: {}", name));
    }
    Ok(())
}

/// Create a new empty file or folder named `name` inside `parent_rel`, a
/// folder inside the subject. Refuses parents outside the subject, invalid
/// names, and any existing item at the target. Returns the new item's path
/// relative to the subject.
fn create_in(
    sub: &SubjectRoot,
    parent_rel: &str,
    name: &str,
    is_dir: bool,
) -> Result<String, String> {
    validate_name(name)?;
    let dir = sub.open_dir(parent_rel)?;
    create_at(&dir, name, is_dir, &rel_join(parent_rel, name))
}

/// Create `name` relative to the open folder `dir`. `rel` is only for messages.
fn create_at(dir: &Dir, name: &str, is_dir: bool, rel: &str) -> Result<String, String> {
    let result = if is_dir {
        dir.create_dir(name)
    } else {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        dir.open_with(name, &opts).map(|_| ())
    };
    match result {
        Ok(()) => Ok(rel.to_string()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            Err(format!("already exists: {}", rel))
        }
        Err(e) => Err(format!("cannot create {}: {}", rel, e)),
    }
}

/// Rename or move the file or folder at `from_rel` so it becomes
/// `to_parent_rel/new_name`. A rename keeps the parent; a move keeps the name.
///
/// The source is the directory entry itself: a symlink is moved as a link,
/// its target is never touched. Refuses invalid names, the subject root
/// itself, sources or destination parents outside the subject, a destination
/// parent that is missing or not a folder (nothing is ever created), moving a
/// folder into itself or a descendant, and any existing item at the
/// destination. The only exception is a destination that is the source entry
/// itself, which permits a case-only rename on case-insensitive filesystems.
/// The rename is made relative to the two validated parent handles and
/// refuses to replace anything, so an item that appears at the destination
/// between the check and the rename is never overwritten. Returns the item's
/// new subject-relative path.
fn move_in(
    sub: &SubjectRoot,
    from_rel: &str,
    to_parent_rel: &str,
    new_name: &str,
) -> Result<String, String> {
    validate_name(new_name)?;
    if from_rel.is_empty() {
        return Err("cannot move the subject folder".to_string());
    }
    let (src_dir, src_name) = sub.parent_of(from_rel)?;
    let src_meta = src_dir
        .symlink_metadata(&src_name)
        .map_err(|e| format!("cannot access {}: {}", from_rel, e))?;
    let dst_dir = sub.open_dir(to_parent_rel)?;
    let dst_canon = sub.canonical_rel(to_parent_rel)?;
    // Only a real folder can contain the destination; a symlink to one cannot.
    if src_meta.is_dir() {
        let src_canon = sub.canonical_rel(from_rel)?;
        if src_canon.as_os_str().is_empty() {
            return Err("cannot move the subject folder".to_string());
        }
        if dst_canon.starts_with(&src_canon) {
            return Err(format!("cannot move {} into itself", from_rel));
        }
    }
    let rel = rel_join(&path_to_rel(&dst_canon), new_name);
    let same_dir = match (src_dir.dir_metadata(), dst_dir.dir_metadata()) {
        (Ok(a), Ok(b)) => same_inode(&a, &b),
        _ => false,
    };
    if same_dir && src_name == new_name {
        return Err(format!("nothing to change: {}", rel));
    }
    let case_only = dst_dir
        .symlink_metadata(new_name)
        .map(|m| same_inode(&m, &src_meta))
        .unwrap_or(false);
    let result = if case_only {
        // The destination is the source entry, so nothing can be replaced.
        rename_at(&src_dir, &src_name, &dst_dir, new_name, 0)
    } else {
        rename_noreplace(&src_dir, &src_name, &dst_dir, new_name)
    };
    match result {
        Ok(()) => Ok(rel),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            Err(format!("already exists: {}", rel))
        }
        Err(e) => Err(format!("cannot move {} to {}: {}", from_rel, rel, e)),
    }
}

/// True when `rel` is `scope` itself or lies inside that folder, as paths.
fn is_within(rel: &str, scope: &str) -> bool {
    rel == scope || rel.starts_with(&format!("{}/", scope))
}

/// `move_in` bounded to one place: the source and the destination parent
/// must name paths inside `scope` (a validated root-relative place folder),
/// and the destination must also resolve inside that folder, so a symlink
/// inside the place cannot carry the item into another place. Checked before
/// any filesystem mutation; a refusal changes nothing on disk.
fn move_in_scope(
    sub: &SubjectRoot,
    scope: &str,
    from_rel: &str,
    to_parent_rel: &str,
    new_name: &str,
) -> Result<String, String> {
    validate_scope_prefix(scope)?;
    let outside = |rel: &str| format!("path is outside the scope {}: {}", scope, rel);
    if !is_within(from_rel, scope) {
        return Err(outside(from_rel));
    }
    if !is_within(to_parent_rel, scope) {
        return Err(outside(to_parent_rel));
    }
    let scope_canon = sub.canonical_rel(scope)?;
    let dst_canon = sub.canonical_rel(to_parent_rel)?;
    if scope_canon.as_os_str().is_empty() || !dst_canon.starts_with(&scope_canon) {
        return Err(outside(to_parent_rel));
    }
    move_in(sub, from_rel, to_parent_rel, new_name)
}

/// Open the current user's Trash folder as a handle. It must exist, be a
/// folder and be owned by the current user.
fn open_trash_dir(home: &Path) -> Result<Dir, String> {
    let path = home.join(".Trash");
    let dir = Dir::open_ambient_dir(&path, ambient_authority())
        .map_err(|e| format!("cannot open the Trash at {}: {}", path.display(), e))?;
    let meta = dir
        .dir_metadata()
        .map_err(|e| format!("cannot open the Trash at {}: {}", path.display(), e))?;
    // SAFETY: geteuid has no preconditions.
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(format!(
            "the Trash at {} is not owned by you",
            path.display()
        ));
    }
    Ok(dir)
}

/// Move the file, folder or symlink at `rel` into `trash`, the open Trash
/// folder. Nothing is ever permanently deleted here. A symlink goes to the
/// Trash as a link; its target is never touched.
///
/// The entry is renamed relative to its validated parent handle into the
/// Trash handle with a no-replace rename, so no pathname is resolved and
/// nothing in the Trash is overwritten; a name clash gets a numbered name.
/// Only entries on the same volume as the Trash can be moved this way; any
/// other location is refused rather than copied. Refuses the subject root
/// itself, paths outside the subject, and missing targets.
fn trash_in(sub: &SubjectRoot, rel: &str, trash: &Dir) -> Result<(), String> {
    if rel.is_empty() {
        return Err("cannot delete the subject folder".to_string());
    }
    let (dir, name) = sub.parent_of(rel)?;
    let meta = dir
        .symlink_metadata(&name)
        .map_err(|e| format!("cannot access {}: {}", rel, e))?;
    if !meta.is_file() && !meta.is_dir() && !meta.file_type().is_symlink() {
        return Err(format!("not a file or folder: {}", rel));
    }
    let trash_meta = trash
        .dir_metadata()
        .map_err(|e| format!("cannot move {} to Trash: {}", rel, e))?;
    if trash_meta.dev() != meta.dev() {
        return Err(format!(
            "{} is on a different volume than the Trash; alabs only moves items to the Trash on the same volume",
            rel
        ));
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{}", ext)),
        _ => (name.as_str(), String::new()),
    };
    let mut attempt = 1u32;
    loop {
        let candidate = if attempt == 1 {
            name.clone()
        } else {
            format!("{} {}{}", stem, attempt, ext)
        };
        match rename_noreplace(&dir, &name, trash, &candidate) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && attempt < 1000 => attempt += 1,
            Err(e) => return Err(format!("cannot move {} to Trash: {}", rel, e)),
        }
    }
}

/// Most results a single search reports before it stops.
const MAX_SEARCH_RESULTS: usize = 1000;
/// Longest matched line (in characters) sent to the frontend.
const MAX_LINE_CHARS: usize = 200;

/// One search hit. A filename hit has no line; a content hit carries the
/// 1-based line number and the (trimmed) line text.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
struct SearchResult {
    name: String,
    /// Path relative to the subject root, using "/" separators.
    rel_path: String,
    line: Option<u64>,
    text: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
struct SearchSummary {
    /// Files whose name or contents were examined.
    files: u64,
    results: u64,
    /// True when the search stopped at `MAX_SEARCH_RESULTS`.
    truncated: bool,
    /// True when a newer search replaced this one before it finished.
    cancelled: bool,
}

/// Text of `name` in `dir` if it is a regular file (not a symlink) at or
/// under `MAX_FILE_BYTES`; the opened handle is checked to be that same
/// regular file. Used for ignore files, which must be subject-contained.
fn read_regular_text(dir: &Dir, name: &str) -> Option<String> {
    let entry = dir.symlink_metadata(name).ok()?;
    if !entry.is_file() {
        return None;
    }
    let (file, meta) = open_regular_file(dir, name).ok()?;
    if !same_inode(&entry, &meta) {
        return None;
    }
    let bytes = read_bytes_bounded(&file, meta.len()).ok()??;
    String::from_utf8(bytes).ok()
}

fn build_ignore(root_rel: &str, text: &str) -> Option<Gitignore> {
    let mut builder = GitignoreBuilder::new(root_rel);
    for line in text.lines() {
        // A malformed pattern is skipped, as git does.
        let _ = builder.add_line(None, line);
    }
    builder.build().ok()
}

/// Ignore matchers for one folder, in precedence order: `.ignore`,
/// `.gitignore`, then `.git/info/exclude` when `.git` is a folder here. All
/// are read through the folder handle and only as regular files inside the
/// subject; a symlinked ignore file is never loaded.
fn load_ignores(dir: &Dir, rel: &str) -> Vec<Gitignore> {
    let mut matchers = Vec::new();
    for name in [".ignore", ".gitignore"] {
        if let Some(text) = read_regular_text(dir, name) {
            matchers.extend(build_ignore(rel, &text));
        }
    }
    if let Ok(info) = dir.open_dir(".git").and_then(|git| git.open_dir("info")) {
        if let Some(text) = read_regular_text(&info, "exclude") {
            matchers.extend(build_ignore(rel, &text));
        }
    }
    matchers
}

/// Whether `rel` is ignored, checking the deepest folder's rules first; the
/// first rule that matches decides, as in git.
fn is_ignored(stack: &[Vec<Gitignore>], rel: &str, is_dir: bool) -> bool {
    for level in stack.iter().rev() {
        for matcher in level {
            match matcher.matched(rel, is_dir) {
                Match::None => continue,
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
            }
        }
    }
    false
}

struct SearchWalk<'a> {
    needle: String,
    cancelled: &'a dyn Fn() -> bool,
    sink: &'a mut dyn FnMut(SearchResult),
    summary: SearchSummary,
    stack: Vec<Vec<Gitignore>>,
}

impl SearchWalk<'_> {
    /// Report one hit. False when the search must stop.
    fn emit(&mut self, result: SearchResult) -> bool {
        (self.sink)(result);
        self.summary.results += 1;
        if self.summary.results as usize >= MAX_SEARCH_RESULTS {
            self.summary.truncated = true;
            return false;
        }
        true
    }

    /// Walk one folder through its handle. False when the search must stop.
    fn walk(&mut self, dir: &Dir, rel: &str) -> bool {
        let mut entries: Vec<(String, cap_std::fs::FileType)> = match dir.entries() {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    Some((
                        e.file_name().to_string_lossy().into_owned(),
                        e.file_type().ok()?,
                    ))
                })
                .collect(),
            Err(_) => return true,
        };
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        self.stack.push(load_ignores(dir, rel));
        let keep_going = self.walk_entries(dir, rel, entries);
        self.stack.pop();
        keep_going
    }

    fn walk_entries(
        &mut self,
        dir: &Dir,
        rel: &str,
        entries: Vec<(String, cap_std::fs::FileType)>,
    ) -> bool {
        for (name, file_type) in entries {
            if (self.cancelled)() {
                self.summary.cancelled = true;
                return false;
            }
            if name == ".git" {
                continue;
            }
            let child_rel = rel_join(rel, &name);
            if file_type.is_dir() {
                if is_ignored(&self.stack, &child_rel, true) {
                    continue;
                }
                // The entry was a folder when listed; the opened handle must
                // be that same folder, or it is skipped.
                let Ok(entry) = dir.symlink_metadata(&name) else {
                    continue;
                };
                let Ok(child) = dir.open_dir(&name) else {
                    continue;
                };
                let Ok(child_meta) = child.dir_metadata() else {
                    continue;
                };
                if !entry.is_dir() || !same_inode(&entry, &child_meta) {
                    continue;
                }
                if !self.walk(&child, &child_rel) {
                    return false;
                }
            } else if file_type.is_file() {
                if is_ignored(&self.stack, &child_rel, false) {
                    continue;
                }
                if !self.search_file(dir, &name, &child_rel) {
                    return false;
                }
            }
            // Symlinks and special files are never followed or read.
        }
        true
    }

    /// Examine one regular file through its parent handle.
    fn search_file(&mut self, dir: &Dir, name: &str, rel: &str) -> bool {
        let Ok(entry) = dir.symlink_metadata(name) else {
            return true;
        };
        let Ok((file, meta)) = open_regular_file(dir, name) else {
            return true;
        };
        if !entry.is_file() || !same_inode(&entry, &meta) {
            return true;
        }
        self.summary.files += 1;
        if name.to_lowercase().contains(&self.needle) {
            let hit = SearchResult {
                name: name.to_string(),
                rel_path: rel.to_string(),
                line: None,
                text: None,
            };
            if !self.emit(hit) {
                return false;
            }
        }
        let bytes = match read_bytes_bounded(&file, meta.len()) {
            Ok(Some(bytes)) => bytes,
            // Oversized or unreadable: the name was checked, the content is skipped.
            _ => return true,
        };
        if bytes.contains(&0) {
            return true;
        }
        let Ok(content) = std::str::from_utf8(&bytes) else {
            return true;
        };
        for (index, line) in content.lines().enumerate() {
            if !line.to_lowercase().contains(&self.needle) {
                continue;
            }
            let hit = SearchResult {
                name: name.to_string(),
                rel_path: rel.to_string(),
                line: Some(index as u64 + 1),
                text: Some(line.trim().chars().take(MAX_LINE_CHARS).collect()),
            };
            if !self.emit(hit) {
                return false;
            }
        }
        true
    }
}

/// Search filenames and text contents of the folder `dir` (whose
/// root-relative path is `rel`) for `query`, a case-insensitive literal.
/// Results are handed to `sink` as they are found, with root-relative paths.
///
/// Walks through directory handles only, never follows symlinks, honours
/// `.gitignore`, `.ignore` and `.git/info/exclude` files that are regular
/// files inside the walked folder, never reads ignore files from above it or
/// the user's global gitignore, and always skips `.git` folders. Contents are
/// read only for regular files at or under `MAX_FILE_BYTES` (a hard read
/// bound); files containing a NUL byte or invalid UTF-8 are skipped as
/// binary. Nothing is cached between calls. `cancelled` is polled per entry
/// and stops the walk early.
fn search_walk(
    dir: &Dir,
    rel: &str,
    query: &str,
    cancelled: &dyn Fn() -> bool,
    sink: &mut dyn FnMut(SearchResult),
) -> SearchSummary {
    let summary = SearchSummary {
        files: 0,
        results: 0,
        truncated: false,
        cancelled: false,
    };
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return summary;
    }
    let mut walk = SearchWalk {
        needle,
        cancelled,
        sink,
        summary,
        stack: Vec::new(),
    };
    walk.walk(dir, rel);
    walk.summary
}

/// A scope prefix names one folder inside the root by its root-relative
/// path: non-empty, no leading or trailing slash, no empty, `.` or `..`
/// component. The root itself ("") is never a scope: a search or listing
/// bound to a scope can never widen to the whole root.
fn validate_scope_prefix(prefix: &str) -> Result<(), String> {
    if prefix.is_empty() {
        return Err("scope is empty".to_string());
    }
    if prefix.contains('\0') || prefix.contains('\\') {
        return Err(format!("invalid scope: {}", prefix));
    }
    if prefix.starts_with('/') || prefix.ends_with('/') {
        return Err(format!("invalid scope: {}", prefix));
    }
    for part in prefix.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("invalid scope: {}", prefix));
        }
    }
    Ok(())
}

/// Open the scope folder at `prefix` through the root handle. The entry must
/// be a real folder (a symlink to one is refused, as it is not a place) and
/// the opened handle must be that same folder.
fn open_scope_dir(sub: &SubjectRoot, prefix: &str) -> Result<Dir, String> {
    validate_scope_prefix(prefix)?;
    let (parent, name) = sub.parent_of(prefix)?;
    let entry = parent
        .symlink_metadata(&name)
        .map_err(|e| access_err(prefix, e))?;
    if !entry.is_dir() {
        return Err(format!("not a folder: {}", prefix));
    }
    let dir = parent.open_dir(&name).map_err(|e| dir_err(prefix, e))?;
    let meta = dir.dir_metadata().map_err(|e| access_err(prefix, e))?;
    if !same_inode(&entry, &meta) {
        return Err(format!("not a folder: {}", prefix));
    }
    Ok(dir)
}

/// Search one scope inside the root; see `search_walk`. The prefix is
/// validated and opened through the root handle, so the walk can never leave
/// the scope folder, and paths above it (sibling places, the root) are never
/// listed or read.
fn search_in(
    sub: &SubjectRoot,
    prefix: &str,
    query: &str,
    cancelled: &dyn Fn() -> bool,
    sink: &mut dyn FnMut(SearchResult),
) -> Result<SearchSummary, String> {
    let dir = open_scope_dir(sub, prefix)?;
    Ok(search_walk(&dir, prefix, query, cancelled, sink))
}

/// Search ids handed out by the frontend start at 1, so this value never
/// matches a running search: storing it stops every search at its next entry.
const NO_SEARCH: u64 = 0;

impl Subject {
    fn replace_root(&self, root: SubjectRoot) -> Result<(), String> {
        let mut active = self.root.lock().map_err(|e| e.to_string())?;
        self.cancel_searches();
        if let Ok(mut formats) = self.git_formats.lock() {
            formats.clear();
        }
        self.root_session.fetch_add(1, Ordering::SeqCst);
        *active = Some(root);
        Ok(())
    }

    /// Stop any running search. Called when the subject changes and when the
    /// user clears a search, so no walk outlives the action that started it.
    fn cancel_searches(&self) {
        self.latest_search.store(NO_SEARCH, Ordering::SeqCst);
    }

    fn cancel_search(&self, search_id: u64) {
        let _ = self.latest_search.compare_exchange(
            search_id,
            NO_SEARCH,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }

    fn search_is_current(&self, search_id: u64) -> bool {
        self.latest_search.load(Ordering::SeqCst) == search_id
    }
}

/// Run a root-bound operation while holding the root transition lock. For
/// evidence reads we only clone the handle here; a pair write keeps this
/// lock through its commit so it cannot race a root replacement.
fn with_root_session<T>(
    subject: &Subject,
    expected: Option<u64>,
    operation: impl FnOnce(&SubjectRoot) -> Result<T, String>,
) -> Result<T, String> {
    let root = subject.root.lock().map_err(|e| e.to_string())?;
    if expected.is_some_and(|id| id != subject.root_session.load(Ordering::SeqCst)) {
        return Err("the alabs root changed while the view was being built".to_string());
    }
    operation(
        root.as_ref()
            .ok_or_else(|| "no subject is open".to_string())?,
    )
}

/// A duplicated handle to the active subject, or an error when none is open.
fn current_root(subject: &Subject) -> Result<SubjectRoot, String> {
    subject
        .root
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .ok_or_else(|| "no subject is open".to_string())?
        .try_clone()
}

/// The canonical form of `path` even when it does not exist yet: the longest
/// existing ancestor is canonicalized and the remaining components appended.
fn canonical_projection(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut rest = Vec::new();
    loop {
        if let Ok(canon) = existing.canonicalize() {
            let mut out = canon;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_owned());
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// The one overlap rule: the active subject and alabs application storage
/// never overlap. Rejects a subject that is the app-data folder, contains it,
/// or lies inside it. Both paths must be canonical.
fn state_dir_conflict(subject: &Path, state_dir: &Path) -> Option<String> {
    if subject == state_dir || state_dir.starts_with(subject) || subject.starts_with(state_dir) {
        Some(format!(
            "cannot open {}: it overlaps the alabs application data folder ({})",
            subject.display(),
            state_dir.display()
        ))
    } else {
        None
    }
}

/// List one directory level inside the subject: folders first, then files,
/// each group sorted case-insensitively. Symlinks are listed by their own
/// type, never followed.
fn list_entries(sub: &SubjectRoot, rel: &str) -> Result<Vec<Entry>, String> {
    let dir = sub.open_dir(rel)?;
    let mut entries = Vec::new();
    for item in dir
        .entries()
        .map_err(|e| format!("cannot read {}: {}", rel, e))?
    {
        // One unreadable entry must not hide the rest of the folder.
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(Entry {
            rel_path: rel_join(rel, &name),
            name,
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// What exists at a root-relative path: a regular file, a folder, or
/// nothing usable. Relative symlinks inside the root are followed; a path
/// that leaves the root is refused with an error, never reported as absent.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    File,
    Dir,
    None,
}

fn entry_kind_in(sub: &SubjectRoot, rel: &str) -> Result<EntryKind, String> {
    if rel.is_empty() {
        return Err("path is empty".to_string());
    }
    match sub.dir.metadata(rel) {
        Ok(meta) if meta.is_file() => Ok(EntryKind::File),
        Ok(meta) if meta.is_dir() => Ok(EntryKind::Dir),
        Ok(_) => Ok(EntryKind::None),
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(EntryKind::None)
        }
        Err(e) => Err(access_err(rel, e)),
    }
}

/// Largest disposable UI state file (in bytes) alabs will write or read.
const MAX_STATE_BYTES: u64 = 1024 * 1024;

/// Name of the disposable UI state file inside the app data directory.
const STATE_FILE: &str = "ui-state.json";

/// Read the disposable UI state stored under `dir`. `Ok(None)` means only
/// that no state file exists (a silent fresh start). Anything else unusable
/// (not a file, oversized, unreadable) is a named error: the frontend still
/// starts fresh, but says so and records the reason. This touches only the
/// app data directory, never the root.
fn load_state_in(dir: &Path) -> Result<Option<String>, String> {
    let path = dir.join(STATE_FILE);
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read ui state: {}", e)),
    };
    if !meta.is_file() {
        return Err("cannot read ui state: not a file".to_string());
    }
    if meta.len() > MAX_STATE_BYTES {
        return Err(format!(
            "cannot read ui state: larger than {} MB",
            MAX_STATE_BYTES / (1024 * 1024)
        ));
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("cannot read ui state: {}", e))
}

/// Replace the disposable UI state under `dir` atomically: the text is
/// written to a sibling temp file and renamed over the old one, so a crash
/// leaves either the previous state or the new one, never a partial file.
fn save_state_in(dir: &Path, text: &str) -> Result<(), String> {
    if text.len() as u64 > MAX_STATE_BYTES {
        return Err("ui state too large".to_string());
    }
    fs::create_dir_all(dir).map_err(|e| format!("cannot create app data dir: {}", e))?;
    let path = dir.join(STATE_FILE);
    let tmp = dir.join(format!("{}.{}.tmp", STATE_FILE, std::process::id()));
    let mut file = fs::File::create(&tmp).map_err(|e| format!("cannot write ui state: {}", e))?;
    let written = file
        .write_all(text.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("cannot write ui state: {}", e));
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("cannot write ui state: {}", e)
    })
}

/// Largest `alabs.log` (in bytes) before it is rotated once.
const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// Longest single log line (in characters); longer text is cut.
const MAX_LOG_LINE_CHARS: usize = 2048;
const LOG_FILE: &str = "alabs.log";
const LOG_BACKUP: &str = "alabs.log.1";

/// Append one line to the bounded local log under `dir`. When the line would
/// take the file past `MAX_LOG_BYTES`, the file is renamed to the single
/// backup name first, replacing any earlier backup, so at most two files
/// ever exist. Control characters are dropped so one call is one line. The
/// frontend never waits on this and a failure here changes nothing else.
fn append_log_in(dir: &Path, line: &str) -> Result<(), String> {
    let mut text: String = line
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_LOG_LINE_CHARS)
        .collect();
    text.push('\n');
    fs::create_dir_all(dir).map_err(|e| format!("cannot create app data dir: {}", e))?;
    let path = dir.join(LOG_FILE);
    let current = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if current + text.len() as u64 > MAX_LOG_BYTES {
        fs::rename(&path, dir.join(LOG_BACKUP)).map_err(|e| format!("cannot rotate log: {}", e))?;
    }
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .map_err(|e| format!("cannot write log: {}", e))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("cannot write log: {}", e))
}

/// Disk-backed recovery records for the browser runtime. Part of the browser
/// front door: the desktop application keeps no drafts of its own.
#[cfg(feature = "serve")]
mod recovery;

/// The browser front door: the local server that serves alabs to Chrome.
/// Builds and runs without Tauri.
#[cfg(feature = "serve")]
mod serve;
#[cfg(feature = "serve")]
pub use serve::serve_main;

/// The desktop front door: the Tauri commands, menu and application run
/// loop. Everything above is the shared core, which builds without Tauri.
#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
pub use desktop::run;

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
