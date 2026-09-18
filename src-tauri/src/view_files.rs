//! The filesystem side of built Visual Views (post-Stage-1 feature, Raven):
//! a bounded inventory of one work place for the evidence packet, and the
//! safe write of the two generated files, `views/<place>/view.json` and
//! `views/<place>/map.svg`. Everything goes through the one root handle;
//! nothing here runs, installs or starts anything in the place, and nothing
//! here talks to a model.
//!
//! ```text
//! collect_inventory(root, place)
//!   walk:  breadth first from the place folder, alphabetical per folder,
//!          folders and files, sizes; symlinks and ignored folders skipped
//!   bound: MAX_INVENTORY_ENTRIES listed, MAX_WALK_ENTRIES visited, MAX_DEPTH
//!   out:   entries (place-relative paths), counts, truncated flag
//!
//! write_view_files(root, place, expected_root, view_json, map_svg, replace)
//!   pre:   place is a real folder in the root (never `views`, never hidden);
//!          the root is still the one the build started in; both texts fit
//!   dirs:  `views/` and `views/<place>/` created when missing, never
//!          through a link
//!   write: both files staged as 0600 temporaries, then map.svg renamed into
//!          place (`replace` false refuses an existing map; a Raven run passes true),
//!          then view.json (always replace: alabs owns it). A map that is
//!          replaced is parked at the temporary name (one `RENAME_SWAP`) until
//!          view.json is in place; a failed view.json rename swaps it back
//!          and the old pair stays as it was
//!
//! write_root_view_files(root, expected_root, view_json, map_svg, replace)
//!   the same write into the reserved `views/.root/` (the Home map): a dot
//!   name, never a work place, so it can collide with no place's view folder
//! ```
//!
//! A no-replace write can therefore never overwrite a map that appeared
//! meanwhile, a Raven run replaces the old map only after the new content is
//! fully on disk, and a replacement that fails at either rename leaves the
//! pair that was there (a crash between the two renames is not covered).

use std::collections::VecDeque;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;

use cap_std::fs::{Dir, Permissions};
use serde::Serialize;

use super::{
    access_err, default_file_mode, dir_err, open_scope_dir, remove_if_same, rename_noreplace,
    rename_swap, same_inode, stage_temp, temp_name, validate_name, SubjectRoot, MAX_FILE_BYTES,
};

/// Folder names never walked: dependency stores, build output, caches,
/// virtual environments and version-control storage. Matched by exact
/// name, case-insensitively, at any depth.
pub const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    "coverage",
    "cache",
    ".cache",
    ".next",
    ".nuxt",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".gradle",
    ".terraform",
    "deriveddata",
    "pods",
    "vendor",
    "bower_components",
    "site-packages",
];

/// File names never listed: Finder and editor droppings.
pub const IGNORED_FILES: &[&str] = &[".ds_store", "thumbs.db", "desktop.ini"];

/// Most entries (files and folders) the inventory lists. Breadth first, so
/// the top of the place is always present and deep leaves are what is cut.
pub const MAX_INVENTORY_ENTRIES: usize = 300;
/// Most entries the walk visits at all, listed or not, so a huge place costs
/// a bounded amount of work.
pub const MAX_WALK_ENTRIES: usize = 5000;
/// Deepest folder level walked (the place itself is level 0).
pub const MAX_DEPTH: usize = 8;
/// Bound on `view.json`.
pub const MAX_VIEW_JSON_BYTES: usize = 1024 * 1024;
/// Bound on `map.svg`: what `read_file` will read back.
pub const MAX_MAP_SVG_BYTES: usize = MAX_FILE_BYTES as usize;

/// The views folder and the two generated file names, as `places.ts` knows them.
pub const VIEWS_FOLDER: &str = "views";
/// The reserved child of `views/` that holds the root Visual View (`places.ts` `ROOT_VIEW_DIR`).
pub const ROOT_VIEW_DIR: &str = ".root";
pub const VIEW_JSON: &str = "view.json";
pub const MAP_SVG: &str = "map.svg";

/// One inventory entry: a place-relative path (`/` separators, no leading
/// `./`), whether it is a folder, and a file's size in bytes (0 for folders).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InventoryEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// The bounded inventory of one place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Inventory {
    pub entries: Vec<InventoryEntry>,
    /// True when the listing stopped at a bound; `files` and `folders` then
    /// count what was visited, not what exists.
    pub truncated: bool,
    pub files: usize,
    pub folders: usize,
}

fn is_ignored_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    IGNORED_DIRS.contains(&lower.as_str()) || lower.ends_with(".egg-info")
}

fn is_ignored_file(name: &str) -> bool {
    IGNORED_FILES.contains(&name.to_ascii_lowercase().as_str())
}

/// Walk `place` breadth first through the root handle. Symlinks are never
/// followed or listed (the entry's own type decides), ignored folders are
/// never entered, and the three bounds above cap the work.
pub fn collect_inventory(root: &SubjectRoot, place: &str) -> Result<Inventory, String> {
    validate_place(place)?;
    let dir = open_scope_dir(root, place)?;
    let mut inventory = Inventory {
        entries: Vec::new(),
        truncated: false,
        files: 0,
        folders: 0,
    };
    let mut queue: VecDeque<(Dir, String, usize)> = VecDeque::new();
    queue.push_back((dir, String::new(), 0));
    let mut visited = 0usize;
    while let Some((dir, rel, depth)) = queue.pop_front() {
        let mut names: Vec<(String, bool)> = Vec::new();
        let entries = match dir.entries() {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for item in entries {
            let Ok(item) = item else { continue };
            let Ok(kind) = item.file_type() else { continue };
            let name = item.file_name().to_string_lossy().into_owned();
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if is_ignored_dir(&name) {
                    continue;
                }
                names.push((name, true));
            } else if kind.is_file() {
                if is_ignored_file(&name) {
                    continue;
                }
                names.push((name, false));
            }
        }
        names.sort_by(|a, b| {
            a.0.to_lowercase()
                .cmp(&b.0.to_lowercase())
                .then_with(|| a.0.cmp(&b.0))
        });
        for (name, is_dir) in names {
            visited += 1;
            if visited > MAX_WALK_ENTRIES {
                inventory.truncated = true;
                return Ok(inventory);
            }
            let path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel, name)
            };
            if is_dir {
                inventory.folders += 1;
            } else {
                inventory.files += 1;
            }
            if inventory.entries.len() < MAX_INVENTORY_ENTRIES {
                let size = if is_dir {
                    0
                } else {
                    dir.metadata(&name).map(|m| m.len()).unwrap_or(0)
                };
                inventory.entries.push(InventoryEntry {
                    path: path.clone(),
                    is_dir,
                    size,
                });
            } else {
                inventory.truncated = true;
            }
            if is_dir && depth < MAX_DEPTH {
                if let Ok(child) = dir.open_dir(&name) {
                    queue.push_back((child, path, depth + 1));
                }
            } else if is_dir {
                inventory.truncated = true;
            }
        }
    }
    Ok(inventory)
}

/// A place name for these commands: one plain component that `places.ts`
/// could have listed as a work place (never `views`, never hidden).
fn validate_place(place: &str) -> Result<(), String> {
    validate_name(place)?;
    if place.starts_with('.') || place.eq_ignore_ascii_case(VIEWS_FOLDER) {
        return Err(format!("not a work place: {}", place));
    }
    Ok(())
}

/// Open `name` inside `parent` as a real folder, creating it when absent.
/// A link at that name is refused: generated files never follow a link out
/// of `views/`.
fn open_or_create_dir(parent: &Dir, name: &str, rel: &str) -> Result<Dir, String> {
    match parent.symlink_metadata(name) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(format!("not a folder: {}", rel)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if let Err(e) = parent.create_dir(name) {
                if e.kind() != io::ErrorKind::AlreadyExists {
                    return Err(format!("cannot create {}: {}", rel, e));
                }
            }
        }
        Err(e) => return Err(access_err(rel, e)),
    }
    let entry = parent
        .symlink_metadata(name)
        .map_err(|e| access_err(rel, e))?;
    if !entry.is_dir() {
        return Err(format!("not a folder: {}", rel));
    }
    let dir = parent.open_dir(name).map_err(|e| dir_err(rel, e))?;
    let meta = dir.dir_metadata().map_err(|e| access_err(rel, e))?;
    if !same_inode(&entry, &meta) {
        return Err(format!("not a folder: {}", rel));
    }
    Ok(dir)
}

/// Write the two generated files for `place`; see the module notes.
/// `expected_root` is the root path the build started in: a different open
/// root refuses the write, so a build that outlived a root change lands
/// nowhere. With `replace` false an existing `map.svg` is never touched.
pub fn write_view_files(
    root: &SubjectRoot,
    place: &str,
    expected_root: &str,
    view_json: &str,
    map_svg: &str,
    replace: bool,
) -> Result<(), String> {
    validate_place(place)?;
    check_write(root, expected_root, view_json, map_svg)?;
    // The place must still be a real folder in the root.
    open_scope_dir(root, place)?;
    write_pair(root, place, view_json, map_svg, replace)
}

/// Write the root Visual View (the Home map) as `views/.root/view.json`
/// and `views/.root/map.svg`, with exactly the staging, the no-replace rule
/// and the replace-at-the-last-rename rule of `write_view_files`. `.root` is never a place, so nothing a
/// place owns is ever touched here.
pub fn write_root_view_files(
    root: &SubjectRoot,
    expected_root: &str,
    view_json: &str,
    map_svg: &str,
    replace: bool,
) -> Result<(), String> {
    check_write(root, expected_root, view_json, map_svg)?;
    write_pair(root, ROOT_VIEW_DIR, view_json, map_svg, replace)
}

/// The checks both writes make before touching the disk.
fn check_write(
    root: &SubjectRoot,
    expected_root: &str,
    view_json: &str,
    map_svg: &str,
) -> Result<(), String> {
    if root.path.to_string_lossy() != expected_root {
        return Err("the alabs root changed while the view was being built".to_string());
    }
    if view_json.len() > MAX_VIEW_JSON_BYTES || map_svg.len() > MAX_MAP_SVG_BYTES {
        return Err("generated view is too large".to_string());
    }
    Ok(())
}

/// Stage and place both files under `views/<name>/`; see the module notes.
fn write_pair(
    root: &SubjectRoot,
    name: &str,
    view_json: &str,
    map_svg: &str,
    replace: bool,
) -> Result<(), String> {
    let views = open_or_create_dir(&root.dir, VIEWS_FOLDER, VIEWS_FOLDER)?;
    let rel_dir = format!("{}/{}", VIEWS_FOLDER, name);
    let dir = open_or_create_dir(&views, name, &rel_dir)?;
    let rel_svg = format!("{}/{}", rel_dir, MAP_SVG);
    let rel_json = format!("{}/{}", rel_dir, VIEW_JSON);

    // Ordinary files for an ordinary reader: staged as 0600, then given the
    // mode a plain create would have produced.
    let mode = || {
        Some(Permissions::from_std(fs::Permissions::from_mode(
            default_file_mode(),
        )))
    };
    let tmp_svg = temp_name();
    let staged_svg = stage_temp(&dir, &tmp_svg, map_svg, mode(), &rel_svg)?;
    let svg_meta = staged_svg
        .metadata()
        .map_err(|e| format!("cannot access {}: {}", rel_svg, e))?;
    let tmp_json = temp_name();
    let staged_json = match stage_temp(&dir, &tmp_json, view_json, mode(), &rel_json) {
        Ok(file) => file,
        Err(e) => {
            let _ = remove_if_same(&dir, &tmp_svg, &svg_meta);
            return Err(e);
        }
    };
    let json_meta = staged_json
        .metadata()
        .map_err(|e| format!("cannot access {}: {}", rel_json, e))?;

    // The map is the file that makes a view exist, so it lands first. A map
    // it replaces is not dropped yet: the swap parks the old map at the
    // temporary name until view.json is in place, so a failed second rename
    // can put it back and the old pair survives intact.
    let old_map = if replace {
        dir.symlink_metadata(MAP_SVG)
            .ok()
            .filter(|meta| !meta.is_dir())
    } else {
        None
    };
    let placed = match &old_map {
        Some(_) => rename_swap(&dir, &tmp_svg, &dir, MAP_SVG),
        // Nothing to park: no map yet, or a folder the rename refuses.
        None if replace => dir.rename(&tmp_svg, &dir, MAP_SVG),
        None => rename_noreplace(&dir, &tmp_svg, &dir, MAP_SVG),
    };
    if let Err(e) = placed {
        let _ = remove_if_same(&dir, &tmp_svg, &svg_meta);
        let _ = remove_if_same(&dir, &tmp_json, &json_meta);
        return Err(if e.kind() == io::ErrorKind::AlreadyExists {
            format!("already exists: {}", rel_svg)
        } else {
            format!("cannot write {}: {}", rel_svg, e)
        });
    }
    if let Err(e) = dir.rename(&tmp_json, &dir, VIEW_JSON) {
        let _ = remove_if_same(&dir, &tmp_json, &json_meta);
        match &old_map {
            Some(old) => {
                // Swap back only while the map name still holds the staged
                // inode and the temporary name still holds the old map.
                let ours = matches!(dir.symlink_metadata(MAP_SVG), Ok(ref m) if same_inode(m, &svg_meta));
                let parked = matches!(dir.symlink_metadata(&tmp_svg), Ok(ref m) if same_inode(m, old));
                if ours && parked && rename_swap(&dir, &tmp_svg, &dir, MAP_SVG).is_ok() {
                    let _ = remove_if_same(&dir, &tmp_svg, &svg_meta);
                }
            }
            None => {
                let _ = remove_if_same(&dir, MAP_SVG, &svg_meta);
            }
        }
        return Err(format!("cannot write {}: {}", rel_json, e));
    }
    if let Some(old) = &old_map {
        let _ = remove_if_same(&dir, &tmp_svg, old);
    }
    Ok(())
}

#[cfg(test)]
#[path = "view_files_tests.rs"]
mod tests;
