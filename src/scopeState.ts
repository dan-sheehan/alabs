/**
 * Live scopes: one record holding every place the user has entered this
 * session: Home, work places and knowledge places. Each scope owns its own
 * tabs, selected folder, expanded folders, tree counters, search state and
 * remembered editor views. Changing place is navigation between scopes;
 * nothing here is closed, disposed or reset by a switch.
 *
 * Every scope-owned update goes through `commit`, which refuses to touch a
 * scope that no longer exists or a target tab that is gone. An async
 * completion captures its scope key and target at start and commits through
 * this guard, so a stale completion mutates nothing.
 */
import { HOME_KEY, type Role, type RootListing, type ScopeKey } from "./places";
import type { GitInspection } from "./subject";
import { EMPTY_TABS, findTab, kindOf, type TabId, type TabState } from "./tabs";
import type { ViewState } from "./uiState";
import { EMPTY_DRAFT, type TaskDraft } from "./task";

export interface Scope {
  key: ScopeKey;
  kind: "home" | "work" | "know";
  /** Display name: the work place's on-disk folder name, the knowledge label (`Wiki`), or `Home`. */
  name: string;
  /** Root-relative folder of the place; "" for Home. A knowledge scope is bound to the folder it resolved. */
  prefix: string;
  /** The knowledge role of a `know` scope; null otherwise. */
  role: Role | null;
  tabs: TabState;
  /** Expanded tree folders, root-relative. */
  expanded: ReadonlySet<string>;
  /** Folder (root-relative) that new items are created in. */
  selectedDir: string;
  /** Per-folder re-list counters for the tree. */
  refresh: Record<string, number>;
  /** Explicit Refresh counter for the tree and the Overview; bumped for the place showing only. */
  reload: number;
  /** Explicit Refresh counter for open Markdown surfaces; bumped for every scope, since a surface reads only its own known path. */
  surfaceReload: number;
  /** What the Overview last found at this place's `.git`, for the where strip; null until it looked. */
  git: GitInspection | null;
  /** Last known cursor and scroll per open tab, root-relative path keys. */
  views: Record<string, ViewState>;
  /** Restored tabs not yet shown this session; their remembered view is applied on first show. */
  pendingViews: ReadonlySet<string>;
  /** True once this scope's remembered tabs were read this session. */
  restored: boolean;
  /** True while the sidebar shows Search instead of the tree. */
  searching: boolean;
  /** The Task tab's draft (Step 6): session memory only, never written to disk. Meaningful for work scopes. */
  task: TaskDraft;
  /** When a task packet was last copied with a baseline recorded, until the next Refresh; the Changes readout's cue. */
  taskStartedAt: number | null;
}

export type Scopes = Readonly<Record<string, Scope>>;

export function homeScope(): Scope {
  return {
    key: HOME_KEY,
    kind: "home",
    name: "Home",
    prefix: "",
    role: null,
    tabs: EMPTY_TABS,
    expanded: new Set(),
    selectedDir: "",
    refresh: {},
    reload: 0,
    surfaceReload: 0,
    git: null,
    views: {},
    pendingViews: new Set(),
    restored: true,
    searching: false,
    task: EMPTY_DRAFT,
    taskStartedAt: null,
  };
}

/** The scopes of a freshly opened root: Home only. */
export function freshScopes(): Scopes {
  return { [HOME_KEY]: homeScope() };
}

export function workScope(key: ScopeKey, name: string, expanded: readonly string[]): Scope {
  return {
    key,
    kind: "work",
    name,
    prefix: name,
    role: null,
    tabs: EMPTY_TABS,
    expanded: new Set(expanded),
    selectedDir: name,
    refresh: {},
    reload: 0,
    surfaceReload: 0,
    git: null,
    views: {},
    pendingViews: new Set(),
    restored: false,
    searching: false,
    task: EMPTY_DRAFT,
    taskStartedAt: null,
  };
}

/**
 * A knowledge scope: bound for the whole session to `folder`, the on-disk
 * spelling the role resolved to when it was entered. It is never re-resolved.
 */
export function knowScope(key: ScopeKey, role: Role, label: string, folder: string, expanded: readonly string[]): Scope {
  return {
    key,
    kind: "know",
    name: label,
    prefix: folder,
    role,
    tabs: EMPTY_TABS,
    expanded: new Set(expanded),
    selectedDir: folder,
    refresh: {},
    reload: 0,
    surfaceReload: 0,
    git: null,
    views: {},
    pendingViews: new Set(),
    restored: false,
    searching: false,
    task: EMPTY_DRAFT,
    taskStartedAt: null,
  };
}

/**
 * Whether a live scope's folder is still in the root, from the last root
 * listing. A work place is present only under the same name; another name is
 * a different place. A knowledge scope is present while its role resolves to
 * the folder it opened, `conflict` while a second folder also matches the
 * role (the scope stays enterable, nothing is re-resolved), and missing when
 * its folder is gone or the role now resolves elsewhere. Home is always
 * present, and so is every scope until the first listing exists.
 */
export type PlaceStatus = "present" | "missing" | "conflict";

export function placeStatus(scope: Scope, listing: RootListing | null): PlaceStatus {
  if (scope.kind === "home" || listing === null) return "present";
  if (scope.kind === "work") return listing.work.some((p) => p.name === scope.prefix) ? "present" : "missing";
  const state = scope.role === null ? null : listing.roles[scope.role];
  if (!state) return "missing";
  if (state.kind === "present") return state.name === scope.prefix ? "present" : "missing";
  if (state.kind === "conflict") return state.names.includes(scope.prefix) ? "conflict" : "missing";
  return "missing";
}

/** Add a scope. An existing scope with the same key is kept as it is; nothing is replaced. */
export function addScope(scopes: Scopes, scope: Scope): Scopes {
  if (scopes[scope.key]) return scopes;
  return { ...scopes, [scope.key]: scope };
}

/**
 * The one guarded update. Returns `scopes` unchanged when the scope is gone
 * or when `target` (a tab id, `kind:path`) is no longer open in it; such a
 * completion is stale. Otherwise replaces that scope only.
 */
export function commit(scopes: Scopes, key: ScopeKey, target: TabId | null, update: (scope: Scope) => Scope): Scopes {
  const scope = scopes[key];
  if (!scope) return scopes;
  if (target !== null && !findTab(scope.tabs, target)) return scopes;
  const next = update(scope);
  if (next === scope) return scopes;
  return { ...scopes, [key]: next };
}

/**
 * Every open editor tab (loaded or unsupported) across every scope, with its
 * owning scope key: the tabs that can hold a buffer and need approval before
 * they are dropped. Markdown tabs hold nothing and are not listed.
 */
export function allTabs(scopes: Scopes): Array<{ key: ScopeKey; relPath: string }> {
  const out: Array<{ key: ScopeKey; relPath: string }> = [];
  for (const scope of Object.values(scopes)) {
    for (const tab of scope.tabs.tabs) if (kindOf(tab) === "editor") out.push({ key: scope.key, relPath: tab.relPath });
  }
  return out;
}

/** Live file models across every scope: one per loaded tab. The cap in `openPath.ts` counts these. */
export function liveModelCount(scopes: Scopes): number {
  let n = 0;
  for (const scope of Object.values(scopes)) for (const tab of scope.tabs.tabs) if (tab.kind === "loaded") n += 1;
  return n;
}

/** Live counts for the status bar and the ACTIVE WORK row. */
export function scopeCounts(scope: Scope): { tabs: number; unsaved: number } {
  let unsaved = 0;
  for (const tab of scope.tabs.tabs) if (tab.kind === "loaded" && tab.dirty) unsaved += 1;
  return { tabs: scope.tabs.tabs.length, unsaved };
}
