import { bridge, host, type RootInfo } from "./runtime";

/**
 * Every operation below is one named native call through the runtime
 * bridge. The shapes are the contract with the Rust side and do not change
 * with the runtime; only the transport does.
 */

/** The open alabs root, as the runtime reports it. */
export type { RootInfo };

export interface Entry {
  name: string;
  /** Path relative to the alabs root, using "/" separators. */
  rel_path: string;
  /** True for a real folder. A symlink is listed by its own type (never a folder). */
  is_dir: boolean;
}

/**
 * Show the folder picker and return the chosen absolute path, or null when
 * the user cancels. The host owns it (`runtime.ts`): it is the surrounding
 * application's dialog, not an alabs root operation.
 */
export const pickFolder = (): Promise<string | null> => host.pickFolder();

/**
 * Open the folder at an absolute `path` as the alabs root. The new folder is
 * validated and opened before the previous root handle is replaced; on
 * rejection the previous root stays open and untouched.
 */
export function openRoot(path: string): Promise<RootInfo> {
  return bridge.invoke<RootInfo>("open_subject", { path });
}

/**
 * Read the disposable UI state text from the app data directory. Null means
 * only that no state file exists. Anything else unusable rejects with a
 * named reason. Reads nothing inside the root.
 */
export function loadUiState(): Promise<string | null> {
  return bridge.invoke<string | null>("load_ui_state");
}

/** Store the disposable UI state text in the app data directory. */
export function saveUiState(text: string): Promise<void> {
  return bridge.invoke("save_ui_state", { text });
}

/**
 * Append one line to `alabs.log` in the app data directory. Callers never
 * wait on it and never pass file contents or absolute root paths.
 */
export function appendLog(text: string): Promise<void> {
  return bridge.invoke("append_log", { text });
}

/** List one directory level inside the root. */
export function listDir(relPath: string, expectedSession?: number): Promise<Entry[]> {
  return bridge.invoke<Entry[]>("list_dir", { relPath, expectedSession });
}

export type EntryKind = "file" | "dir" | "none";

/**
 * What exists at a root-relative path: a file, a folder, or nothing usable.
 * Rejects a path that would leave the root.
 */
export function entryKind(relPath: string): Promise<EntryKind> {
  return bridge.invoke<EntryKind>("entry_kind", { relPath });
}

/** One Git fact, or the named reason it is not available (`src-tauri/src/git.rs`). */
export type GitOutcome<T> = { kind: "ok"; value: T } | { kind: "timeout" } | { kind: "too_large" } | { kind: "failed"; reason: string };

export interface Commit {
  subject: string;
  /** Committer time, seconds since the epoch. */
  time: number;
}

/** What alabs found at a place's `.git`. */
export type GitInspection =
  /** No `.git`: an ordinary folder. */
  | { kind: "none" }
  /** `.git` is a file or a link: not supported yet; nothing was run. */
  | { kind: "linked" }
  /** The Command Line Tools are not installed; nothing was run. */
  | { kind: "unavailable" }
  /** The repository cannot be inspected safely; nothing was run. */
  | { kind: "refused"; reason: string }
  /** Branch (empty when detached) and the last commit (null before the first commit). */
  | { kind: "facts"; branch: GitOutcome<string>; last: GitOutcome<Commit | null> }
  /** The place could not be opened (missing, outside the root); the raw reason. */
  | { kind: "error"; reason: string };

/**
 * Inspect the `.git` of one work place through the one bounded Git helper.
 * Never rejects: a handle failure comes back as `error`. Nothing here runs a
 * program the repository controls and nothing touches the network.
 */
export async function gitFacts(place: string): Promise<GitInspection> {
  try {
    return await bridge.invoke<GitInspection>("git_facts", { place });
  } catch (err) {
    return { kind: "error", reason: String(err) };
  }
}

/** One question about a place's repository (BUILD_PLAN Step 6), answered through the same bounded helper as `gitFacts`. */
export type GitQuery =
  /** The current commit and whether the working copy is clean: the handoff baseline. */
  | { kind: "head" }
  /** `Not yet committed`: the NUL-delimited status listing. */
  | { kind: "status" }
  /** `Commits since task started`: names and states between the baseline and the last commit. */
  | { kind: "committed"; baseline: string }
  /** `Since task started`: names and states between the baseline and the disk, plus current untracked files. */
  | { kind: "since"; baseline: string }
  /** One side of a comparison: the file at `path` (place-relative) in `rev` (`HEAD` or a full object name). */
  | { kind: "blob"; rev: string; path: string };

export type GitQueryResult =
  | { kind: "none" }
  | { kind: "linked" }
  | { kind: "unavailable" }
  | { kind: "refused"; reason: string }
  | { kind: "timeout" }
  | { kind: "too_large" }
  | { kind: "failed"; reason: string }
  /** `commit` is null before the first commit. */
  | { kind: "head"; commit: string | null; clean: boolean }
  /** NUL-delimited text exactly as git wrote it; `changes.ts` parses it. */
  | { kind: "files"; text: string }
  | { kind: "since"; diff: string; untracked: string }
  | { kind: "baseline_missing" }
  | { kind: "blob"; text: string }
  | { kind: "binary" }
  | { kind: "missing" }
  /** The place could not be opened (missing, outside the root); the raw reason. */
  | { kind: "error"; reason: string };

/**
 * Ask one change question of a work place. Never rejects: a handle failure
 * comes back as `error`. Same gate and same hardened helper as `gitFacts`.
 */
export async function gitQuery(place: string, query: GitQuery): Promise<GitQueryResult> {
  try {
    return await bridge.invoke<GitQueryResult>("git_query", { place, query });
  } catch (err) {
    return { kind: "error", reason: String(err) };
  }
}

/**
 * Open Terminal.app at a work place (`open -a Terminal <path>`, the path read
 * back from the root handle). Resolves once `open` has asked for the window;
 * nothing waits on Terminal itself. Rejects with the named reason.
 */
export function openTerminal(place: string): Promise<void> {
  return bridge.invoke("open_terminal", { place });
}

/** What one `Ask local model` call produced (`src-tauri/src/local_model.rs`). */
export type LocalModelResult =
  /** The model answered; `model` names what answered. */
  | { kind: "answer"; text: string; model: string }
  /** The named model is not in Ollama's installed list right now (empty when no name was given). */
  | { kind: "not_installed"; model: string }
  /** Nothing accepted the connection: Ollama is stopped or not installed. */
  | { kind: "unavailable" }
  /** The deadline passed before the answer arrived. */
  | { kind: "timeout" }
  /** The request was refused or the answer unusable; a short reason, never the input. */
  | { kind: "failed"; reason: string };

/** What listing the installed models produced. */
export type ModelListResult =
  /** The names the local Ollama reports as installed, in its order; may be empty. */
  | { kind: "models"; names: string[] }
  | { kind: "unavailable" }
  | { kind: "timeout" }
  | { kind: "failed"; reason: string };

/**
 * List the models the local Ollama reports as installed (post-Stage-1 Wiki
 * feature). Called only from the section's explicit choose, change or retry
 * click; never from navigation. Never rejects: a bridge failure comes back
 * as `failed`. Nothing is logged and nothing leaves the Mac.
 */
export async function listLocalModels(): Promise<ModelListResult> {
  try {
    return await bridge.invoke<ModelListResult>("list_local_models");
  } catch (err) {
    return { kind: "failed", reason: String(err) };
  }
}

/**
 * Ask the chosen local model once (post-Stage-1 Wiki feature). Called only
 * from the explicit Ask click with the input `localModel.ts` built and the
 * model the user selected; Rust refuses a name Ollama does not list. Never
 * rejects: a bridge failure comes back as `failed`. Nothing is logged and
 * nothing leaves the Mac.
 */
export async function askLocalModel(model: string, system: string, prompt: string, expectedSession: number): Promise<LocalModelResult> {
  try {
    return await bridge.invoke<LocalModelResult>("ask_local_model", { model, system, prompt, expectedSession });
  } catch (err) {
    return { kind: "failed", reason: String(err) };
  }
}

/**
 * One Visual View build call (post-Stage-1 automatic Visual Views): the same
 * loopback exchange as `askLocalModel` in the JSON shape (`format: json`,
 * `think: false`, a larger context window, a longer deadline). Called only
 * from the build queue with the model the user selected; Rust refuses a name
 * Ollama does not list. Never rejects: a bridge failure comes back as
 * `failed`. Nothing is logged and nothing leaves the Mac.
 */
export async function generateLocalModelJson(model: string, system: string, prompt: string, expectedSession: number): Promise<LocalModelResult> {
  try {
    return await bridge.invoke<LocalModelResult>("generate_local_model_json", { model, system, prompt, expectedSession });
  } catch (err) {
    return { kind: "failed", reason: String(err) };
  }
}

/** One entry of a place's bounded inventory: a place-relative path, whether it is a folder, and a file's size in bytes. */
export interface InventoryEntry {
  path: string;
  is_dir: boolean;
  size: number;
}

/** The bounded inventory of one work place (`src-tauri/src/view_files.rs`), breadth first; `truncated` when a bound cut it. */
export interface Inventory {
  entries: InventoryEntry[];
  truncated: boolean;
  files: number;
  folders: number;
}

/**
 * List one work place for a Visual View build: a bounded breadth-first walk
 * through the root handle that never enters dependency, build or
 * version-control folders and never follows a link. Reads no file.
 */
export function collectInventory(place: string, expectedSession?: number): Promise<Inventory> {
  return bridge.invoke<Inventory>("collect_inventory", { place, expectedSession });
}

/**
 * Write a validated, rendered Visual View as `views/<place>/view.json` and
 * `views/<place>/map.svg`. `expectedRoot` is the root the build started in;
 * a different open root refuses the write. With `replace` false an existing
 * map is never overwritten (an automatic build); with it true (Rebuild) the
 * old map is replaced only at the final rename.
 */
export function writeViewFiles(place: string, expectedRoot: string, viewJson: string, mapSvg: string, replace: boolean, expectedSession: number): Promise<void> {
  return bridge.invoke("write_view_files", { place, expectedRoot, viewJson, mapSvg, replace, expectedSession });
}

/**
 * Write the validated, rendered root Visual View (the Home map) as
 * `views/.root/view.json` and `views/.root/map.svg`, with the same staging
 * and replace rules as `writeViewFiles`. `.root` is never a work place.
 */
export function writeRootViewFiles(expectedRoot: string, viewJson: string, mapSvg: string, replace: boolean, expectedSession: number): Promise<void> {
  return bridge.invoke("write_root_view_files", { expectedRoot, viewJson, mapSvg, replace, expectedSession });
}

export interface FileContent {
  name: string;
  content: string;
  stamp: FileStamp;
}

/** Read one UTF-8 text file inside the root. */
export function readFile(relPath: string, expectedSession?: number): Promise<FileContent> {
  return bridge.invoke<FileContent>("read_file", { relPath, expectedSession });
}

/** On-disk state recorded when a file was read; sent back to verify a save. */
export interface FileStamp {
  /** Device/inode pair, kept as text to preserve integer precision. */
  identity: string;
  mtime_secs: number;
  mtime_nanos: number;
  len: number;
}

/**
 * Current on-disk stamp of a file inside the root, or null when nothing
 * exists at that path any more. Called only from an explicit Refresh or a
 * refused save.
 */
export function statFile(relPath: string): Promise<FileStamp | null> {
  return bridge.invoke<FileStamp | null>("stat_file", { relPath });
}

/**
 * Replace the contents of a file inside the root. Rejected if the file
 * changed on disk since `expected` was recorded. Returns the new stamp.
 */
export function saveFile(relPath: string, content: string, expected: FileStamp): Promise<FileStamp> {
  return bridge.invoke<FileStamp>("save_file", { relPath, content, expected });
}

/**
 * Recreate a file that vanished from disk, at its original path, with the
 * tab's buffer. Call only after the user explicitly confirmed. Rejected if the
 * parent folder is gone or anything already exists at the path. Returns the
 * new file's stamp.
 */
export function recreateFile(relPath: string, content: string): Promise<FileStamp> {
  return bridge.invoke<FileStamp>("recreate_file", { relPath, content });
}

/**
 * Create a new empty file named `name` inside `parentRel` (a folder relative
 * to the root; "" is the root itself). Never overwrites. Returns the new
 * file's root-relative path.
 */
export function createFile(parentRel: string, name: string): Promise<string> {
  return bridge.invoke<string>("create_file", { parentRel, name });
}

/** Create a new folder named `name` inside `parentRel`. Never overwrites. */
export function createDir(parentRel: string, name: string): Promise<string> {
  return bridge.invoke<string>("create_dir", { parentRel, name });
}

/**
 * Rename or move the file or folder at `fromRel` so it becomes
 * `toParentRel/newName`, inside the place whose root-relative folder is
 * `scope`. Rust refuses a source or destination outside that folder before
 * touching the disk. The destination parent must already exist. Never
 * overwrites. Returns the item's new root-relative path.
 */
export function moveItem(fromRel: string, toParentRel: string, newName: string, scope: string): Promise<string> {
  return bridge.invoke<string>("move_item", { fromRel, toParentRel, newName, scope });
}

/**
 * Move the file or folder at `relPath` to the macOS Trash (`~/.Trash`, same
 * volume only). Never permanently deletes anything. Refuses the root itself,
 * anything outside it, and items on another volume.
 */
export function trashItem(relPath: string): Promise<void> {
  return bridge.invoke("trash_item", { relPath });
}

/**
 * Exit the application. Call only after unsaved edits have been handled.
 * The host owns it (`runtime.ts`): what exiting means belongs to the
 * surrounding application.
 */
export const quit = (): Promise<void> => host.quit();

/** One search hit. A filename hit has no line; a content hit has a line and its text. */
export interface SearchResult {
  name: string;
  /** Path relative to the alabs root, using "/" separators. */
  rel_path: string;
  line: number | null;
  text: string | null;
}

export interface SearchSummary {
  files: number;
  results: number;
  /** True when the search stopped at the result cap. */
  truncated: boolean;
  /** True when a newer search replaced this one before it finished. */
  cancelled: boolean;
}

/**
 * Run one on-demand search of one place for a literal query. `scope` is the
 * place's root-relative folder; the search never widens beyond it. Hits
 * stream through `onSearchResults` tagged with `searchId`; the returned
 * summary marks the end. Starting a search cancels any earlier one. Nothing
 * is indexed or kept between calls.
 */
export function searchScope(query: string, searchId: number, scope: string, expectedSession?: number): Promise<SearchSummary> {
  return bridge.invoke<SearchSummary>("search_subject", { query, searchId, scope, expectedSession });
}

/** Search ids, shared by the Search box and a Raven run: each new id drops any late results of an earlier search. */
let searchIds = 0;
export function nextSearchId(): number {
  searchIds += 1;
  return searchIds;
}

/**
 * One search of one place, collected: the same walk as the Search box
 * (`searchScope`), with its hits gathered until the summary marks the end.
 * Used by a Raven run for one action; it cancels a search the box is
 * running, as any new search does, and the box's next search cancels it.
 */
export async function searchPlace(query: string, scope: string, expectedSession?: number): Promise<{ results: SearchResult[]; summary: SearchSummary }> {
  const id = nextSearchId();
  const results: SearchResult[] = [];
  const unlisten = await onSearchResults((batch) => {
    if (batch.search_id === id) results.push(...batch.results);
  });
  try {
    const summary = await searchScope(query, id, scope, expectedSession);
    // The last batch is emitted before the summary returns; one turn of the event loop lets it land.
    await new Promise((r) => setTimeout(r, 0));
    return { results, summary };
  } finally {
    unlisten();
  }
}

/** Stop only this request; an old cleanup cannot stop a newer UI or Raven search. */
export function cancelSearch(searchId: number): Promise<void> {
  return bridge.invoke("cancel_search", { searchId });
}

/** Subscribe to streamed search hits. Returns a function that unsubscribes. */
export function onSearchResults(
  handler: (batch: { search_id: number; results: SearchResult[] }) => void,
): Promise<() => void> {
  return bridge.listen<{ search_id: number; results: SearchResult[] }>("search-results", handler);
}

/** Capture the native root session for an explicit Raven run; never persisted. */
export function viewSession(expectedRoot: string): Promise<number> {
  return bridge.invoke("view_session", { expectedRoot });
}
