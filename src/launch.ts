/**
 * What alabs does when it opens, as one plain sequence so it can be tested
 * without React: read its own state file, open the remembered root, list the
 * root for Home. No place's tabs are read here; a place restores on its
 * first visit. With no remembered root nothing but the state file is read.
 */
import { classifyRoot, rootViewJsonPath, rootViewPath, visualViewPath, type RootListing } from "./places";
import { readSavedRootMap, type RootMap } from "./rootMap";
import type { Bootstrap } from "./runtime";
import type { Entry, EntryKind, RootInfo } from "./subject";
import { parseState, serializeState, setRoot, type UiState } from "./uiState";

export interface LaunchIo {
  /** What the runtime settles first: the root it owns, if it owns one. */
  bootstrap: () => Promise<Bootstrap>;
  loadUiState: () => Promise<string | null>;
  openRoot: (path: string) => Promise<RootInfo>;
  listDir: (relPath: string) => Promise<Entry[]>;
  entryKind: (relPath: string) => Promise<EntryKind>;
  /** One bounded read, used only for `views/.root/view.json` when the root map exists. */
  readFile: (relPath: string) => Promise<{ content: string }>;
}

/** What Home knows of the root Visual View: whether `views/.root/map.svg` exists, and the saved facts beside it when they read as a root map. */
export interface RootViewState {
  exists: boolean;
  saved: RootMap | null;
}

/** What a work place's `.git` entry is, from one existence check: a real repository folder, a file or link, or absent. */
export type GitKind = "repo" | "linked" | "none";

export interface HomeData {
  listing: RootListing;
  /** Work places that have a Visual View file, `views/<name>/map.svg`. */
  views: ReadonlySet<string>;
  /** The `.git` kind per work place. A place not listed here has none. */
  git: ReadonlyMap<string, GitKind>;
  /** The root Visual View (the Home map), from one existence check and, when it exists, one read of its `view.json`. */
  rootView: RootViewState;
}

export interface LaunchResult {
  ui: UiState;
  /** False when this runtime cannot write; the editor opens read-only. */
  canEdit: boolean;
  /** What the runtime calls the process alabs is talking to; null when there is none. */
  serverId: string | null;
  /**
   * True when the runtime named the root itself, so alabs cannot be pointed
   * at another folder while it runs. One `alabs-serve` process owns one root;
   * the desktop application lets the user choose.
   */
  ownsRoot: boolean;
  /** The stored text when it was byte-identical to what this version writes, else null. */
  written: string | null;
  /** Technical reason the saved layout was not used, or null. */
  fallback: string | null;
  root: RootInfo | null;
  /** Set when a remembered root could not be opened: the real path and the raw reason. */
  rootFailure: { path: string; reason: string } | null;
  home: HomeData | null;
  /** Raw reason the root listing failed, or null. */
  homeError: string | null;
  /** Raw reason the runtime could not be asked what it owns, or null. */
  bootstrapError: string | null;
}

/**
 * Read the Home data for the open root: one root listing plus, per work
 * place, one existence check for its Visual View (`views/<name>/map.svg`) and one for its `.git`
 * (BUILD_PLAN premise 9); then one existence check for the root map
 * (`views/.root/map.svg`) and, when it exists, one read of `views/.root/view.json`
 * for the inspector and the structural stale check. Rejects only when the
 * listing itself fails; a failed check counts as no view, no repository or
 * no root map, and an unreadable `view.json` as no saved facts. Git itself
 * never runs here and no model is ever called.
 */
export async function readHome(io: Pick<LaunchIo, "listDir" | "entryKind" | "readFile">): Promise<HomeData> {
  const listing = classifyRoot(await io.listDir(""));
  const views = new Set<string>();
  const git = new Map<string, GitKind>();
  const rootView: RootViewState = { exists: false, saved: null };
  await Promise.all([
    ...listing.work.map(async (place) => {
      const [view, dotGit] = await Promise.all([
        io.entryKind(visualViewPath(place.name)).catch(() => "none" as const),
        io.entryKind(`${place.name}/.git`).catch(() => "none" as const),
      ]);
      if (view === "file") views.add(place.name);
      if (dotGit === "dir") git.set(place.name, "repo");
      else if (dotGit === "file") git.set(place.name, "linked");
    }),
    (async () => {
      const kind = await io.entryKind(rootViewPath()).catch(() => "none" as const);
      if (kind !== "file") return;
      rootView.exists = true;
      try {
        rootView.saved = readSavedRootMap((await io.readFile(rootViewJsonPath())).content);
      } catch {
        rootView.saved = null;
      }
    })(),
  ]);
  return { listing, views, git, rootView };
}

export async function launch(io: LaunchIo): Promise<LaunchResult> {
  // What the runtime owns is settled before the state file is read, so a
  // remembered root can never be opened in a runtime that fixes its own.
  let runtime: Bootstrap = { root: null, canEdit: true, serverId: null };
  let bootstrapError: string | null = null;
  try {
    runtime = await io.bootstrap();
  } catch (err) {
    bootstrapError = String(err);
  }
  let text: string | null = null;
  let loadError: string | null = null;
  try {
    text = await io.loadUiState();
  } catch (err) {
    loadError = String(err);
  }
  const { state, fallback } = parseState(text, loadError);
  const written = text !== null && loadError === null && serializeState(state) === text ? text : null;
  const result: LaunchResult = {
    ui: state,
    canEdit: runtime.canEdit,
    serverId: runtime.serverId,
    ownsRoot: runtime.root !== null,
    written,
    fallback,
    root: null,
    rootFailure: null,
    home: null,
    homeError: null,
    bootstrapError,
  };
  if (bootstrapError !== null) return result;
  if (runtime.root !== null) {
    // The runtime's root, not the remembered one. `setRoot` drops layouts and
    // baselines when they belong to a different root, so a state file written
    // against another root cannot describe this one.
    result.root = runtime.root;
    result.ui = setRoot(state, runtime.root.path);
    if (result.ui !== state) result.written = null;
  } else {
    if (state.root === null) return result;
    try {
      result.root = await io.openRoot(state.root);
    } catch (err) {
      result.rootFailure = { path: state.root, reason: String(err) };
      return result;
    }
  }
  try {
    result.home = await readHome(io);
  } catch (err) {
    result.homeError = String(err);
  }
  return result;
}
