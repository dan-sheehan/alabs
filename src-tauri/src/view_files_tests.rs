use super::*;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// A fresh alabs root under the system temp dir with one work place,
/// removed on drop.
struct TempRoot {
    base: PathBuf,
    root: SubjectRoot,
}

impl TempRoot {
    fn new() -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("alabs-view-{}-{}", std::process::id(), id));
        fs::create_dir_all(base.join("root/defiance")).unwrap();
        fs::create_dir_all(base.join("outside")).unwrap();
        let root = SubjectRoot::open(&base.join("root")).unwrap();
        Self { base, root }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.base.join("root").join(rel)
    }

    fn write(&self, rel: &str, text: &str) {
        let path = self.path(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn dir(&self, rel: &str) {
        fs::create_dir_all(self.path(rel)).unwrap();
    }

    fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.path(rel)).unwrap()
    }

    fn root_text(&self) -> String {
        self.root.path.to_string_lossy().into_owned()
    }

    fn names(&self, rel: &str) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.path(rel))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn paths(inv: &Inventory) -> Vec<String> {
    inv.entries.iter().map(|e| e.path.clone()).collect()
}

// --- inventory ---

#[test]
fn inventory_lists_breadth_first_alphabetical_with_sizes_and_place_relative_paths() {
    let t = TempRoot::new();
    t.write("defiance/README.md", "# hi");
    t.write("defiance/src/pkg/b.py", "bb");
    t.write("defiance/src/pkg/a.py", "a");
    t.write("defiance/src/main.py", "main");
    t.write("defiance/Zed.txt", "z");
    let inv = collect_inventory(&t.root, "defiance").unwrap();
    assert_eq!(
        paths(&inv),
        vec![
            "README.md",
            "src",
            "Zed.txt",
            "src/main.py",
            "src/pkg",
            "src/pkg/a.py",
            "src/pkg/b.py"
        ]
    );
    assert_eq!(
        inv.entries[0],
        InventoryEntry {
            path: "README.md".into(),
            is_dir: false,
            size: 4
        }
    );
    assert_eq!(
        inv.entries[1],
        InventoryEntry {
            path: "src".into(),
            is_dir: true,
            size: 0
        }
    );
    assert_eq!((inv.files, inv.folders, inv.truncated), (5, 2, false));
}

#[test]
fn inventory_skips_dependency_build_and_vcs_folders_at_any_depth_and_finder_files() {
    let t = TempRoot::new();
    t.write("defiance/.git/HEAD", "ref");
    t.write("defiance/.git/objects/ab/cd", "x");
    t.write("defiance/node_modules/left-pad/index.js", "x");
    t.write("defiance/src/node_modules/x.js", "x");
    t.write("defiance/target/debug/bin", "x");
    t.write("defiance/dist/app.js", "x");
    t.write("defiance/Build/out.o", "x");
    t.write("defiance/.venv/lib/python/site.py", "x");
    t.write("defiance/venv/x", "x");
    t.write("defiance/src/__pycache__/a.pyc", "x");
    t.write("defiance/coverage/lcov.info", "x");
    t.write("defiance/.cache/x", "x");
    t.write("defiance/pkg.egg-info/PKG-INFO", "x");
    t.write("defiance/.DS_Store", "x");
    t.write("defiance/src/.DS_Store", "x");
    t.write("defiance/.github/workflows/ci.yml", "on: push");
    t.write("defiance/src/app.py", "x");
    let inv = collect_inventory(&t.root, "defiance").unwrap();
    assert_eq!(
        paths(&inv),
        vec![
            ".github",
            "src",
            ".github/workflows",
            "src/app.py",
            ".github/workflows/ci.yml"
        ]
    );
    assert!(!inv.truncated);
}

#[test]
fn inventory_never_lists_or_follows_symlinks() {
    let t = TempRoot::new();
    t.write("defiance/real.md", "x");
    t.write("context/me.md", "private");
    fs::create_dir_all(t.base.join("outside/secret")).unwrap();
    fs::write(t.base.join("outside/secret/key.txt"), "k").unwrap();
    symlink("../context/me.md", t.path("defiance/link.md")).unwrap();
    symlink(t.base.join("outside/secret"), t.path("defiance/linkdir")).unwrap();
    symlink("real.md", t.path("defiance/alias.md")).unwrap();
    let inv = collect_inventory(&t.root, "defiance").unwrap();
    assert_eq!(paths(&inv), vec!["real.md"]);
}

#[test]
fn inventory_is_bounded_by_entries_depth_and_visits() {
    let t = TempRoot::new();
    for i in 0..(MAX_INVENTORY_ENTRIES + 20) {
        t.write(&format!("defiance/f{:04}.txt", i), "x");
    }
    let inv = collect_inventory(&t.root, "defiance").unwrap();
    assert_eq!(inv.entries.len(), MAX_INVENTORY_ENTRIES);
    assert!(inv.truncated);
    assert_eq!(
        inv.files,
        MAX_INVENTORY_ENTRIES + 20,
        "visited beyond the listing bound are still counted"
    );

    let t = TempRoot::new();
    let deep = (0..(MAX_DEPTH + 2))
        .map(|i| format!("d{}", i))
        .collect::<Vec<_>>()
        .join("/");
    t.write(&format!("defiance/{}/leaf.txt", deep), "x");
    let inv = collect_inventory(&t.root, "defiance").unwrap();
    assert!(
        inv.truncated,
        "a folder below the depth bound is listed but not entered"
    );
    assert!(paths(&inv).iter().all(|p| !p.ends_with("leaf.txt")));
    assert!(paths(&inv)
        .iter()
        .any(|p| p.ends_with(&format!("d{}", MAX_DEPTH))));
    assert!(!paths(&inv)
        .iter()
        .any(|p| p.ends_with(&format!("d{}", MAX_DEPTH + 1))));
}

#[test]
fn inventory_refuses_anything_that_is_not_a_work_place() {
    let t = TempRoot::new();
    t.dir("views/defiance");
    t.dir(".hidden");
    symlink("defiance", t.path("linked")).unwrap();
    assert!(collect_inventory(&t.root, "views")
        .unwrap_err()
        .contains("not a work place"));
    assert!(collect_inventory(&t.root, "Views")
        .unwrap_err()
        .contains("not a work place"));
    assert!(collect_inventory(&t.root, ".hidden")
        .unwrap_err()
        .contains("not a work place"));
    assert!(collect_inventory(&t.root, "").is_err());
    assert!(collect_inventory(&t.root, "..").is_err());
    assert!(collect_inventory(&t.root, "a/b").is_err());
    assert!(collect_inventory(&t.root, "missing").is_err());
    assert!(collect_inventory(&t.root, "linked")
        .unwrap_err()
        .contains("not a folder"));
    t.write("file.txt", "x");
    assert!(collect_inventory(&t.root, "file.txt")
        .unwrap_err()
        .contains("not a folder"));
}

// --- writing ---

#[test]
fn written_files_get_the_default_file_mode_not_the_staging_mode() {
    let t = TempRoot::new();
    write_view_files(&t.root, "defiance", &t.root_text(), "{}", "<svg/>", false).unwrap();
    for name in ["map.svg", "view.json"] {
        let mode = fs::metadata(t.path(&format!("views/defiance/{}", name)))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, default_file_mode(), "{}", name);
        assert_ne!(mode, 0o600, "{}", name);
    }
}

#[test]
fn write_creates_views_and_place_folders_and_both_files() {
    let t = TempRoot::new();
    write_view_files(
        &t.root,
        "defiance",
        &t.root_text(),
        "{\"v\":1}",
        "<svg/>",
        false,
    )
    .unwrap();
    assert_eq!(t.read("views/defiance/view.json"), "{\"v\":1}");
    assert_eq!(t.read("views/defiance/map.svg"), "<svg/>");
    assert_eq!(
        t.names("views/defiance"),
        vec!["map.svg", "view.json"],
        "no temporary file is left behind"
    );
}

#[test]
fn an_automatic_write_never_replaces_an_existing_map() {
    let t = TempRoot::new();
    t.write("views/defiance/map.svg", "hand-made");
    let err =
        write_view_files(&t.root, "defiance", &t.root_text(), "{}", "<svg/>", false).unwrap_err();
    assert!(
        err.contains("already exists: views/defiance/map.svg"),
        "{}",
        err
    );
    assert_eq!(t.read("views/defiance/map.svg"), "hand-made");
    assert_eq!(
        t.names("views/defiance"),
        vec!["map.svg"],
        "no view.json and no temporary file"
    );
}

#[test]
fn a_rebuild_replaces_both_files_and_keeps_nothing_stale() {
    let t = TempRoot::new();
    t.write("views/defiance/map.svg", "old map");
    t.write("views/defiance/view.json", "old json");
    write_view_files(
        &t.root,
        "defiance",
        &t.root_text(),
        "new json",
        "new map",
        true,
    )
    .unwrap();
    assert_eq!(t.read("views/defiance/map.svg"), "new map");
    assert_eq!(t.read("views/defiance/view.json"), "new json");
    assert_eq!(t.names("views/defiance"), vec!["map.svg", "view.json"]);
}

#[test]
fn write_refuses_a_changed_root_a_missing_place_and_a_non_place() {
    let t = TempRoot::new();
    let err =
        write_view_files(&t.root, "defiance", "/somewhere/else", "{}", "<svg/>", true).unwrap_err();
    assert!(err.contains("root changed"), "{}", err);
    assert!(!t.path("views").exists(), "nothing was created");
    assert!(write_view_files(&t.root, "gone", &t.root_text(), "{}", "<svg/>", true).is_err());
    assert!(write_view_files(&t.root, "views", &t.root_text(), "{}", "<svg/>", true).is_err());
    assert!(write_view_files(&t.root, ".hidden", &t.root_text(), "{}", "<svg/>", true).is_err());
    assert!(
        write_view_files(&t.root, "../defiance", &t.root_text(), "{}", "<svg/>", true).is_err()
    );
    assert!(!t.path("views").exists());
}

#[test]
fn write_never_follows_a_link_at_views_or_at_the_place_folder() {
    let t = TempRoot::new();
    symlink(t.base.join("outside"), t.path("views")).unwrap();
    let err =
        write_view_files(&t.root, "defiance", &t.root_text(), "{}", "<svg/>", true).unwrap_err();
    assert!(err.contains("not a folder: views"), "{}", err);
    assert!(
        fs::read_dir(t.base.join("outside"))
            .unwrap()
            .next()
            .is_none(),
        "nothing landed through the link"
    );

    let t = TempRoot::new();
    t.dir("views");
    symlink(t.base.join("outside"), t.path("views/defiance")).unwrap();
    let err =
        write_view_files(&t.root, "defiance", &t.root_text(), "{}", "<svg/>", true).unwrap_err();
    assert!(err.contains("not a folder: views/defiance"), "{}", err);
    assert!(fs::read_dir(t.base.join("outside"))
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn write_refuses_oversized_content_before_touching_the_disk() {
    let t = TempRoot::new();
    let big = "x".repeat(MAX_MAP_SVG_BYTES + 1);
    assert!(
        write_view_files(&t.root, "defiance", &t.root_text(), "{}", &big, true)
            .unwrap_err()
            .contains("too large")
    );
    let big = "x".repeat(MAX_VIEW_JSON_BYTES + 1);
    assert!(
        write_view_files(&t.root, "defiance", &t.root_text(), &big, "<svg/>", true)
            .unwrap_err()
            .contains("too large")
    );
    assert!(!t.path("views").exists());
}

#[test]
fn write_refuses_a_map_that_is_not_a_file() {
    let t = TempRoot::new();
    t.dir("views/defiance/map.svg");
    let err =
        write_view_files(&t.root, "defiance", &t.root_text(), "{}", "<svg/>", false).unwrap_err();
    assert!(err.contains("map.svg"), "{}", err);
    assert!(
        t.path("views/defiance/map.svg").is_dir(),
        "the folder at the map's name is untouched"
    );
    assert_eq!(t.names("views/defiance"), vec!["map.svg"]);
}

// --- the root view (the Home map) ---

#[test]
fn the_root_view_folder_is_never_a_place() {
    let t = TempRoot::new();
    t.dir("views/.root");
    assert!(collect_inventory(&t.root, ".root").is_err());
    assert!(write_view_files(&t.root, ".root", &t.root_text(), "{}", "<svg/>", true).is_err());
    assert!(!t.path("views/.root/map.svg").exists());
}

#[test]
fn root_write_creates_views_and_the_reserved_folder_and_both_files_with_the_default_mode() {
    let t = TempRoot::new();
    write_root_view_files(&t.root, &t.root_text(), "{\"v\":1}", "<svg/>", false).unwrap();
    assert_eq!(t.read("views/.root/view.json"), "{\"v\":1}");
    assert_eq!(t.read("views/.root/map.svg"), "<svg/>");
    assert_eq!(
        t.names("views/.root"),
        vec!["map.svg", "view.json"],
        "no temporary file is left behind"
    );
    for name in ["map.svg", "view.json"] {
        let mode = fs::metadata(t.path(&format!("views/.root/{}", name)))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, default_file_mode(), "{}", name);
    }
    // No place's own view folder was touched or created.
    assert_eq!(t.names("views"), vec![".root"]);
}

#[test]
fn an_automatic_root_write_never_replaces_an_existing_root_map() {
    let t = TempRoot::new();
    t.write("views/.root/map.svg", "hand-made");
    t.write("views/.root/view.json", "old json");
    let err = write_root_view_files(&t.root, &t.root_text(), "{}", "<svg/>", false).unwrap_err();
    assert!(
        err.contains("already exists: views/.root/map.svg"),
        "{}",
        err
    );
    assert_eq!(t.read("views/.root/map.svg"), "hand-made");
    assert_eq!(t.read("views/.root/view.json"), "old json");
    assert_eq!(t.names("views/.root"), vec!["map.svg", "view.json"]);
}

#[test]
fn a_root_rebuild_replaces_both_files_and_keeps_nothing_stale() {
    let t = TempRoot::new();
    t.write("views/.root/map.svg", "old map");
    t.write("views/.root/view.json", "old json");
    write_root_view_files(&t.root, &t.root_text(), "new json", "new map", true).unwrap();
    assert_eq!(t.read("views/.root/map.svg"), "new map");
    assert_eq!(t.read("views/.root/view.json"), "new json");
    assert_eq!(t.names("views/.root"), vec!["map.svg", "view.json"]);
}

#[test]
fn root_write_refuses_a_changed_root_and_oversized_content_before_touching_the_disk() {
    let t = TempRoot::new();
    let err = write_root_view_files(&t.root, "/somewhere/else", "{}", "<svg/>", true).unwrap_err();
    assert!(err.contains("root changed"), "{}", err);
    assert!(!t.path("views").exists(), "nothing was created");
    let big = "x".repeat(MAX_MAP_SVG_BYTES + 1);
    assert!(
        write_root_view_files(&t.root, &t.root_text(), "{}", &big, true)
            .unwrap_err()
            .contains("too large")
    );
    let big = "x".repeat(MAX_VIEW_JSON_BYTES + 1);
    assert!(
        write_root_view_files(&t.root, &t.root_text(), &big, "<svg/>", true)
            .unwrap_err()
            .contains("too large")
    );
    assert!(!t.path("views").exists());
}

#[test]
fn root_write_never_follows_a_link_at_views_or_at_the_reserved_folder() {
    let t = TempRoot::new();
    symlink(t.base.join("outside"), t.path("views")).unwrap();
    let err = write_root_view_files(&t.root, &t.root_text(), "{}", "<svg/>", true).unwrap_err();
    assert!(err.contains("not a folder: views"), "{}", err);
    assert!(fs::read_dir(t.base.join("outside"))
        .unwrap()
        .next()
        .is_none());

    let t = TempRoot::new();
    t.dir("views");
    symlink(t.base.join("outside"), t.path("views/.root")).unwrap();
    let err = write_root_view_files(&t.root, &t.root_text(), "{}", "<svg/>", true).unwrap_err();
    assert!(err.contains("not a folder: views/.root"), "{}", err);
    assert!(fs::read_dir(t.base.join("outside"))
        .unwrap()
        .next()
        .is_none());
}

// --- a replacement that fails at the second rename ---

/// Set or clear Finder's "Locked" flag (`uchg`) on a file: a rename over a
/// locked file fails with "Operation not permitted", a real way for the
/// `view.json` rename to fail after `map.svg` was already placed.
fn set_locked(path: &Path, locked: bool) {
    let c = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
    let flags = if locked { libc::UF_IMMUTABLE } else { 0 };
    // SAFETY: a valid NUL-terminated path for a plain chflags call.
    assert_eq!(unsafe { libc::chflags(c.as_ptr(), flags) }, 0);
}

#[test]
fn a_rebuild_whose_view_json_rename_fails_puts_the_old_map_back() {
    let t = TempRoot::new();
    t.write("views/defiance/map.svg", "old map");
    t.write("views/defiance/view.json", "old json");
    set_locked(&t.path("views/defiance/view.json"), true);
    let err = write_view_files(
        &t.root,
        "defiance",
        &t.root_text(),
        "new json",
        "new map",
        true,
    )
    .unwrap_err();
    set_locked(&t.path("views/defiance/view.json"), false);
    assert!(err.contains("cannot write views/defiance/view.json"), "{}", err);
    assert_eq!(t.read("views/defiance/map.svg"), "old map");
    assert_eq!(t.read("views/defiance/view.json"), "old json");
    assert_eq!(
        t.names("views/defiance"),
        vec!["map.svg", "view.json"],
        "the old pair, and no temporary file"
    );
}

#[test]
fn a_first_write_whose_view_json_rename_fails_leaves_no_map_without_its_facts() {
    let t = TempRoot::new();
    t.dir("views/defiance/view.json");
    let err =
        write_view_files(&t.root, "defiance", &t.root_text(), "{}", "<svg/>", false).unwrap_err();
    assert!(err.contains("cannot write views/defiance/view.json"), "{}", err);
    assert!(t.path("views/defiance/view.json").is_dir(), "the folder is untouched");
    assert_eq!(
        t.names("views/defiance"),
        vec!["view.json"],
        "no map without its view.json, and no temporary file"
    );
}

#[test]
fn a_rebuild_with_no_existing_map_places_both_files() {
    let t = TempRoot::new();
    write_view_files(&t.root, "defiance", &t.root_text(), "{}", "<svg/>", true).unwrap();
    assert_eq!(t.read("views/defiance/map.svg"), "<svg/>");
    assert_eq!(t.read("views/defiance/view.json"), "{}");
    assert_eq!(t.names("views/defiance"), vec!["map.svg", "view.json"]);
}

#[test]
fn a_root_rebuild_whose_view_json_rename_fails_keeps_the_old_root_pair() {
    let t = TempRoot::new();
    t.write("views/.root/map.svg", "old map");
    t.write("views/.root/view.json", "old json");
    set_locked(&t.path("views/.root/view.json"), true);
    let err = write_root_view_files(&t.root, &t.root_text(), "new json", "new map", true)
        .unwrap_err();
    set_locked(&t.path("views/.root/view.json"), false);
    assert!(err.contains("cannot write views/.root/view.json"), "{}", err);
    assert_eq!(t.read("views/.root/map.svg"), "old map");
    assert_eq!(t.read("views/.root/view.json"), "old json");
    assert_eq!(t.names("views/.root"), vec!["map.svg", "view.json"]);
}
