import type { FileStamp } from "./subject";

/**
 * What the last explicit Refresh found on disk for a loaded tab.
 * "conflict": the file changed on disk while the buffer had unsaved edits.
 * "missing": nothing exists at the file's path any more.
 * "uncertain": a save was never answered and the file has changed since, so
 * whether that save wrote it is not known. Nothing is retried from here; a
 * Refresh is how the user settles it.
 */
export type DiskState = "ok" | "conflict" | "missing" | "uncertain";

/**
 * The kinds of tab a place can hold. An editor tab (loaded or unsupported)
 * owns a buffer; a markdown tab is a rendered view with no buffer; a view tab
 * is the place's Visual View (`views/<place>/map.svg`), also with no buffer.
 * All are path-backed, so they follow renames and close with a trashed folder.
 * A task or changes tab belongs to the place itself (its path is the place's
 * folder): one of each per work place, no buffer, no file.
 */
export type TabKind = "editor" | "markdown" | "view" | "task" | "changes";
export const TAB_KINDS: readonly TabKind[] = ["editor", "markdown", "view", "task", "changes"];

/** The id every tab is known by: `kind:path` (BUILD_PLAN Step 2 item 21). */
export type TabId = string;

/** One open tab. Identity is `idOf(tab)`; a Markdown, a Visual View and an Editor tab for the same path are separate tabs. */
export type Tab =
  | {
      kind: "loaded";
      relPath: string;
      name: string;
      /** On-disk state when the file was last read or saved. */
      stamp: FileStamp;
      /** Monaco alternative version id of the model at the last read or save. */
      savedVersion: number;
      dirty: boolean;
      disk: DiskState;
    }
  | { kind: "unsupported"; relPath: string; name: string; message: string }
  | { kind: "markdown"; relPath: string; name: string }
  /** The Visual View of a place; `name` is the place's folder name, shown after the `view` tag. */
  | { kind: "view"; relPath: string; name: string }
  /** The place's Task tab (Step 6); `relPath` is the place's folder, the draft lives in the scope. */
  | { kind: "task"; relPath: string; name: string }
  /** The place's Changes tab (Step 6); `relPath` is the place's folder. */
  | { kind: "changes"; relPath: string; name: string };

export interface TabState {
  /** Open tabs in strip order. */
  tabs: Tab[];
  /** Id of the active tab; null means the place's pinned Overview. */
  active: TabId | null;
}

export const EMPTY_TABS: TabState = { tabs: [], active: null };

export function tabIdOf(kind: TabKind, relPath: string): TabId {
  return `${kind}:${relPath}`;
}

export function editorId(relPath: string): TabId {
  return tabIdOf("editor", relPath);
}

export function markdownId(relPath: string): TabId {
  return tabIdOf("markdown", relPath);
}

/** The kind a tab belongs to: loaded and unsupported tabs are editor tabs. */
export function kindOf(tab: Tab): TabKind {
  return tab.kind === "loaded" || tab.kind === "unsupported" ? "editor" : tab.kind;
}

export function idOf(tab: Tab): TabId {
  return tabIdOf(kindOf(tab), tab.relPath);
}

/** Split a tab id into its kind and path; null for anything malformed. */
export function parseId(id: TabId): { kind: TabKind; relPath: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  const kind = id.slice(0, i);
  const relPath = id.slice(i + 1);
  if (!relPath || !(TAB_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as TabKind, relPath };
}

export function findTab(state: TabState, id: TabId): Tab | undefined {
  return state.tabs.find((tab) => idOf(tab) === id);
}

/** The editor tab (loaded or unsupported) at `relPath`, if open. */
export function findEditorTab(state: TabState, relPath: string): Tab | undefined {
  return findTab(state, editorId(relPath));
}

export function activeTab(state: TabState): Tab | undefined {
  return state.active === null ? undefined : findTab(state, state.active);
}

/** Activate an existing tab, or append `tab` and activate it. Never duplicates. */
export function openTab(state: TabState, tab: Tab): TabState {
  const id = idOf(tab);
  if (findTab(state, id)) return { ...state, active: id };
  return { tabs: [...state.tabs, tab], active: id };
}

export function activateTab(state: TabState, id: TabId): TabState {
  return findTab(state, id) ? { ...state, active: id } : state;
}

/**
 * Remove a tab. If it was active, the tab to its left becomes active, or the
 * one to its right when it was first.
 */
export function closeTab(state: TabState, id: TabId): TabState {
  const index = state.tabs.findIndex((tab) => idOf(tab) === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => idOf(tab) !== id);
  if (state.active !== id) return { tabs, active: state.active };
  const next = tabs[index - 1] ?? tabs[index] ?? null;
  return { tabs, active: next ? idOf(next) : null };
}

/** Replace the tab with the same id. Unknown ids leave the state unchanged. */
export function updateTab(state: TabState, id: TabId, update: (tab: Tab) => Tab): TabState {
  if (!findTab(state, id)) return state;
  return { ...state, tabs: state.tabs.map((tab) => (idOf(tab) === id ? update(tab) : tab)) };
}

export function dirtyTabs(state: TabState): Tab[] {
  return state.tabs.filter((tab) => tab.kind === "loaded" && tab.dirty);
}

/** The subject-relative path of `relPath` after `oldPath` moved to `newPath`, or null if unaffected. */
export function movedPath(relPath: string, oldPath: string, newPath: string): string | null {
  if (relPath === oldPath) return newPath;
  if (relPath.startsWith(oldPath + "/")) return newPath + relPath.slice(oldPath.length);
  return null;
}

/**
 * Re-key every tab at or under `oldPath` after it was renamed or moved to
 * `newPath`. Display names, dirty state and the active tab follow. Tabs whose
 * path is in `keep` are left at their old path (their buffer could not follow).
 */
export function moveTabs(
  state: TabState,
  oldPath: string,
  newPath: string,
  keep: ReadonlySet<string> = new Set(),
): TabState {
  const moved = (path: string) => (keep.has(path) ? null : movedPath(path, oldPath, newPath));
  const idMoved = (id: TabId | null): TabId | null => {
    const parsed = id === null ? null : parseId(id);
    if (!parsed) return id;
    const relPath = moved(parsed.relPath);
    return relPath === null ? id : tabIdOf(parsed.kind, relPath);
  };
  const tabs = state.tabs.map((tab) => {
    const relPath = moved(tab.relPath);
    return relPath === null ? tab : { ...tab, relPath, name: relPath.split("/").pop() ?? relPath };
  });
  return { tabs, active: idMoved(state.active) };
}

/**
 * The first open path that a rename or move of `oldPath` to `newPath` would
 * land on, or null when the destination is free. A path at or under
 * `newPath` collides unless it moves along (it is at or under `oldPath`).
 * `openPaths` should include every open editor tab and every live Monaco
 * model, so a buffer whose disk file is gone still protects its path.
 */
export function destinationCollision(openPaths: readonly string[], oldPath: string, newPath: string): string | null {
  for (const path of openPaths) {
    if (isAtOrUnder(path, oldPath)) continue;
    if (isAtOrUnder(path, newPath)) return path;
  }
  return null;
}

/** True when `relPath` is `path` itself or lies inside the folder `path`. */
export function isAtOrUnder(relPath: string, path: string): boolean {
  return relPath === path || relPath.startsWith(path + "/");
}

/**
 * Remove every tab at or under `path`, e.g. after it was moved to the Trash.
 * If the active tab is removed, the nearest survivor to its left becomes
 * active, or the nearest to its right when none is left of it.
 */
export function closeTabsUnder(state: TabState, path: string): TabState {
  const index = state.tabs.findIndex((tab) => idOf(tab) === state.active);
  const tabs = state.tabs.filter((tab) => !isAtOrUnder(tab.relPath, path));
  const active = activeTab(state);
  if (!active || !isAtOrUnder(active.relPath, path)) return { tabs, active: state.active };
  const left = state.tabs.slice(0, index).reverse().find((tab) => !isAtOrUnder(tab.relPath, path));
  const right = state.tabs.slice(index + 1).find((tab) => !isAtOrUnder(tab.relPath, path));
  const next = left ?? right ?? null;
  return { tabs, active: next ? idOf(next) : null };
}

export function stampsEqual(a: FileStamp, b: FileStamp): boolean {
  return a.identity === b.identity && a.mtime_secs === b.mtime_secs && a.mtime_nanos === b.mtime_nanos && a.len === b.len;
}

/**
 * How a Refresh should treat one open tab, given the file's current on-disk
 * stamp (`null` when the file is gone). Only "reload" touches the buffer, and
 * only when the buffer is clean; a dirty buffer is never overwritten.
 */
export type ReconcileOutcome = "unchanged" | "reload" | "conflict" | "missing";

export function reconcileOutcome(tab: Tab, current: FileStamp | null): ReconcileOutcome {
  if (tab.kind !== "loaded") return "unchanged";
  if (current === null) return "missing";
  if (stampsEqual(tab.stamp, current)) return "unchanged";
  return tab.dirty ? "conflict" : "reload";
}
