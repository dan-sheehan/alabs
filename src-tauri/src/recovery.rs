//! Disk-backed recovery records for the browser runtime.
//!
//! The browser keeps an editor draft in IndexedDB the instant it is typed,
//! because that is the storage it can reach without leaving the page. That is
//! not the durable guarantee: clearing browser data, a new profile, or a
//! machine that never comes back to that profile would take it. So an
//! acknowledged draft is also an ordinary file here, under the browser
//! runtime's own state folder, where Finder and Terminal can reach it and
//! where clearing browser data cannot.
//!
//! What this module owns:
//!
//!   * one record per (root, path), named deterministically, carrying its own
//!     root and path so a name collision refuses instead of mixing two drafts;
//!   * restrictive permissions — 0700 on the folder, 0600 on every record —
//!     because a draft is the user's unsaved work, not shared state;
//!   * atomic replacement, so a record is either the previous revision or the
//!     new one and never a half-written file;
//!   * revisions that only ever move forward, so a late write cannot put an
//!     older draft back;
//!   * a size budget that **refuses** rather than evicting. Deleting somebody's
//!     unsaved work to make room for other unsaved work is not a recovery
//!     system. A refusal is visible and leaves the live text in the editor.
//!
//! Nothing here reads or writes inside the alabs root. Recovery is alabs'
//! own state, kept beside the disposable layout but never mixed with it: the
//! layout may be thrown away at any time, and these may not.

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::FileStamp;

/// The recovery folder inside the browser runtime's state folder. A folder of
/// its own, so "forget the layout" can never mean "forget the drafts".
const FOLDER: &str = "recovery";

/// Suffix of a record. Anything else in the folder is left alone.
const SUFFIX: &str = ".json";

/// Largest draft kept. The editor will not open a file past this, so a draft
/// of one cannot exceed it either.
const MAX_CONTENTS_BYTES: usize = 2 * 1024 * 1024;

/// Most the recovery folder may hold. Reaching it refuses the write, names
/// the reason, and removes nothing: the live text stays in the editor and the
/// user is told, rather than one draft being deleted to store another.
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

/// Format of the records this version writes. A record from a later version
/// is reported as unreadable rather than guessed at.
const FORMAT: u32 = 1;

// One server process owns recovery. Serialize the whole read/check/replace
// (and read/check/remove), including its temporary file, across HTTP workers.
// A request timeout cannot release this lock while its disk task still runs.
static RECORDS: Mutex<()> = Mutex::new(());

/// One editor draft as it is kept on disk.
///
/// Everything needed to reason about it later without the page that wrote it:
/// which root and path it belongs to, what the file looked like when the
/// buffer was last in step with the disk (`stamp`, absent when the file was
/// already gone), which revision of the draft this is, and which server
/// lifetime and editing session produced it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Draft {
    /// Record format. Written as `FORMAT`; anything else is not read.
    pub(crate) version: u32,
    /// Canonical absolute path of the alabs root this draft belongs to.
    pub(crate) root: String,
    /// Path of the file inside that root.
    pub(crate) rel_path: String,
    /// The file's stamp when the buffer was last in step with the disk; null
    /// when the file did not exist then.
    pub(crate) stamp: Option<FileStamp>,
    /// Only ever increases for one (root, path).
    pub(crate) revision: u64,
    /// The `alabs-serve` lifetime that stored it.
    pub(crate) server_id: String,
    /// The editing session (one browser tab) that typed it.
    pub(crate) session_id: String,
    /// Milliseconds since the epoch, for showing the user how old a draft is.
    pub(crate) updated_at: u64,
    pub(crate) contents: String,
}

/// What one listing found: the drafts for the root that was asked about, and
/// the names of any records that could not be read. Unreadable records are
/// reported rather than skipped, because a recovery file alabs cannot parse
/// is exactly the thing the user needs to be told about.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listing {
    pub(crate) drafts: Vec<Draft>,
    pub(crate) unreadable: Vec<String>,
}

/// The recovery folder under one state folder.
pub(crate) fn dir_in(state_dir: &Path) -> PathBuf {
    state_dir.join(FOLDER)
}

/// 64-bit FNV-1a with a chosen offset basis. Two runs with different bases
/// give the 128 bits `record_name` needs.
fn fnv1a(bytes: &[u8], basis: u64) -> u64 {
    let mut hash = basis;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The record name for one (root, path).
///
/// Deterministic, so the same draft always lands on the same record and an
/// update replaces it rather than accumulating. Hashed rather than encoded
/// because a root path plus a file path easily exceeds what a filename may
/// hold. The record carries the root and path in full and every read checks
/// them, so the hash is an index and never the authority.
fn record_name(root: &str, rel_path: &str) -> String {
    let key = format!("{}\u{0}{}", root, rel_path);
    let bytes = key.as_bytes();
    format!(
        "{:016x}{:016x}{}",
        fnv1a(bytes, 0xcbf2_9ce4_8422_2325),
        fnv1a(bytes, 0x9ae1_6a3b_2f90_404f),
        SUFFIX
    )
}

/// Create the recovery folder if it is not there, reachable only by its owner.
///
/// The mode is set once, when alabs creates it, rather than on every write:
/// afterwards the folder is the user's, and a folder they have deliberately
/// made unwritable must stay that way so the refusal is real. Every record in
/// it is written 0600 regardless, which is what actually keeps a draft
/// private.
fn ensure_dir(dir: &Path) -> Result<(), String> {
    if dir.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dir).map_err(|e| format!("cannot create the recovery folder: {}", e))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("cannot secure the recovery folder: {}", e))
}

/// Read one record. `Ok(None)` means there is nothing at that name; an
/// unreadable or foreign-format record is an error naming why.
fn read_record(path: &Path) -> Result<Option<Draft>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read a recovery file: {}", e)),
    };
    let draft: Draft =
        serde_json::from_str(&text).map_err(|_| "a recovery file is unreadable".to_string())?;
    if draft.version != FORMAT {
        return Err("a recovery file was written by a later version".to_string());
    }
    Ok(Some(draft))
}

/// Total size of the records in `dir`, ignoring anything that is not one.
fn folder_bytes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(SUFFIX))
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

/// Milliseconds since the epoch, or 0 on a clock before it.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Store one revision of one draft, replacing the record atomically.
///
/// Refused, without touching what is stored, when:
///
///   * the contents are larger than the editor would ever open;
///   * a record already there belongs to a different root or path (a hash
///     collision: two drafts are never merged into one record);
///   * a record already there holds a **newer** revision. An equal revision is
///     allowed, so a caller that is unsure whether its last write landed may
///     write it again;
///   * the folder is at its budget. Nothing is deleted to make room.
///
/// Returns the revision now stored.
pub(crate) fn put(dir: &Path, draft: &Draft) -> Result<u64, String> {
    let _records = RECORDS
        .lock()
        .map_err(|_| "recovery storage lock failed".to_string())?;
    if draft.contents.len() > MAX_CONTENTS_BYTES {
        return Err(format!(
            "this draft is larger than {} MB and cannot be kept",
            MAX_CONTENTS_BYTES / (1024 * 1024)
        ));
    }
    ensure_dir(dir)?;
    let name = record_name(&draft.root, &draft.rel_path);
    let path = dir.join(&name);
    let existing = read_record(&path)?;
    let existing_len = if let Some(old) = &existing {
        if old.root != draft.root || old.rel_path != draft.rel_path {
            return Err("another draft is already stored under that name".to_string());
        }
        if old.revision > draft.revision {
            return Err(format!(
                "a newer draft of {} is already kept",
                draft.rel_path
            ));
        }
        fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let text = serde_json::to_string(&Draft {
        version: FORMAT,
        updated_at: if draft.updated_at == 0 {
            now_ms()
        } else {
            draft.updated_at
        },
        ..draft.clone()
    })
    .map_err(|e| format!("cannot write a recovery file: {}", e))?;

    // The budget counts what the folder would hold afterwards: this record
    // replaces its own previous size rather than adding to it.
    let total = folder_bytes(dir);
    let after = total - existing_len.min(total) + text.len() as u64;
    if after > MAX_TOTAL_BYTES {
        return Err(format!(
            "alabs keeps at most {} MB of recovery drafts and is full. \
             Save or discard some drafts; nothing was deleted to make room.",
            MAX_TOTAL_BYTES / (1024 * 1024)
        ));
    }

    write_atomically(dir, &name, &text)?;
    Ok(draft.revision)
}

/// Write `text` as `name` in `dir`: a 0600 sibling, synced, then renamed over
/// the record. A crash leaves the previous revision or the new one.
fn write_atomically(dir: &Path, name: &str, text: &str) -> Result<(), String> {
    let tmp = dir.join(format!(".{}.{}.tmp", name, std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("cannot write a recovery file: {}", e))?;
    let written = file
        .write_all(text.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("cannot write a recovery file: {}", e));
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, dir.join(name)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("cannot write a recovery file: {}", e)
    })
}

/// Every draft kept for `root`, newest first, plus the names of records that
/// could not be read. Drafts belonging to other roots are left untouched and
/// are not returned: one server owns one root.
pub(crate) fn list(dir: &Path, root: &str) -> Result<Listing, String> {
    let mut listing = Listing::default();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(listing),
        Err(e) => return Err(format!("cannot read the recovery folder: {}", e)),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(SUFFIX) || name.starts_with('.') {
            continue;
        }
        match read_record(&entry.path()) {
            Ok(Some(draft)) if draft.root == root => listing.drafts.push(draft),
            Ok(_) => {}
            Err(_) => listing.unreadable.push(name),
        }
    }
    listing
        .drafts
        .sort_by_key(|d| std::cmp::Reverse(d.updated_at));
    listing.unreadable.sort();
    Ok(listing)
}

/// Remove the record for one draft, but only when it is the one the caller
/// means and only up to the revision it has finished with.
///
/// A record holding a **newer** revision than `revision` is kept: the caller
/// confirmed an older save, and the newer text has not been dealt with.
/// Returns true when a record was removed.
pub(crate) fn drop_draft(
    dir: &Path,
    root: &str,
    rel_path: &str,
    revision: u64,
) -> Result<bool, String> {
    let _records = RECORDS
        .lock()
        .map_err(|_| "recovery storage lock failed".to_string())?;
    let path = dir.join(record_name(root, rel_path));
    let Some(existing) = read_record(&path)? else {
        return Ok(false);
    };
    if existing.root != root || existing.rel_path != rel_path {
        return Ok(false);
    }
    if existing.revision > revision {
        return Err(format!(
            "{} has been edited since that version; its draft was kept",
            rel_path
        ));
    }
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("cannot remove a recovery file: {}", e)),
    }
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;
