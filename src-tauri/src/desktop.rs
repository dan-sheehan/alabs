//! The desktop front door. Every command here is a thin wrapper: it resolves
//! the open root (or the app data directory), hands the work to the shared
//! core in `lib.rs`, and returns what the core returned. No filesystem rule,
//! path check or limit lives in this file.

use super::*;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
fn view_session(expected_root: String, subject: State<Subject>) -> Result<u64, String> {
    with_root_session(&subject, None, |root| {
        if root.path.to_string_lossy() != expected_root {
            return Err("the alabs root changed while the view was being built".to_string());
        }
        Ok(subject.root_session.load(Ordering::SeqCst))
    })
}

/// Open `path` as the alabs root. Runs on launch (the remembered root) and on
/// an explicit root change, so it is async and does its filesystem work off
/// the main thread. The new folder is validated and opened before the handle
/// is replaced: on any failure the previous root stays open and untouched.
#[tauri::command]
async fn open_subject(path: String, app: AppHandle) -> Result<SubjectInfo, String> {
    let data_dir = app_data_dir(&app)?;
    let root = tauri::async_runtime::spawn_blocking(move || -> Result<SubjectRoot, String> {
        let root = SubjectRoot::open(Path::new(&path))?;
        let state_dir = canonical_projection(&data_dir);
        if let Some(err) = state_dir_conflict(&root.path, &state_dir) {
            return Err(err);
        }
        Ok(root)
    })
    .await
    .map_err(|e| e.to_string())??;
    let subject = app.state::<Subject>();
    let info = SubjectInfo {
        name: root
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.path.to_string_lossy().into_owned()),
        path: root.path.to_string_lossy().into_owned(),
    };
    subject.replace_root(root)?;
    Ok(info)
}

#[tauri::command]
fn list_dir(
    rel_path: String,
    expected_session: Option<u64>,
    subject: State<Subject>,
) -> Result<Vec<Entry>, String> {
    let root = with_root_session(&subject, expected_session, SubjectRoot::try_clone)?;
    list_entries(&root, &rel_path)
}

/// Existence check used by Home (`views/<place>/index.html`) before the
/// shell can paint, so it runs off the main thread.
#[tauri::command]
async fn entry_kind(rel_path: String, app: AppHandle) -> Result<EntryKind, String> {
    let root = current_root(&app.state::<Subject>())?;
    tauri::async_runtime::spawn_blocking(move || entry_kind_in(&root, &rel_path))
        .await
        .map_err(|e| e.to_string())?
}

/// Git facts for one work place (BUILD_PLAN Step 4): repository kind, branch
/// and last commit, through the one hardened bounded helper in `git.rs`.
/// Runs off the main thread; the Command Line Tools probe happens here,
/// lazily, once per launch.
#[tauri::command]
async fn git_facts(place: String, app: AppHandle) -> Result<git::GitInspection, String> {
    let root = current_root(&app.state::<Subject>())?;
    tauri::async_runtime::spawn_blocking(move || {
        let env = git::GitEnv {
            program: Path::new(git::GIT_PROGRAM),
            available: git::tools_available(),
            // The desktop application is the window in front of the user;
            // git behaves here exactly as it always has.
            no_optional_locks: false,
        };
        let subject = app.state::<Subject>();
        git::inspect(&root, &place, &env, &subject.git_formats)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One change query for a work place (BUILD_PLAN Step 6): the handoff
/// baseline, the change listings per mode, and one side of a comparison.
/// Same gate and same bounded helper as `git_facts`; off the main thread.
#[tauri::command]
async fn git_query(
    place: String,
    query: git::GitQuery,
    app: AppHandle,
) -> Result<git::GitQueryResult, String> {
    let root = current_root(&app.state::<Subject>())?;
    tauri::async_runtime::spawn_blocking(move || {
        let env = git::GitEnv {
            program: Path::new(git::GIT_PROGRAM),
            available: git::tools_available(),
            // The desktop application is the window in front of the user;
            // git behaves here exactly as it always has.
            no_optional_locks: false,
        };
        let subject = app.state::<Subject>();
        git::query(&root, &place, &env, &subject.git_formats, &query)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `Open in Terminal` (BUILD_PLAN Step 6): Terminal.app at the place, its
/// path read back from the root handle. Off the main thread; nothing waits
/// on Terminal itself.
#[tauri::command]
async fn open_terminal(place: String, app: AppHandle) -> Result<(), String> {
    let root = current_root(&app.state::<Subject>())?;
    tauri::async_runtime::spawn_blocking(move || {
        git::open_terminal(&root, &place, Path::new(git::OPEN_PROGRAM))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The installed models the local Ollama reports (post-Stage-1 `Ask local
/// model`): one bounded HTTP/1.0 GET to the fixed loopback port, only from
/// the section's explicit choose, change or retry click. Off the main
/// thread; nothing here starts, pulls or catalogues anything, and nothing
/// logs.
#[tauri::command]
async fn list_local_models() -> Result<local_model::ModelListResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        local_model::list_models(local_model::OLLAMA_ADDR, local_model::LIST_TIMEOUT)
    })
    .await
    .map_err(|e| e.to_string())
}

/// `Ask local model` on the Wiki Overview (post-Stage-1 feature): one
/// bounded HTTP/1.0 call to the local Ollama port with the input the
/// frontend built and the model the user chose. `model` is checked in
/// `local_model::ask` to be nonempty and present in Ollama's installed
/// list at that moment before anything is generated; the destination is
/// the fixed loopback address and the name only ever becomes the `model`
/// field of the JSON body. Off the main thread; nothing here reads a file
/// or logs. Ollama is never started: a refused connection is `unavailable`.
#[tauri::command]
async fn ask_local_model(
    model: String,
    system: String,
    prompt: String,
    expected_session: u64,
    app: AppHandle,
) -> Result<local_model::LocalModelResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // A queued ask cannot start in a replacement root. An already
        // dispatched request may finish without holding up navigation.
        with_root_session(&app.state::<Subject>(), Some(expected_session), |_| Ok(()))?;
        Ok(local_model::ask(
            local_model::OLLAMA_ADDR,
            &model,
            &system,
            &prompt,
            local_model::REQUEST_TIMEOUT,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One Visual View build call (one step of Raven's workflow): the same
/// bounded loopback exchange as `ask_local_model`, with the JSON shape
/// (`format: json`, `think: false`, the larger context window, the longer
/// deadline). Called only from the build queue after a `Run Raven` click,
/// never from navigation, Refresh or launch; the frontend validates every
/// byte of the answer before anything is rendered or written. Off the main
/// thread; nothing here logs.
#[tauri::command]
async fn generate_local_model_json(
    model: String,
    system: String,
    prompt: String,
    expected_session: u64,
    app: AppHandle,
) -> Result<local_model::LocalModelResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_root_session(&app.state::<Subject>(), Some(expected_session), |_| Ok(()))?;
        Ok(local_model::generate(
            local_model::OLLAMA_ADDR,
            &model,
            &system,
            &prompt,
            local_model::VIEW_REQUEST_TIMEOUT,
            local_model::VIEW_SHAPE,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The bounded inventory of one work place for a Visual View build
/// (`view_files.rs`): a breadth-first listing through the root handle that
/// never enters dependency, build or version-control folders and never
/// follows a link. Nothing in the place is read, run or installed here.
#[tauri::command]
async fn collect_inventory(
    place: String,
    expected_session: Option<u64>,
    app: AppHandle,
) -> Result<view_files::Inventory, String> {
    let root = with_root_session(
        &app.state::<Subject>(),
        expected_session,
        SubjectRoot::try_clone,
    )?;
    tauri::async_runtime::spawn_blocking(move || view_files::collect_inventory(&root, &place))
        .await
        .map_err(|e| e.to_string())?
}

/// Write a validated, rendered Visual View as `views/<place>/view.json` and
/// `views/<place>/map.svg` (`view_files.rs`). `expected_root` must be the
/// root the build started in. With `replace` false an existing map is
/// never overwritten; with it true (a Raven run) the old map is replaced only
/// at the final rename, after the new content is fully on disk.
#[tauri::command]
async fn write_view_files(
    place: String,
    expected_root: String,
    expected_session: u64,
    view_json: String,
    map_svg: String,
    replace: bool,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_root_session(&app.state::<Subject>(), Some(expected_session), |root| {
            view_files::write_view_files(
                root,
                &place,
                &expected_root,
                &view_json,
                &map_svg,
                replace,
            )
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write the root Visual View (the Home map) as `views/.root/view.json`
/// and `views/.root/map.svg` (`view_files.rs`), with the same staging and
/// replace rules as `write_view_files`. `.root` is never a work place.
#[tauri::command]
async fn write_root_view_files(
    expected_root: String,
    expected_session: u64,
    view_json: String,
    map_svg: String,
    replace: bool,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_root_session(&app.state::<Subject>(), Some(expected_session), |root| {
            view_files::write_root_view_files(root, &expected_root, &view_json, &map_svg, replace)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn read_file(
    rel_path: String,
    expected_session: Option<u64>,
    subject: State<Subject>,
) -> Result<FileContent, String> {
    let root = with_root_session(&subject, expected_session, SubjectRoot::try_clone)?;
    read_file_in(&root, &rel_path)
}

#[tauri::command]
fn stat_file(rel_path: String, subject: State<Subject>) -> Result<Option<FileStamp>, String> {
    stat_file_in(&current_root(&subject)?, &rel_path)
}

#[tauri::command]
fn save_file(
    rel_path: String,
    content: String,
    expected: FileStamp,
    subject: State<Subject>,
) -> Result<FileStamp, String> {
    write_file_in(&current_root(&subject)?, &rel_path, &content, expected)
}

/// Recreate a file the user has explicitly agreed to bring back after it
/// vanished from disk. The frontend asks first; this never runs on its own.
#[tauri::command]
fn recreate_file(
    rel_path: String,
    content: String,
    subject: State<Subject>,
) -> Result<FileStamp, String> {
    recreate_file_in(&current_root(&subject)?, &rel_path, &content)
}

#[tauri::command]
fn create_file(
    parent_rel: String,
    name: String,
    subject: State<Subject>,
) -> Result<String, String> {
    create_in(&current_root(&subject)?, &parent_rel, &name, false)
}

#[tauri::command]
fn create_dir(parent_rel: String, name: String, subject: State<Subject>) -> Result<String, String> {
    create_in(&current_root(&subject)?, &parent_rel, &name, true)
}

/// Rename or move inside one place. `scope` is the place's root-relative
/// folder; source and destination must both stay inside it.
#[tauri::command]
fn move_item(
    from_rel: String,
    to_parent_rel: String,
    new_name: String,
    scope: String,
    subject: State<Subject>,
) -> Result<String, String> {
    move_in_scope(
        &current_root(&subject)?,
        &scope,
        &from_rel,
        &to_parent_rel,
        &new_name,
    )
}

#[tauri::command]
fn trash_item(rel_path: String, subject: State<Subject>, app: AppHandle) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot find the Trash: {}", e))?;
    let trash = open_trash_dir(&home)?;
    trash_in(&current_root(&subject)?, &rel_path, &trash)
}

#[derive(Serialize, Clone)]
struct SearchBatch {
    search_id: u64,
    results: Vec<SearchResult>,
}

/// Run one on-demand search of one scope (a root-relative folder prefix).
/// Results stream to the frontend as `search-results` events tagged with
/// `search_id`; the returned summary marks the end. Starting a search cancels
/// any earlier one. Nothing runs once the summary is returned. The scope is
/// required: a search never covers the whole root.
#[tauri::command]
async fn search_subject(
    query: String,
    search_id: u64,
    scope: String,
    expected_session: Option<u64>,
    app: AppHandle,
) -> Result<SearchSummary, String> {
    let root = {
        let subject = app.state::<Subject>();
        with_root_session(&subject, expected_session, |root| {
            subject.latest_search.store(search_id, Ordering::SeqCst);
            root.try_clone()
        })?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let subject = app.state::<Subject>();
        let cancelled = || !subject.search_is_current(search_id);
        let mut batch = Vec::new();
        let flush = |batch: &mut Vec<SearchResult>| {
            if !batch.is_empty() {
                let _ = app.emit(
                    "search-results",
                    SearchBatch {
                        search_id,
                        results: std::mem::take(batch),
                    },
                );
            }
        };
        let mut sink = |result: SearchResult| {
            batch.push(result);
            if batch.len() >= 50 {
                flush(&mut batch);
            }
        };
        let summary = search_in(&root, &scope, &query, &cancelled, &mut sink)?;
        if !summary.cancelled {
            flush(&mut batch);
        }
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stop only the named search. A late cleanup must not stop a newer walk.
#[tauri::command]
fn cancel_search(search_id: u64, subject: State<Subject>) {
    subject.cancel_search(search_id);
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {}", e))
}

/// Load the disposable UI state (recent subjects, per-subject tree and tab
/// layout) from the app data directory. Reads nothing inside any subject.
#[tauri::command]
fn load_ui_state(app: AppHandle) -> Result<Option<String>, String> {
    load_state_in(&app_data_dir(&app)?)
}

/// Store the disposable UI state in the app data directory.
#[tauri::command]
fn save_ui_state(text: String, app: AppHandle) -> Result<(), String> {
    save_state_in(&app_data_dir(&app)?, &text)
}

/// Record one named event in `alabs.log` in the app data directory. The
/// frontend decides what is logged and never sends file, packet, diff or
/// clipboard contents or absolute root paths.
#[tauri::command]
fn append_log(text: String, app: AppHandle) -> Result<(), String> {
    append_log_in(&app_data_dir(&app)?, &text)
}

/// Exit the application. The frontend calls this only after unsaved edits
/// have been dealt with.
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Menu item id for File > Close Tab (Command-W). The frontend closes the
/// active closable tab; the window is never closed by this key.
const CLOSE_TAB_ID: &str = "close-tab";

/// The application menu, built here so that Command-W reaches the frontend
/// as a tab close and no menu item closes the window. Everything else is the
/// platform's own item: the Edit items are what let the editor cut, copy and
/// paste on macOS; Quit goes through the unsaved-edits guard below.
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        ..Default::default()
    };
    let app_menu = SubmenuBuilder::new(app, info.name.clone())
        .about(Some(about))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let close_tab = MenuItemBuilder::with_id(CLOSE_TAB_ID, "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File").item(&close_tab).build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Subject::default())
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id() == CLOSE_TAB_ID {
                    let _ = app.emit("close-tab-requested", ());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_subject,
            list_dir,
            entry_kind,
            git_facts,
            git_query,
            open_terminal,
            list_local_models,
            ask_local_model,
            generate_local_model_json,
            collect_inventory,
            view_session,
            write_view_files,
            write_root_view_files,
            read_file,
            stat_file,
            save_file,
            recreate_file,
            create_file,
            create_dir,
            move_item,
            trash_item,
            search_subject,
            cancel_search,
            load_ui_state,
            save_ui_state,
            append_log,
            quit
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // A user-initiated exit (Quit menu, Command-Q) is routed through the
            // frontend so unsaved edits can be handled first. Programmatic exits
            // via the `quit` command carry a code and proceed.
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
                let _ = app.emit("quit-requested", ());
            }
        });
}
