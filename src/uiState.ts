/**
 * Disposable local UI state, version 2: the remembered alabs root, the
 * remembered active work place, and one layout per scope (Home, work places,
 * knowledge roles) keyed by scope key with `kind:path` tab identities. Only
 * root-relative paths, view numbers and the chosen local model's name are
 * stored, never file contents and never task text.
 *
 * Remembering a root or a layout grants no permission to read anything.
 * Nothing in this module touches the disk; App decides when the remembered
 * root is opened and when a scope's remembered tabs are read.
 */
import { HOME_KEY, isPlaceName, isScopeKey, type ScopeKey } from "./places";

export const STATE_VERSION = 2;
export const MAX_TABS = 20;
export const MAX_EXPANDED = 200;
/** Most remembered scope layouts; the least recently visited are dropped first. */
export const MAX_SCOPES = 40;

/** Tab kinds this version knows. A stored tab of any other kind is dropped, never guessed at. */
export const TAB_KINDS = ["editor", "markdown", "view", "task", "changes"] as const;
export type TabKind = (typeof TAB_KINDS)[number];

/** Cursor and scroll of one editor tab. */
export interface ViewState {
  line: number;
  column: number;
  scrollTop: number;
}

/** Layout of one scope, keyed by root-relative paths and `kind:path` tab ids. */
export interface ScopeLayout {
  expanded: string[];
  /** Tab ids in strip order, `kind:path`. */
  tabs: string[];
  active: string | null;
  views: Record<string, ViewState>;
  /** When the scope was last visited (ms since the epoch); orders the cap. */
  visited: number;
}

/**
 * A coding-tool handoff baseline for one work place, recorded when a task
 * packet is copied (BUILD_PLAN Step 6): the commit at that moment, when, and
 * whether the working copy was clean. Never task text.
 */
export interface Baseline {
  commit: string;
  /** Ms since the epoch. */
  at: number;
  clean: boolean;
}

export interface UiState {
  version: number;
  /** Absolute path of the remembered root, or null before one was chosen. */
  root: string | null;
  /** Name of the remembered active work place inside the root, or null. */
  activeWork: string | null;
  scopes: Record<string, ScopeLayout>;
  /** Keyed by work place name. */
  baselines: Record<string, Baseline>;
  /** The local model chosen for `Ask local model`, as Ollama names it, or null. Machine state: kept across roots. */
  localModel: string | null;
}

export const EMPTY_STATE: UiState = { version: STATE_VERSION, root: null, activeWork: null, scopes: {}, baselines: {}, localModel: null };
export const EMPTY_LAYOUT: ScopeLayout = { expanded: [], tabs: [], active: null, views: {}, visited: 0 };

/** What `parseState` produced and, when it had to start fresh from a damaged or old file, the technical reason. */
export interface ParsedState {
  state: UiState;
  fallback: string | null;
}

export function tabId(kind: TabKind, path: string): string {
  return `${kind}:${path}`;
}

/** Split a `kind:path` tab id; null for an unknown kind or an empty path. */
export function parseTabId(id: string): { kind: TabKind; path: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  const kind = id.slice(0, i);
  const path = id.slice(i + 1);
  if (!path || !(TAB_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as TabKind, path };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, cap: number, keep: (s: string) => boolean = () => true): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && keep(item) && !out.includes(item)) out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseView(v: unknown): ViewState | null {
  if (!isRecord(v)) return null;
  const line = finite(v.line);
  const column = finite(v.column);
  const scrollTop = finite(v.scrollTop);
  if (line === null || column === null || scrollTop === null) return null;
  return {
    line: Math.max(1, Math.floor(line)),
    column: Math.max(1, Math.floor(column)),
    scrollTop: Math.max(0, scrollTop),
  };
}

function parseLayout(v: unknown): ScopeLayout {
  if (!isRecord(v)) return EMPTY_LAYOUT;
  const tabs = stringList(v.tabs, MAX_TABS, (id) => parseTabId(id) !== null);
  const active = typeof v.active === "string" && tabs.includes(v.active) ? v.active : (tabs[0] ?? null);
  const views: Record<string, ViewState> = {};
  if (isRecord(v.views)) {
    // Only an editor tab has a cursor; a view stored under another kind is dropped.
    for (const id of tabs) {
      const view = parseTabId(id)?.kind === "editor" ? parseView(v.views[id]) : null;
      if (view) views[id] = view;
    }
  }
  const visited = Math.max(0, finite(v.visited) ?? 0);
  return { expanded: stringList(v.expanded, MAX_EXPANDED), tabs, active, views, visited };
}

function parseBaseline(v: unknown): Baseline | null {
  if (!isRecord(v)) return null;
  const at = finite(v.at);
  if (typeof v.commit !== "string" || !v.commit || at === null || typeof v.clean !== "boolean") return null;
  return { commit: v.commit, at, clean: v.clean };
}

/** Keep at most `MAX_SCOPES` layouts, the most recently visited first; Home always survives. */
function capScopes(scopes: Record<string, ScopeLayout>): Record<string, ScopeLayout> {
  const keys = Object.keys(scopes);
  if (keys.length <= MAX_SCOPES) return scopes;
  const ranked = keys
    .filter((k) => k !== HOME_KEY)
    .sort((a, b) => scopes[b].visited - scopes[a].visited || a.localeCompare(b));
  const room = MAX_SCOPES - (HOME_KEY in scopes ? 1 : 0);
  const kept = new Set(ranked.slice(0, room));
  const out: Record<string, ScopeLayout> = {};
  for (const k of keys) if (k === HOME_KEY || kept.has(k)) out[k] = scopes[k];
  return out;
}

/**
 * Parse stored state text. A missing file (null text, no error) is a silent
 * fresh start. A load error, malformed text, a non-object, or a file of
 * another version (including version 1) also yields the empty state, but
 * with `fallback` naming why, so the notice line can say alabs started
 * fresh and the reason can be logged. A damaged file never blocks startup.
 */
export function parseState(text: string | null | undefined, loadError: string | null = null): ParsedState {
  if (loadError !== null) return { state: EMPTY_STATE, fallback: `saved layout could not be read: ${loadError}` };
  if (!text) return { state: EMPTY_STATE, fallback: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: EMPTY_STATE, fallback: "saved layout is not valid JSON" };
  }
  if (!isRecord(raw)) return { state: EMPTY_STATE, fallback: "saved layout is not an object" };
  if (raw.version !== STATE_VERSION) {
    const version = typeof raw.version === "number" ? String(raw.version) : "unknown";
    return { state: EMPTY_STATE, fallback: `saved layout is version ${version}, this alabs uses version ${STATE_VERSION}` };
  }
  const root = typeof raw.root === "string" && raw.root.startsWith("/") ? raw.root : null;
  const activeWork = root !== null && typeof raw.activeWork === "string" && isPlaceName(raw.activeWork) ? raw.activeWork : null;
  const scopes: Record<string, ScopeLayout> = {};
  if (root !== null && isRecord(raw.scopes)) {
    for (const [key, value] of Object.entries(raw.scopes)) {
      if (isScopeKey(key)) scopes[key] = parseLayout(value);
    }
  }
  const baselines: Record<string, Baseline> = {};
  if (root !== null && isRecord(raw.baselines)) {
    for (const [place, value] of Object.entries(raw.baselines)) {
      const baseline = parseBaseline(value);
      if (isPlaceName(place) && baseline) baselines[place] = baseline;
    }
  }
  const localModel = typeof raw.localModel === "string" && raw.localModel.trim() !== "" ? raw.localModel : null;
  return { state: { version: STATE_VERSION, root, activeWork, scopes: capScopes(scopes), baselines, localModel }, fallback: null };
}

export function serializeState(state: UiState): string {
  return JSON.stringify(state);
}

/** The remembered layout of one scope, or the empty layout. */
export function scopeLayout(state: UiState, key: ScopeKey): ScopeLayout {
  return state.scopes[key] ?? EMPTY_LAYOUT;
}

/** Replace the remembered layout of one scope, applying the per-scope and scope-count caps. */
export function setScopeLayout(state: UiState, key: ScopeKey, layout: ScopeLayout): UiState {
  const tabs = layout.tabs.filter((id) => parseTabId(id) !== null).slice(0, MAX_TABS);
  const views: Record<string, ViewState> = {};
  for (const id of tabs) if (layout.views[id]) views[id] = layout.views[id];
  const capped: ScopeLayout = {
    expanded: layout.expanded.slice(0, MAX_EXPANDED),
    tabs,
    active: layout.active !== null && tabs.includes(layout.active) ? layout.active : null,
    views,
    visited: layout.visited,
  };
  return { ...state, scopes: capScopes({ ...state.scopes, [key]: capped }) };
}

/**
 * Remember `root` as the alabs root. Layouts and baselines belong to the
 * root they were made in, so a different root starts with none.
 */
export function setRoot(state: UiState, root: string): UiState {
  if (state.root === root) return state;
  return { ...state, root, activeWork: null, scopes: {}, baselines: {} };
}

/** Record the handoff baseline of one work place, replacing any earlier one for that place. */
export function setBaseline(state: UiState, place: string, baseline: Baseline): UiState {
  return { ...state, baselines: { ...state.baselines, [place]: baseline } };
}

/** Remember the chosen local model, or forget it when Ollama no longer lists it. */
export function setLocalModel(state: UiState, localModel: string | null): UiState {
  return state.localModel === localModel ? state : { ...state, localModel };
}

export function setActiveWork(state: UiState, activeWork: string | null): UiState {
  return state.activeWork === activeWork ? state : { ...state, activeWork };
}

/** Last path segment of an absolute path, for display. */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || path;
}
