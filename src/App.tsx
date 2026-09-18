import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { editor as monacoEditor, KeyCode, KeyMod, Uri } from "monaco-editor";
import { host, type Editing } from "./runtime";
import { FileTree } from "./FileTree";
import { Rail, type LivePlace } from "./Rail";
import { HomeBody, HomeSidebar } from "./Home";
import { Overview } from "./Overview";
import { MarkdownView } from "./MarkdownView";
import { VisualView } from "./VisualView";
import { buildView, ViewQueue, type BuildOutcome, type BuildState } from "./viewBuild";
import { viewIoForSession } from "./viewSession";
import { buildRootView, ROOT_BUILD_KEY, type RootBuildOutcome } from "./rootBuild";
import { RAVEN } from "./creatures";
import { TaskView } from "./TaskView";
import { ChangesView } from "./ChangesView";
import { languageForFile } from "./language";
import {
  createDir,
  createFile,
  entryKind,
  gitQuery,
  listDir,
  loadUiState,
  moveItem,
  openRoot,
  openTerminal,
  pickFolder,
  quit,
  readFile,
  recreateFile,
  saveFile,
  saveUiState,
  statFile,
  trashItem,
  type Entry,
  type FileStamp,
  type GitInspection,
  viewSession,
  type RootInfo,
} from "./subject";
import { approvalHolds, cleanApproval, discardApproval, unapproved, type Approval } from "./approval";
import {
  activateTab,
  activeTab,
  closeTab,
  closeTabsUnder,
  destinationCollision,
  editorId,
  EMPTY_TABS,
  findEditorTab,
  findTab,
  idOf,
  isAtOrUnder,
  kindOf,
  movedPath,
  moveTabs,
  openTab,
  parseId,
  reconcileOutcome,
  stampsEqual,
  tabIdOf,
  updateTab,
  type DiskState,
  type Tab,
  type TabId,
  type TabKind,
} from "./tabs";
import {
  parseTabId,
  scopeLayout,
  serializeState,
  setActiveWork as rememberActiveWork,
  setBaseline,
  setLocalModel,
  setRoot as rememberRoot,
  setScopeLayout,
  type ScopeLayout,
  type UiState,
  type ViewState,
} from "./uiState";
import {
  displayPath,
  HOME_KEY,
  isPlaceName,
  knowKey,
  ownerOfPath,
  roleInfo,
  ROLES,
  viewPlaceOf,
  visualViewPath,
  workKey,
  type Role,
  type RootListing,
  type ScopeKey,
} from "./places";
import {
  addScope,
  allTabs,
  commit,
  freshScopes,
  knowScope,
  liveModelCount,
  placeStatus,
  scopeCounts,
  workScope,
  type PlaceStatus,
  type Scope,
  type Scopes,
} from "./scopeState";
import { defaultTabKind, materialize, materializeDraft, type MaterializeResult } from "./openPath";
import { callFailure } from "./callFailure";
import { mergeDrafts, Recorder, type Draft, type DraftListing, type DraftState } from "./recovery";
import { contextCandidates, copyBlocker, selectedContext, taskPacket, type TaskDraft } from "./task";
import { whereGitText } from "./overviewFacts";
import { launch, readHome, type HomeData, type RootViewState } from "./launch";
import {
  copyFailedNotice,
  draftNotKeptNotice,
  draftsWaitingNotice,
  editingHereNotice,
  failureNotice,
  isTaskBlockedNotice,
  notEditingNotice,
  outsidePlaceNotice,
  placeMissingNotice,
  refreshNotice,
  roleConflictText,
  rootOpenNotice,
  stateFallbackNotice,
  summaryNotice,
  taskBlockedNotice,
  taskCopiedNotice,
  terminalFailedNotice,
  tooManyOpenFilesNotice,
  uncertainSaveNotice,
  type Notice,
} from "./notices";
import { log } from "./log";
import "./App.css";

/**
 * How long after the last keystroke a buffer is written as a draft. Long
 * enough that typing does not copy the whole buffer out of the editor every
 * keystroke, short enough that a pause is all it takes to be kept.
 */
const DRAFT_DELAY = 400;

type UnsavedChoice = "save" | "discard" | "cancel";

interface UnsavedPrompt {
  name: string;
  resolve: (choice: UnsavedChoice) => void;
}

/** Asks whether a file that vanished from disk should be recreated at its path. */
interface RecreatePrompt {
  relPath: string;
  resolve: (recreate: boolean) => void;
}

/** Asks the user to confirm moving `entry` to the Trash; `error` reports a failed attempt. */
interface DeletePrompt {
  entry: Entry;
  error: string | null;
  resolve: (confirmed: boolean) => void;
}

/** Last path segment of a root-relative path. */
function baseName(relPath: string): string {
  return relPath.split("/").pop() ?? relPath;
}

type NamePrompt =
  /** Create a new item inside `parent`, a root-relative folder inside the active place. */
  | { kind: "file" | "folder"; parent: string }
  /** Create a new work folder directly inside the root (Home). */
  | { kind: "place" }
  /** Rename `entry` in place. */
  | { kind: "rename"; entry: Entry }
  /** Move `entry` into another folder, typed as a place-relative path. */
  | { kind: "move"; entry: Entry };

/** Root-relative parent folder of `relPath`; "" is the root. */
function parentOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? "" : relPath.slice(0, i);
}

/** Normalize a typed destination folder: trim and drop surrounding slashes. */
function cleanFolderPath(text: string): string {
  return text.trim().replace(/^\/+|\/+$/g, "");
}

/** Stable Monaco model identity for a real file: one URI per file in the root. */
function modelUri(rootPath: string, relPath: string): Uri {
  return Uri.file(`${rootPath}/${relPath}`);
}

function disposeModel(uri: Uri) {
  monacoEditor.getModel(uri)?.dispose();
}

/** Root-relative path of a Monaco model that belongs to `rootPath`, or null. */
function relOfModel(rootPath: string, model: monacoEditor.ITextModel): string | null {
  const prefix = `${rootPath}/`;
  if (model.uri.scheme !== "file" || !model.uri.path.startsWith(prefix)) return null;
  return model.uri.path.slice(prefix.length);
}

/** `parent/name`, or just `name` at the root. */
function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** The remembered layout of a live scope: tab ids (`kind:path`) and view numbers only. */
function layoutOf(scope: Scope, visited: number): ScopeLayout {
  const tabs = scope.tabs.tabs.map(idOf);
  const views: Record<string, ViewState> = {};
  for (const t of scope.tabs.tabs) if (t.kind === "loaded" && scope.views[t.relPath]) views[editorId(t.relPath)] = scope.views[t.relPath];
  return {
    expanded: [...scope.expanded],
    tabs,
    active: scope.tabs.active,
    views,
    visited,
  };
}

/** Tabs remembered for a scope, in strip order, with the editor views keyed by path. Unknown kinds were dropped by the parser. */
function rememberedTabs(layout: ScopeLayout): {
  tabs: Array<{ kind: TabKind; path: string }>;
  active: TabId | null;
  views: Record<string, ViewState>;
} {
  const tabs: Array<{ kind: TabKind; path: string }> = [];
  const views: Record<string, ViewState> = {};
  for (const id of layout.tabs) {
    const parsed = parseTabId(id);
    if (!parsed) continue;
    tabs.push({ kind: parsed.kind, path: parsed.path });
    if (parsed.kind === "editor" && layout.views[id]) views[parsed.path] = layout.views[id];
  }
  const active = layout.active !== null && layout.tabs.includes(layout.active) && parseTabId(layout.active) ? layout.active : null;
  return { tabs, active, views };
}

/** A Markdown tab for a real file: a rendered view, no buffer. */
function markdownTab(relPath: string): Tab {
  return { kind: "markdown", relPath, name: baseName(relPath) };
}

/** A Visual View tab for `views/<place>/map.svg`: no buffer; named after the place, shown after the `view` tag. */
function viewTab(relPath: string): Tab {
  return { kind: "view", relPath, name: viewPlaceOf(relPath) ?? baseName(relPath) };
}

const NO_TIMINGS: BuildOutcome["timings"] = { evidence: null, model: null, validate: null, render: null, total: 0 };
const NO_ROOT_TIMINGS: RootBuildOutcome["timings"] = { evidence: null, model: null, validate: null, render: null, total: 0 };

/** What one queue key builds: a work place's view, or the root view. */
type QueuedOutcome = BuildOutcome | RootBuildOutcome;

/** The place's Task or Changes tab (Step 6): belongs to the place's folder, no buffer, no file. */
function surfaceTab(kind: "task" | "changes", prefix: string): Tab {
  return { kind, relPath: prefix, name: kind === "task" ? "Task" : "Changes" };
}

/** The loaded editor tab shown by a scope, if the active tab is one. */
function shownEditor(scope: Scope): Extract<Tab, { kind: "loaded" }> | undefined {
  const tab = activeTab(scope.tabs);
  return tab?.kind === "loaded" ? tab : undefined;
}

/** The actions the shell wires to its controls, handed to tests so they drive the same code paths as clicks. */
export interface AppActions {
  /** Enter a work place; resolves once its remembered tabs are restored (at once when they already are). */
  enterPlace: (name: string) => Promise<void>;
  /** Enter a work place and show its Visual View tab (the Home node's `◫ visual view` target). */
  openVisualView: (name: string) => Promise<void>;
  /** `Rebuild view`: queue an explicit rebuild of a work place's Visual View; needs a chosen local model. */
  /** Start Raven on one work place: an explicit build or rebuild of its Visual View with Raven's model. */
  runRaven: (place: string) => void;
  /** `Rebuild root view`: queue an explicit rebuild of the Home map; needs a chosen local model. */
  /** Start Raven on the root: an explicit build or rebuild of the Home map with Raven's model. */
  runRavenRoot: () => void;
  enterRole: (role: Role) => void;
  /** Click on a not-created knowledge row: create the default folder, then enter it. */
  createRole: (role: Role) => Promise<void>;
  goHome: () => void;
  changeRoot: () => Promise<void>;
  /** Open a real file; `.md` renders unless `kind` says `editor` (Open source) or a `line` is given; `view` opens a Visual View tab. */
  openPath: (relPath: string, line?: number | null, kind?: TabKind) => Promise<void>;
  showTab: (id: TabId) => void;
  showOverview: () => void;
  requestClose: (id: TabId) => Promise<void>;
  closeActiveTab: () => Promise<void>;
  saveActive: () => void;
  refresh: () => Promise<void>;
  requestQuit: () => Promise<void>;
  /** Rename `entry` inside its place; resolves to the modal's error line, or null when done. */
  renameEntry: (entry: Entry, name: string) => Promise<string | null>;
  /** Move `entry` into `folder`, typed relative to the place; same result shape. */
  moveEntry: (entry: Entry, folder: string) => Promise<string | null>;
  /** Open or select the active work place's Task or Changes tab (the Overview actions). */
  openTask: () => void;
  openChanges: () => void;
  /** Change the active work place's task draft. */
  setTaskDraft: (update: (draft: TaskDraft) => TaskDraft) => void;
  /** `Copy task packet` for the active work place; resolves once the copy and the baseline record are done. */
  copyTaskPacket: () => Promise<void>;
  /** `Open in Terminal` for the active work place; resolves once `open` has answered. */
  openTerminal: () => Promise<void>;
  /** Remember (or, with null, forget) the local model chosen in the Wiki's `Ask local model` section. */
  selectLocalModel: (name: string | null) => void;
  /** The editor's content-change handler: recomputes the shown tab's unsaved flag from its model version. */
  modelChanged: () => void;
  /** Settle who edits and find what was kept, for the root open now. */
  beginEditing: () => Promise<void>;
  /** Ask to be the window that edits; `true` is the user's explicit takeover. */
  takeOverEditing: (takeOver: boolean) => Promise<void>;
  /** Open one kept draft for review. Nothing is written to a file. */
  reviewDraft: (draft: Draft) => Promise<void>;
  /** Throw one kept draft away, on the user's say-so. */
  discardDraft: (draft: Draft) => void;
  /** Hand the newest text of one draft to the user as a file. */
  exportDraft: (relPath: string, contents?: string | null) => void;
  /** Keep the buffer now rather than after the usual pause; returns its revision. */
  keepDraftNow: (relPath: string) => number | null;
  /** The window key handler, for the shortcuts in DESIGN.md section 8. */
  handleKey: (e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "preventDefault">) => void;
  /** The live records as the transitions see them, for tests that render once. */
  snapshot: () => {
    /** True when this window is the one that may change files. */
    writing: boolean;
    /** How far each file's unsaved work has got, by path. */
    drafts: ReadonlyMap<string, DraftState>;
    activeKey: ScopeKey;
    activeWork: string | null;
    scopes: Scopes;
    listing: RootListing | null;
    baselines: UiState["baselines"];
    localModel: string | null;
    /** What the Visual View build queue knows per work place this session. */
    builds: ReadonlyMap<string, BuildState>;
    /** Work places whose `views/<place>/map.svg` Home knows to exist. */
    views: ReadonlySet<string>;
    /** What Home knows of the root Visual View, or null before the root is read. */
    rootView: RootViewState | null;
    /** Bumped when the root map should be re-read (Refresh, a finished root build). */
    rootReload: number;
  };
}

/** Seeded state for tests, where React effects do not run. Production passes nothing and launches. */
export interface AppInitial {
  ui: UiState;
  root: RootInfo | null;
  home: HomeData | null;
  /** Receives the shell's actions during render. */
  actions?: (actions: AppActions) => void;
  /**
   * The editing seam to use instead of the runtime's, so a test can drive the
   * one-writer rule and recovery without a server. `null` is a runtime that
   * shares neither, as the desktop application does.
   */
  editing?: Editing | null;
  /** The process identity a seeded runtime reports; recovery records carry it. */
  serverId?: string | null;
  /** Observes the unsaved-changes question so a test can answer it. */
  onUnsavedPrompt?: (name: string, resolve: (choice: UnsavedChoice) => void) => void;
}

function App({ initial }: { initial?: AppInitial } = {}) {
  const [root, setRoot] = useState<RootInfo | null>(initial?.root ?? null);
  const [home, setHome] = useState<HomeData | null>(initial?.home ?? null);
  const [homeLoading, setHomeLoading] = useState(false);
  const [scopes, setScopes] = useState<Scopes>(freshScopes);
  const [activeKey, setActiveKey] = useState<ScopeKey>(HOME_KEY);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [prompt, setPrompt] = useState<UnsavedPrompt | null>(null);
  const [recreatePrompt, setRecreatePrompt] = useState<RecreatePrompt | null>(null);
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null);
  const [newName, setNewName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt | null>(null);
  /** A position to reveal once the tab for `relPath` is showing; set by a search hit or a restore. */
  const [reveal, setReveal] = useState<({ relPath: string } & Partial<ViewState>) | null>(null);
  /** Disposable local UI state, loaded once at launch from the app data directory. */
  const [ui, setUi] = useState<UiState>(initial?.ui ?? { version: 2, root: null, activeWork: null, scopes: {}, baselines: {}, localModel: null });
  const [uiLoaded, setUiLoaded] = useState(initial !== undefined);
  /**
   * The window lock: interaction and layout persistence pause while a place's
   * remembered tabs are read and while the root is being replaced.
   */
  const [locked, setLocked] = useState(false);
  const lockRef = useRef(false);
  /**
   * Whether this runtime can write at all (`runtime.ts`). False leaves the
   * editor read-only, so a buffer never fills with edits that have nowhere to
   * go. Which *window* may write is `writing` below; this is about the
   * runtime itself.
   */
  const [canEdit, setCanEdit] = useState(true);
  const canEditRef = useRef(true);
  /**
   * Whether the root can be changed from inside alabs. False when the runtime
   * named it (one `alabs-serve` process owns one folder): the rail says so
   * instead of offering a picker that could only refuse.
   */
  const [ownsRoot, setOwnsRoot] = useState(false);
  /**
   * Whether this window is the one that may change files. One window per
   * server edits; the others open read-only until the user takes over. A
   * runtime with no such rule (the desktop application) is always this one.
   */
  const [writing, setWriting] = useState(true);
  const writingRef = useRef(true);
  /**
   * What alabs is keeping of unsaved work, or null in a runtime that keeps
   * none. Created once the root is known, because a draft belongs to a root.
   */
  const recorderRef = useRef<Recorder | null>(null);
  /** How far each file's unsaved work has got; mirrors the recorder for rendering. */
  const [drafts, setDrafts] = useState<ReadonlyMap<string, DraftState>>(new Map());
  /** Unsaved work found at launch, waiting to be looked at. Nothing is written from here. */
  const [waiting, setWaiting] = useState<DraftListing | null>(null);
  /** What the lock is for, shown in the notice line. */
  const [lockText, setLockText] = useState<string | null>(null);
  /** Bumped when the editor mounts, so a pending reveal can be applied to it. */
  const [editorReady, setEditorReady] = useState(0);
  /** Bumped by Cmd+Shift+F so the open Search input takes focus. */
  const [searchFocus, setSearchFocus] = useState(0);
  /** What the Visual View build queue knows per work place this session; mirrors the queue for rendering. */
  const [builds, setBuilds] = useState<ReadonlyMap<string, BuildState>>(new Map());
  /** Bumped when the root map should be re-read by the Home canvas. */
  const [rootReload, setRootReload] = useState(0);
  const rootReloadRef = useRef(0);

  /**
   * The editing seam: the runtime's, unless a test seeded one of its own.
   * Read through a ref so every later call sees the same object.
   */
  const editingRef = useRef<Editing | null>(initial && "editing" in initial ? (initial.editing ?? null) : host.editing);
  /** What the runtime calls the process alabs is talking to; recovery records carry it. */
  const serverIdRef = useRef<string | null>(initial?.serverId ?? null);
  const rootRef = useRef(root);
  const homeRef = useRef(home);
  const scopesRef = useRef(scopes);
  const activeKeyRef = useRef(activeKey);
  const uiRef = useRef(ui);
  const savingRef = useRef(false);
  const refreshingRef = useRef(false);
  /** True while a modal question (unsaved changes, recreate) is waiting for an answer. */
  const askingRef = useRef(false);
  /**
   * True while a destructive transition (close, root change, quit, Trash)
   * is running. Only one runs at a time, so two flows can never race over
   * the same buffer.
   */
  const transitionRef = useRef(false);
  /** Serialized UI state as last written, so an unchanged layout is not rewritten. */
  const lastWrittenRef = useRef<string | null>(null);
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  /** Last visit time per scope key this session, for the remembered-layout order. */
  const visitedRef = useRef<Record<string, number>>({});
  /** Paths whose buffer has changed and whose draft has not been written yet. */
  const draftPendingRef = useRef(new Set<string>());
  const draftTimerRef = useRef<number | null>(null);
  /** Paths already said out loud to be unkept, so it is said once and not per keystroke. */
  const draftWarnedRef = useRef(new Set<string>());
  /** The open modals, for the one Escape handler. */
  const modalsRef = useRef({ prompt, recreatePrompt, namePrompt, deletePrompt });
  rootRef.current = root;
  homeRef.current = home;
  scopesRef.current = scopes;
  activeKeyRef.current = activeKey;
  uiRef.current = ui;
  modalsRef.current = { prompt, recreatePrompt, namePrompt, deletePrompt };

  /** The refs are the source of truth for every transition; the state mirrors them for rendering. */
  const setScopesNow = (next: Scopes) => {
    scopesRef.current = next;
    setScopes(next);
  };

  /** The one guarded scope update: a stale completion (scope or target gone) changes nothing. */
  const updateScope = (key: ScopeKey, target: string | null, update: (scope: Scope) => Scope) => {
    setScopesNow(commit(scopesRef.current, key, target, update));
  };

  const setUiNow = (next: UiState) => {
    uiRef.current = next;
    setUi(next);
  };

  const show = (n: Notice, rootPath: string | null = rootRef.current?.path ?? null) => {
    setNotice(n);
    if (n.log !== null) void log(n.error ? "error" : "info", n.log, rootPath);
  };

  /**
   * Every refused action lands here. One of them is not really a refusal of
   * what was asked: another window holds editing, and this one has only just
   * found out. That is a state to move into, not a failure to report.
   */
  const fail = (reason: unknown) => {
    if (callFailure(reason) === "not-writing") return lostWriting();
    show(failureNotice(reason));
  };

  /** Whether a live scope's folder is in the root, from the last root listing. */
  const statusOf = (scope: Scope): PlaceStatus => placeStatus(scope, homeRef.current?.listing ?? null);

  /**
   * The editor is writable only when this runtime can write at all, this
   * window is the one editing, and nothing has the window locked. All three,
   * every time: this is the one place that decides.
   */
  const applyEditorMode = () => {
    editorRef.current?.updateOptions({ readOnly: lockRef.current || !canEditRef.current || !writingRef.current });
  };

  const setLock = (on: boolean, text: string | null) => {
    lockRef.current = on;
    setLocked(on);
    setLockText(on ? text : null);
    applyEditorMode();
  };

  /** Record which window is editing, and put the editor into that state. */
  const setWritingNow = (on: boolean) => {
    writingRef.current = on;
    setWriting(on);
    applyEditorMode();
  };

  /**
   * A change was refused because another window holds editing. The window
   * that asked did not know; it does now, and stops offering to write.
   * Nothing is retried and nothing is taken back from the other window.
   */
  const lostWriting = () => {
    if (writingRef.current) show(notEditingNotice());
    setWritingNow(false);
  };

  /**
   * The user asked to edit here. `takeOver` is their explicit answer to
   * another window already editing; without it nothing another window is
   * doing is disturbed. The server waits for any change already running
   * there before the answer comes back.
   */
  const takeOverEditing = async (takeOver: boolean) => {
    const editing = editingRef.current;
    if (!editing) return;
    try {
      const writer = await editing.claim(takeOver);
      setWritingNow(writer.writing);
      show(writer.writing ? editingHereNotice(true) : notEditingNotice());
    } catch (err) {
      fail(err);
    }
  };

  /**
   * The explicit Raven build queue: one
   * in-memory FIFO, one build at a time, created once and reached through
   * refs so its completions see the live root, model and scopes. Root
   * transitions invalidate every later step. Native session checks also
   * protect delayed commands and serialize pair commits with root changes.
   */
  const queueRef = useRef<ViewQueue<QueuedOutcome> | null>(null);
  if (queueRef.current === null) {
    queueRef.current = new ViewQueue<QueuedOutcome>(
      async (place, isCurrent) => {
        // Every build is a Raven run, started by the user, with Raven's model; an existing map is replaced only after every check passed.
        const current = rootRef.current;
        if (!current) return { kind: "failed", reason: "root_changed", timings: NO_TIMINGS };
        const session = await viewSession(current.path);
        if (!isCurrent()) return { kind: "failed", reason: "root_changed", timings: NO_TIMINGS };
        const io = viewIoForSession(session, isCurrent);
        if (place === ROOT_BUILD_KEY) {
          // The root view: built from Home's data as it is when its turn comes, so the child views finished before it count.
          const h = homeRef.current;
          if (!h) return { kind: "failed", reason: "root_changed", timings: NO_ROOT_TIMINGS };
          return buildRootView(io, { root: current.path, model: RAVEN.model, replace: true, home: h });
        }
        return buildView(io, { place, root: current.path, model: RAVEN.model, replace: true });
      },
      (place, state, outcome) => {
        setBuilds(queueRef.current?.snapshot() ?? new Map());
        if (place === ROOT_BUILD_KEY) {
          if (state.kind === "queued") void log("info", "root view: queued");
          if (outcome === null) return;
          if (outcome.kind === "failed") {
            void log("warn", `root view: failed · ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}`);
            return;
          }
          if (!("map" in outcome)) return;
          void log("info", `root view: built · ${Math.round(outcome.timings.total / 1000)} s · ${outcome.places} places`);
          // The smallest update that makes the root view available: Home's record of it, and a reread of the canvas.
          const h = homeRef.current;
          if (h) {
            const next: HomeData = { ...h, rootView: { exists: true, saved: outcome.map } };
            homeRef.current = next;
            setHome(next);
          }
          rootReloadRef.current += 1;
          setRootReload(rootReloadRef.current);
          return;
        }
        if (state.kind === "queued") void log("info", `view build: queued ${place}`);
        if (outcome === null) return;
        if (outcome.kind === "failed") {
          void log("warn", `view build: failed ${place} · ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}`);
          return;
        }
        if (!("calls" in outcome)) return;
        const seconds = Math.round(outcome.timings.total / 1000);
        void log("info", `view build: done ${place} · ${seconds} s · ${outcome.calls} model ${outcome.calls === 1 ? "call" : "calls"} · ${outcome.landmarks} landmarks · ${outcome.connections} connections`);
        // The smallest update that makes the view available: Home's view
        // set, and a reread for the place's open Visual View tab.
        const h = homeRef.current;
        if (h && !h.views.has(place)) {
          const next: HomeData = { ...h, views: new Set(h.views).add(place) };
          homeRef.current = next;
          setHome(next);
        }
        setScopesNow(commit(scopesRef.current, workKey(place), null, (s) => ({ ...s, surfaceReload: s.surfaceReload + 1 })));
      },
    );
  }

  /** `Run Raven` on a work place: build or rebuild its Visual View. The old map stays until the new one passed every check. Nothing but this click and `runRavenRoot` queues a build. */
  const runRaven = (place: string) => {
    if (lockRef.current) return;
    if (!writingRef.current) return show(notEditingNotice());
    queueRef.current?.enqueue(place);
  };

  /** `Run Raven` on Home: build or rebuild the root map from the current place set. The old files stay until the new ones passed every check. */
  const runRavenRoot = () => {
    if (lockRef.current) return;
    if (!writingRef.current) return show(notEditingNotice());
    queueRef.current?.enqueue(ROOT_BUILD_KEY);
  };

  /** Read Home: one root listing plus the view checks. Rejects when the listing fails. */
  const loadHome = async (): Promise<HomeData | null> => {
    setHomeLoading(true);
    try {
      const data = await readHome({ listDir, entryKind, readFile });
      rootReloadRef.current += 1;
      setRootReload(rootReloadRef.current);
      homeRef.current = data;
      setHome(data);
      return data;
    } catch (err) {
      show(failureNotice(err));
      return null;
    } finally {
      setHomeLoading(false);
    }
  };

  // Launch: read alabs' own state file, open the remembered root, list it for
  // Home. No place's tabs are read. Skipped when a test seeds the state.
  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    void launch({ bootstrap: () => host.bootstrap(), loadUiState, openRoot, listDir, entryKind, readFile }).then((result) => {
      if (cancelled) return;
      canEditRef.current = result.canEdit;
      setCanEdit(result.canEdit);
      setOwnsRoot(result.ownsRoot);
      setUiNow(result.ui);
      lastWrittenRef.current = result.written;
      if (result.fallback !== null) show(stateFallbackNotice(result.fallback), result.ui.root);
      // Said last so it wins: when the runtime itself could not be reached,
      // everything else that failed failed because of it, and saying the
      // layout was unreadable would name a consequence as the cause.
      if (result.bootstrapError !== null) show(failureNotice(result.bootstrapError));
      if (result.root) {
        rootRef.current = result.root;
        setRoot(result.root);
        homeRef.current = result.home;
        setHome(result.home);
        if (result.homeError !== null) show(failureNotice(result.homeError), result.root.path);
        // Who may write, and what was kept for this root, are settled after
        // the root is open: a draft belongs to a root, and asking earlier
        // would be asking about nothing.
        serverIdRef.current = result.serverId;
        void startEditing(result.root, result.serverId);
      } else if (result.rootFailure) {
        show(rootOpenNotice(result.rootFailure.path, result.rootFailure.reason), result.rootFailure.path);
      }
      setUiLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A seeded run skips the launch sequence, but not this: who may write and
  // what was kept are settled the same way, from the root it was seeded with.
  useEffect(() => {
    if (!initial?.root) return;
    void beginEditing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Hand editing back when this window goes.
   *
   * Without it, closing a tab would leave the next one read-only until the
   * user took over from a window that no longer exists. Nothing depends on
   * this arriving — a window that vanishes without a word is exactly what
   * "take over editing" is for — so it is a courtesy, not a protocol.
   */
  useEffect(() => {
    const editing = editingRef.current;
    if (!editing) return;
    const gone = () => {
      flushDrafts();
      if (writingRef.current) void editing.release().catch(() => {});
    };
    // Coming back from the browser's back/forward cache is the same page, so
    // it asks for editing again rather than sitting read-only.
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) void takeOverEditing(false);
    };
    window.addEventListener("pagehide", gone);
    window.addEventListener("pageshow", back);
    return () => {
      window.removeEventListener("pagehide", gone);
      window.removeEventListener("pageshow", back);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Record the shown editor's cursor and scroll into its scope, for the tab currently shown. */
  const captureView = useCallback(() => {
    const editor = editorRef.current;
    const key = activeKeyRef.current;
    const scope = scopesRef.current[key];
    const tab = scope ? shownEditor(scope) : undefined;
    if (!editor || !tab || !editor.getModel()) return;
    const path = tab.relPath;
    const position = editor.getPosition();
    if (!position) return;
    const view = { line: position.lineNumber, column: position.column, scrollTop: editor.getScrollTop() };
    setScopesNow(commit(scopesRef.current, key, editorId(path), (s) => ({ ...s, views: { ...s.views, [path]: view } })));
  }, []);

  /** Write the UI state now: root, active work, and the layout of every scope restored this session. */
  const flushUi = useCallback(async () => {
    captureView();
    let next = uiRef.current;
    const current = rootRef.current;
    if (current) {
      next = rememberRoot(next, current.path);
      for (const scope of Object.values(scopesRef.current)) {
        // A scope whose remembered tabs were not read yet keeps its remembered layout.
        if (!scope.restored) continue;
        next = setScopeLayout(next, scope.key, layoutOf(scope, visitedRef.current[scope.key] ?? 0));
      }
    }
    setUiNow(next);
    const text = serializeState(next);
    if (text === lastWrittenRef.current) return;
    try {
      await saveUiState(text);
      lastWrittenRef.current = text;
    } catch {
      // Losing disposable UI state is harmless; never block the user on it.
    }
  }, [captureView]);

  // Persist shortly after the layout changes. Nothing is written before the
  // stored state has been loaded, so a slow load cannot be overwritten by
  // defaults, and nothing is written while the window is locked, so a
  // half-restored layout never replaces the remembered one.
  const signature = Object.values(scopes)
    .map((s) => `${s.key}|${s.tabs.tabs.map(idOf).join(",")}|${s.tabs.active}|${[...s.expanded].join(",")}`)
    .join(";");
  useEffect(() => {
    if (!uiLoaded || locked) return;
    const timer = setTimeout(() => void flushUi(), 400);
    return () => clearTimeout(timer);
  }, [uiLoaded, locked, signature, activeKey, ui.activeWork, ui.baselines, ui.localModel, root, flushUi]);

  /** Live alternative version id of the model for `relPath`, or null when there is no model. */
  const liveVersion = (relPath: string): number | null => {
    const current = rootRef.current;
    if (!current) return null;
    return monacoEditor.getModel(modelUri(current.path, relPath))?.getAlternativeVersionId() ?? null;
  };

  /** The scope that owns an open editor tab at `relPath`, if any. */
  const scopeOfTab = (relPath: string): Scope | undefined =>
    Object.values(scopesRef.current).find((s) => findEditorTab(s.tabs, relPath) !== undefined);

  /** Saved and live versions of a loaded tab, for approval checks; null for other tabs. */
  const versionsOf = (relPath: string): { saved: number; live: number | null } | null => {
    const scope = scopeOfTab(relPath);
    const tab = scope ? findEditorTab(scope.tabs, relPath) : undefined;
    if (!tab || tab.kind !== "loaded") return null;
    return { saved: tab.savedVersion, live: liveVersion(relPath) };
  };

  /**
   * Run one destructive transition at a time. A second one started while the
   * first is still running is refused, never interleaved.
   */
  const runTransition = async (what: string, run: () => Promise<void>) => {
    if (transitionRef.current) {
      show(failureNotice(`${what}: another operation is still in progress`));
      return;
    }
    transitionRef.current = true;
    try {
      await run();
    } finally {
      transitionRef.current = false;
    }
  };

  /**
   * Ask one yes/no or three-way question in a modal. Only one question can be
   * open at a time; a second caller is refused with `null` instead of
   * replacing (and orphaning) the first.
   */
  const ask = useCallback(async <T,>(show: (resolve: (answer: T) => void) => void, hide: () => void): Promise<T | null> => {
    if (askingRef.current) return null;
    askingRef.current = true;
    try {
      return await new Promise<T>(show);
    } finally {
      hide();
      askingRef.current = false;
    }
  }, []);

  // -------------------------------------------------------------------
  // Unsaved work.
  //
  // Everything below exists so that editing in a browser tab is not a bet on
  // that tab staying open. A buffer that differs from its file becomes a
  // numbered draft, kept in the browser and in alabs' own folder; the draft
  // goes only when the file has been saved at that exact revision, or the
  // user threw it away. Nothing here ever writes inside the alabs root.
  // -------------------------------------------------------------------

  /** Mirror the recorder into state, so the tab strip and banners follow it. */
  const refreshDrafts = () => {
    const rec = recorderRef.current;
    if (!rec) return;
    const next = new Map<string, DraftState>();
    for (const path of rec.paths()) {
      const state = rec.state(path);
      if (state) next.set(path, state);
    }
    setDrafts(next);
  };

  /**
   * Say so, once, when unsaved work could not be kept anywhere. This is the
   * one thing recovery must never be quiet about: text that looks kept and is
   * not is worse than text the user knows is only in the tab.
   */
  const warnIfNotKept = () => {
    const rec = recorderRef.current;
    if (!rec) return;
    for (const path of rec.paths()) {
      const state = rec.state(path);
      if (!state || state.kept !== "pending" || state.trouble === null) {
        draftWarnedRef.current.delete(path);
        continue;
      }
      if (draftWarnedRef.current.has(path)) continue;
      draftWarnedRef.current.add(path);
      show(draftNotKeptNotice(path, state.trouble.reason));
    }
  };

  /**
   * Keep this buffer as a draft shortly. Called on every edit, so it waits
   * for a pause rather than copying the whole buffer out of the editor on
   * every keystroke.
   */
  const keepDraftSoon = (relPath: string) => {
    // Server-rendered action tests have no window; live hosts always do.
    if (!recorderRef.current || typeof window === "undefined") return;
    draftPendingRef.current.add(relPath);
    if (draftTimerRef.current !== null) return;
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      for (const path of [...draftPendingRef.current]) keepDraftNow(path);
    }, DRAFT_DELAY);
  };

  /**
   * Keep it now, and say which revision this text is: before a save, so the
   * draft is exactly what is being written, and before anything that may drop
   * the buffer. A buffer in step with its file has nothing unsaved, so its
   * draft is settled instead.
   */
  const keepDraftNow = (relPath: string): number | null => {
    const rec = recorderRef.current;
    const current = rootRef.current;
    draftPendingRef.current.delete(relPath);
    if (!rec || !current) return null;
    const model = monacoEditor.getModel(modelUri(current.path, relPath));
    const owner = allTabs(scopesRef.current).find((t) => t.relPath === relPath);
    const scope = owner ? scopesRef.current[owner.key] : undefined;
    const tab = scope ? findEditorTab(scope.tabs, relPath) : undefined;
    if (!model || !tab || tab.kind !== "loaded") return null;
    if (model.getAlternativeVersionId() === tab.savedVersion) {
      const had = rec.state(relPath);
      if (had) void rec.settle(relPath, had.revision);
      return null;
    }
    // A draft for a file that is not there records that, so restoring it
    // reaches the explicit Recreate rather than a save that cannot work.
    return rec.note(relPath, model.getValue(), tab.disk === "missing" ? null : tab.stamp);
  };

  /**
   * Write down every buffer whose draft is still waiting for the pause after
   * typing. Called where leaving is deliberate — switching place, closing the
   * window — so the last few keystrokes are not left to the timer. A window
   * that vanishes without warning still loses whatever was typed in the last
   * moment; nothing can promise otherwise.
   */
  const flushDrafts = () => {
    for (const path of [...draftPendingRef.current]) keepDraftNow(path);
  };

  /** That revision has been written, or thrown away on purpose. */
  const settleDraft = (relPath: string, revision: number | null) => {
    const rec = recorderRef.current;
    if (!rec) return;
    draftWarnedRef.current.delete(relPath);
    void rec.settle(relPath, revision ?? rec.state(relPath)?.revision ?? 0);
  };

  /**
   * Ask to be the window that edits, start keeping drafts for this root, and
   * find whatever was kept for it before.
   *
   * The claim is never a takeover: opening a second alabs tab must not quietly
   * stop the first one from saving. Drafts that are found are only *offered*;
   * nothing is written to a file until the user says so.
   */
  const startEditing = async (current: RootInfo, serverId: string | null) => {
    const editing = editingRef.current;
    if (!editing) return;
    try {
      const writer = await editing.claim(false);
      setWritingNow(writer.writing);
      if (!writer.writing) show(notEditingNotice());
    } catch (err) {
      // Not knowing whether this window may write means it may not.
      setWritingNow(false);
      show(failureNotice(err));
    }
    const rec = new Recorder({
      root: current.path,
      serverId,
      sessionId: editing.sessionId,
      browser: editing.browserDrafts,
      disk: editing.diskDrafts,
    });
    rec.changed = () => {
      refreshDrafts();
      warnIfNotKept();
    };
    recorderRef.current = rec;
    const unreadable = (where: string) => (err: unknown): DraftListing => ({
      drafts: [],
      unreadable: [`${where}: ${String(err)}`],
    });
    const [browser, disk] = await Promise.all([
      editing.browserDrafts.list(current.path).catch(unreadable("this browser's own storage")),
      editing.diskDrafts.list(current.path).catch(unreadable("the alabs folder")),
    ]);
    if (rootRef.current?.path !== current.path) return;
    const found = mergeDrafts(browser, disk);
    // Numbering continues above what was kept, so the next edit is never
    // refused as older than the draft it came from.
    for (const draft of browser.drafts) rec.seed(draft.relPath, draft.revision, "browser");
    for (const draft of disk.drafts) rec.seed(draft.relPath, draft.revision, "disk");
    refreshDrafts();
    if (found.drafts.length > 0 || found.unreadable.length > 0) {
      setWaiting(found);
      show(draftsWaitingNotice(found.drafts.length, found.unreadable.length));
    }
  };

  /**
   * Settle who edits and what was kept, for the root open now. The launch
   * sequence calls it; a seeded run calls it from its own effect, and a test
   * calls it directly, so all three take the same path.
   */
  const beginEditing = (): Promise<void> =>
    rootRef.current ? startEditing(rootRef.current, serverIdRef.current) : Promise.resolve();

  /** Drop one draft from the waiting list without touching what is stored. */
  const stopWaitingFor = (relPath: string) => {
    setWaiting((found) => {
      if (!found) return found;
      const drafts = found.drafts.filter((d) => d.relPath !== relPath);
      return drafts.length === 0 && found.unreadable.length === 0 ? null : { ...found, drafts };
    });
  };

  /**
   * Open one kept draft for review.
   *
   * The file on disk is left exactly as it is. When it is still there it is
   * read normally and the draft's text is put into the buffer as one edit, so
   * a single undo shows what is on disk. When it is gone the buffer holds the
   * draft alone and the tab says the file is missing, so the only way that
   * text reaches the disk is the Recreate the user is asked about on save.
   */
  const reviewDraft = async (draft: Draft) => {
    if (lockRef.current || transitionRef.current) return;
    const current = rootRef.current;
    const listing = homeRef.current?.listing;
    if (!current || !listing) return;
    const owner = ownerOfPath(draft.relPath, listing);
    if (owner === null) {
      show(failureNotice(`path is outside the subject: ${draft.relPath}`));
      return;
    }
    // A path always belongs to a place; Home holds no files of its own.
    if (owner.startsWith("work:")) await enterPlace(owner.slice("work:".length));
    else if (owner.startsWith("know:")) enterRole(owner.slice("know:".length) as Role);
    else return;
    if (activeKeyRef.current !== owner) return;
    const exists = await entryKind(draft.relPath).catch(() => "none" as const);
    if (rootRef.current?.path !== current.path || activeKeyRef.current !== owner) return;
    stopWaitingFor(draft.relPath);
    if (exists === "file") {
      await openPath(draft.relPath, null, "editor");
      const model = monacoEditor.getModel(modelUri(current.path, draft.relPath));
      if (!model) return;
      if (model.getValue() === draft.contents) {
        show(summaryNotice(`${draft.relPath} already matches what alabs kept.`));
        settleDraft(draft.relPath, draft.revision);
        return;
      }
      // One edit, so undo goes back to the copy on disk.
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: draft.contents }], () => null);
      // The buffer differs from the file — that is what a draft is — so the
      // tab says so without waiting for the editor to report the change.
      updateScope(owner, editorId(draft.relPath), (s) => ({
        ...s,
        tabs: updateTab(s.tabs, editorId(draft.relPath), (t) => (t.kind === "loaded" ? { ...t, dirty: true } : t)),
      }));
      keepDraftNow(draft.relPath);
      show(summaryNotice(`${draft.relPath} shows what alabs kept. Undo returns to the file on disk; Save writes it.`));
      return;
    }
    const result = materializeDraft(
      {
        liveModelCount: () => liveModelCount(scopesRef.current),
        createModel: (path, file) => {
          const uri = modelUri(current.path, path);
          disposeModel(uri);
          return monacoEditor.createModel(file.content, languageForFile(file.name), uri).getAlternativeVersionId();
        },
        stillLive: () => rootRef.current?.path === current.path && scopesRef.current[owner] !== undefined,
      },
      draft.relPath,
      baseName(draft.relPath),
      draft.contents,
      draft.stamp,
    );
    if (result.kind === "refused") {
      show(tooManyOpenFilesNotice());
      return;
    }
    if (result.kind !== "tab") return;
    updateScope(owner, null, (s) => ({ ...s, tabs: openTab(s.tabs, result.tab) }));
    keepDraftNow(draft.relPath);
    show(summaryNotice(`${draft.relPath} is not on disk. Saving this tab will ask before recreating it.`));
  };

  /** Throw one kept draft away. The user's explicit answer, and the only other way a draft goes. */
  const discardDraft = (draft: Draft) => {
    stopWaitingFor(draft.relPath);
    settleDraft(draft.relPath, draft.revision);
    show(summaryNotice(`Discarded what alabs kept for ${draft.relPath}.`));
  };

  /**
   * Hand the newest text of one draft to the user as a file.
   *
   * The way out when alabs could not keep it anywhere, and the reason a
   * failure to keep a draft is never the end of the text.
   */
  const exportDraft = (relPath: string, contents: string | null = null) => {
    const text = contents ?? recorderRef.current?.text(relPath) ?? null;
    if (text === null) return;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = baseName(relPath);
    link.rel = "noopener";
    link.click();
    // Not straight away: the browser is still reading it. Letting go of the
    // handle while the save is being set up can cancel the very thing this
    // exists to do.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  /**
   * A save that was never answered.
   *
   * This is the one failure alabs must not treat like the others. A refusal
   * is the server saying no, and alabs knows the file is untouched. Silence
   * is not: the write may have gone through in full and only the answer been
   * lost. So nothing is written again, nothing is retried, and the first
   * thing alabs does is go back to the disk and look.
   *
   *   * The file is byte for byte what it was — and a save replaces the file
   *     with a new one, which cannot leave the same identity behind — so the
   *     save did not happen. The tab is in step with the disk again and the
   *     user may simply save.
   *   * Nothing is at that path. The tab says so; saving from there reaches
   *     the explicit Recreate, as it always does.
   *   * The file is different. It may be this save, it may be something else
   *     entirely. alabs does not guess: the tab is marked uncertain and stays
   *     that way until the user Refreshes and sees what is there.
   *
   * The draft is deliberately not settled in any of these: nothing has been
   * confirmed written, so the unsaved text is still unsaved.
   */
  const afterSilentSave = async (
    relPath: string,
    expected: FileStamp,
    shownPath: string,
    setDisk: (disk: DiskState) => void,
  ): Promise<void> => {
    let onDisk: FileStamp | null;
    try {
      onDisk = await statFile(relPath);
    } catch {
      setDisk("uncertain");
      show(uncertainSaveNotice(shownPath, "unknown"));
      return;
    }
    if (onDisk === null) {
      setDisk("missing");
      show(uncertainSaveNotice(shownPath, "gone"));
      return;
    }
    if (stampsEqual(onDisk, expected)) {
      setDisk("ok");
      show(uncertainSaveNotice(shownPath, "untouched"));
      return;
    }
    setDisk("uncertain");
    show(uncertainSaveNotice(shownPath, "changed"));
  };

  /**
   * Save one tab's buffer to disk. Resolves to an approval for exactly the
   * model version that was written, or null on failure or refusal. Edits
   * typed during the save stay in the buffer and are not covered.
   *
   * The scope key and path are captured at the start; every completion goes
   * through the guarded commit, so a tab closed meanwhile is left alone. A
   * save the backend refuses because the file changed on disk marks the tab
   * as conflicted; the buffer is kept. If the file no longer exists on disk,
   * the buffer is kept and the user is asked whether to recreate it.
   */
  const saveTab = useCallback(
    async (key: ScopeKey, relPath: string): Promise<Approval | null> => {
      if (lockRef.current) return null;
      const current = rootRef.current;
      const scope = scopesRef.current[key];
      const tab = scope ? findEditorTab(scope.tabs, relPath) : undefined;
      if (!current || !tab || tab.kind !== "loaded") return null;
      if (savingRef.current) {
        show(failureNotice("A save is already in progress. Try again in a moment"));
        return null;
      }
      const model = monacoEditor.getModel(modelUri(current.path, relPath));
      if (!model) return null;
      savingRef.current = true;
      const content = model.getValue();
      const version = model.getAlternativeVersionId();
      // Kept before it is written, so what alabs holds is exactly the text
      // going to the file. If the save fails, or never answers, that text is
      // already somewhere other than this tab.
      const draftRevision = recorderRef.current?.note(relPath, content, tab.disk === "missing" ? null : tab.stamp) ?? null;
      const id = editorId(relPath);
      const setDisk = (disk: DiskState) =>
        updateScope(key, id, (s) => ({ ...s, tabs: updateTab(s.tabs, id, (t) => (t.kind === "loaded" ? { ...t, disk } : t)) }));
      const recordSaved = (stamp: FileStamp) => {
        // The model keeps any edits typed during the save; they simply stay dirty.
        const dirty = model.getAlternativeVersionId() !== version;
        updateScope(key, id, (s) => ({
          ...s,
          tabs: updateTab(s.tabs, id, (t) => (t.kind === "loaded" ? { ...t, stamp, savedVersion: version, dirty, disk: "ok" } : t)),
        }));
        // The file now holds that revision, so alabs no longer needs to. A
        // buffer typed in again during the save keeps its newer draft: the
        // recorder refuses to forget text past the revision named here.
        settleDraft(relPath, draftRevision);
      };
      try {
        try {
          recordSaved(await saveFile(relPath, content, tab.stamp));
          show(summaryNotice(`Saved ${displayPath(relPath, scope.prefix)}.`));
          return { version };
        } catch (err) {
          if (callFailure(err) === "not-writing") {
            lostWriting();
            return null;
          }
          // A save that was never answered may have been written in full.
          // Nothing is tried again on a guess: what is actually on the disk
          // is read back, and the user decides from there.
          if (callFailure(err) === "uncertain") {
            await afterSilentSave(relPath, tab.stamp, displayPath(relPath, scope.prefix), setDisk);
            return null;
          }
          // Only a file that is really gone may be offered for recreation.
          const onDisk = await statFile(relPath).catch(() => undefined);
          if (onDisk !== null) {
            if (onDisk !== undefined && !stampsEqual(onDisk, tab.stamp)) setDisk("conflict");
            throw err;
          }
        }
        setDisk("missing");
        if (statusOf(scope) === "missing") {
          // The whole place is gone: nothing to recreate into. The buffer stays dirty.
          show(placeMissingNotice(scope.name, current.path));
          return null;
        }
        show(failureNotice(`${relPath} no longer exists on disk; your edits are kept in the tab`));
        const answer = await ask<boolean>(
          (resolve) => setRecreatePrompt({ relPath, resolve }),
          () => setRecreatePrompt(null),
        );
        if (answer !== true) return null;
        const still = scopesRef.current[key];
        if (rootRef.current?.path !== current.path || !still || !findEditorTab(still.tabs, relPath)) return null;
        recordSaved(await recreateFile(relPath, content));
        show(summaryNotice(`Recreated ${displayPath(relPath, scope.prefix)}.`));
        return { version };
      } catch (err) {
        if (callFailure(err) === "not-writing") {
          lostWriting();
          return null;
        }
        if (callFailure(err) === "uncertain") {
          await afterSilentSave(relPath, tab.stamp, displayPath(relPath, scope.prefix), setDisk);
          return null;
        }
        show(failureNotice(`Save failed: ${String(err)}`));
        return null;
      } finally {
        savingRef.current = false;
      }
    },
    [ask],
  );

  const saveTabRef = useRef(saveTab);
  saveTabRef.current = saveTab;

  /**
   * Obtain approval to drop one tab's buffer. A clean buffer is approved as
   * it stands. A dirty one is saved or discarded at the user's choice, or the
   * flow is cancelled (null). A save approves only the version it wrote and
   * Discard only the version on screen, so edits made during a save lead to
   * another question, never to a silent drop.
   */
  const confirmTab = useCallback(
    async (key: ScopeKey, relPath: string): Promise<Approval | null> => {
      for (;;) {
        const scope = scopesRef.current[key];
        const tab = scope ? findEditorTab(scope.tabs, relPath) : undefined;
        if (!tab) return null;
        if (tab.kind !== "loaded") return { version: 0 };
        const clean = cleanApproval(tab.savedVersion, liveVersion(relPath));
        if (clean) return clean;
        const choice = await ask<UnsavedChoice>(
          (resolve) => {
            setPrompt({ name: tab.name, resolve });
            initial?.onUnsavedPrompt?.(tab.name, resolve);
          },
          () => setPrompt(null),
        );
        if (choice === null || choice === "cancel") return null;
        if (choice === "discard") {
          // The one other way a draft goes: the user said to throw the text
          // away, so alabs stops keeping it too.
          settleDraft(relPath, keepDraftNow(relPath));
          const shown = liveVersion(relPath);
          return shown === null ? { version: 0 } : discardApproval(shown);
        }
        const saved = await saveTabRef.current(key, relPath);
        if (!saved) return null;
        if (approvalHolds(saved, liveVersion(relPath))) return saved;
        // Edited while the save ran: the buffer is dirty again, so ask again.
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ask],
  );

  /**
   * Approvals for every open tab in every scope, asking about dirty ones in
   * scope and strip order and again about any tab edited after it was
   * approved. Null when the user cancels or a save fails.
   */
  const confirmAll = useCallback(async (): Promise<Map<string, Approval> | null> => {
    const approvals = new Map<string, Approval>();
    let pending = allTabs(scopesRef.current);
    while (pending.length > 0) {
      for (const { key, relPath } of pending) {
        const approval = await confirmTab(key, relPath);
        if (!approval) return null;
        approvals.set(relPath, approval);
      }
      const stale = new Set(
        unapproved(
          allTabs(scopesRef.current).map((t) => t.relPath),
          approvals,
          versionsOf,
        ),
      );
      pending = allTabs(scopesRef.current).filter((t) => stale.has(t.relPath));
    }
    return approvals;
  }, [confirmTab]);

  /**
   * Dispose every model in every scope and start over with Home only, but
   * only after checking each buffer against its approval right now. Returns
   * false, disposing nothing, when any buffer was edited since it was approved.
   */
  const disposeAllScopes = (approvals: ReadonlyMap<string, Approval>): boolean => {
    const current = rootRef.current;
    const paths = allTabs(scopesRef.current).map((t) => t.relPath);
    if (unapproved(paths, approvals, versionsOf).length > 0) return false;
    if (current) for (const path of paths) disposeModel(modelUri(current.path, path));
    setScopesNow(freshScopes());
    activeKeyRef.current = HOME_KEY;
    setActiveKey(HOME_KEY);
    visitedRef.current = {};
    return true;
  };

  /**
   * Queue the remembered cursor of a restored tab the first time it is shown,
   * or, when nothing is pending, a plain focus of that tab's editor.
   */
  const revealPending = (key: ScopeKey, relPath: string) => {
    const scope = scopesRef.current[key];
    if (!scope || !scope.pendingViews.has(relPath)) {
      setReveal({ relPath });
      return;
    }
    const view = scope.views[relPath];
    updateScope(key, null, (s) => {
      const pendingViews = new Set(s.pendingViews);
      pendingViews.delete(relPath);
      return { ...s, pendingViews };
    });
    setReveal(view ? { relPath, ...view } : { relPath });
  };

  /**
   * The one way a file becomes live editor state (BUILD_PLAN Step 3 item
   * 20): the read, the live-model cap and the stale check live in
   * `materialize`; this binds them to the root open now, to Monaco and to the
   * scope's own record. `stillLive` also refuses once a tab for the path
   * exists in the scope, so two opens in flight cannot both create a model.
   * `extra` counts models a caller has created but not yet committed.
   */
  const materializeTab = (key: ScopeKey, relPath: string, extra: () => number = () => 0): Promise<MaterializeResult> => {
    const current = rootRef.current;
    if (!current) return Promise.resolve({ kind: "stale" });
    return materialize(
      {
        readFile,
        liveModelCount: () => liveModelCount(scopesRef.current) + extra(),
        createModel: (path, file) => {
          const uri = modelUri(current.path, path);
          // Never reuse a model: a leftover one could pair stale text with a fresh stamp.
          disposeModel(uri);
          return monacoEditor.createModel(file.content, languageForFile(file.name), uri).getAlternativeVersionId();
        },
        stillLive: () => {
          const scope = scopesRef.current[key];
          return rootRef.current?.path === current.path && scope !== undefined && !findEditorTab(scope.tabs, relPath);
        },
      },
      relPath,
    );
  };

  /**
   * Read a place's remembered tabs on its first visit this session, under the
   * window lock, each through `materializeTab`. Files that fail (missing,
   * unreadable) are skipped and named in the summary, never recreated; the
   * live-model cap stops the restore at the cap and says so. Every completion
   * checks that the scope still exists in the same root; if the root changed
   * meanwhile the models made so far are disposed and nothing is committed.
   */
  const restoreScope = async (key: ScopeKey) => {
    const current = rootRef.current;
    const scope = scopesRef.current[key];
    if (!current || !scope || scope.restored) return;
    const remembered = rememberedTabs(scopeLayout(uiRef.current, key));
    if (remembered.tabs.length === 0) {
      updateScope(key, null, (s) => ({ ...s, restored: true }));
      return;
    }
    setLock(true, `Restoring ${scope.name}…`);
    let tabs = EMPTY_TABS;
    const abandon = () => {
      for (const tab of tabs.tabs) if (tab.kind === "loaded") disposeModel(modelUri(current.path, tab.relPath));
    };
    const failed: string[] = [];
    let refused = 0;
    try {
      for (const { kind, path: relPath } of remembered.tabs) {
        if (kind === "markdown" || kind === "view") {
          // A rendered surface holds no buffer: it reads and checks its file when shown.
          tabs = openTab(tabs, kind === "markdown" ? markdownTab(relPath) : viewTab(relPath));
          continue;
        }
        if (kind === "task" || kind === "changes") {
          // The place's own surface: only for the place's folder, only in a work place; the draft starts empty.
          if (scope.kind === "work" && relPath === scope.prefix) tabs = openTab(tabs, surfaceTab(kind, relPath));
          continue;
        }
        if (refused > 0) {
          refused += 1;
          continue;
        }
        const result = await materializeTab(key, relPath, () => tabs.tabs.filter((t) => t.kind === "loaded").length);
        if (result.kind === "stale") return abandon();
        if (result.kind === "tab") tabs = openTab(tabs, result.tab);
        else if (result.kind === "refused") refused = 1;
        else failed.push(displayPath(relPath, scope.prefix));
      }
      if (rootRef.current?.path !== current.path || !scopesRef.current[key]) return abandon();
      const active = remembered.active !== null && findTab(tabs, remembered.active) ? remembered.active : tabs.active;
      if (active !== null) tabs = activateTab(tabs, active);
      const views: Record<string, ViewState> = {};
      const pendingViews = new Set<string>();
      for (const tab of tabs.tabs) {
        if (remembered.views[tab.relPath]) {
          views[tab.relPath] = remembered.views[tab.relPath];
          pendingViews.add(tab.relPath);
        }
      }
      updateScope(key, null, (s) => ({ ...s, tabs, views: { ...s.views, ...views }, pendingViews, restored: true }));
      const activeEditor = active === null ? null : parseId(active);
      if (activeEditor?.kind === "editor") revealPending(key, activeEditor.relPath);
      const n = tabs.tabs.length;
      const parts = [`${scope.name} restored: ${n} ${n === 1 ? "tab" : "tabs"}`];
      if (failed.length > 0) parts.push(`${failed.length} ${failed.length === 1 ? "file" : "files"} could not be opened: ${failed.join(", ")}`);
      if (refused > 0) parts.push(`${refused} not opened: too many open files across places`);
      const summary = parts.join(", ");
      show({ text: summary, error: failed.length > 0 || refused > 0, log: summary });
    } finally {
      setLock(false, null);
    }
  };

  /**
   * Enter a work place. Navigation, never a workspace change: the current
   * scope keeps its tabs, buffers, cursor and undo history. A place visited
   * for the first time this session gets a scope and restores its remembered
   * tabs; a place visited before shows exactly what it showed.
   */
  /** Show a scope: the outgoing cursor is recorded, the notice cleared, the incoming editor focused. */
  const switchTo = (key: ScopeKey) => {
    captureView();
    flushDrafts();
    setNotice(null);
    visitedRef.current[key] = Date.now();
    activeKeyRef.current = key;
    setActiveKey(key);
    const scope = scopesRef.current[key];
    // Entering a place focuses its active tab's editor; Home focuses nothing (DESIGN.md section 8).
    const editor = scope && scope.kind !== "home" && scope.restored ? shownEditor(scope) : undefined;
    if (editor) setReveal({ relPath: editor.relPath });
  };

  const enterPlace = (name: string): Promise<void> => {
    if (lockRef.current || transitionRef.current) return Promise.resolve();
    const current = rootRef.current;
    if (!current || !isPlaceName(name)) return Promise.resolve();
    const key = workKey(name);
    if (!scopesRef.current[key]) {
      // A place that is neither listed nor live is nothing to enter.
      const listing = homeRef.current?.listing;
      if (listing && !listing.work.some((p) => p.name === name)) return Promise.resolve();
      const remembered = scopeLayout(uiRef.current, key);
      setScopesNow(addScope(scopesRef.current, workScope(key, name, remembered.expanded)));
    }
    switchTo(key);
    setUiNow(rememberActiveWork(uiRef.current, name));
    return scopesRef.current[key].restored ? Promise.resolve() : restoreScope(key);
  };

  /**
   * Enter a knowledge place. Its scope is created once, bound to the folder
   * the role resolves to right now, and never re-resolved (BUILD_PLAN Step 3
   * item 21). The active work place is left as it is: this is a visit, not a
   * change of work.
   */
  const enterRole = (role: Role) => {
    if (lockRef.current || transitionRef.current) return;
    const current = rootRef.current;
    if (!current) return;
    const key = knowKey(role);
    if (!scopesRef.current[key]) {
      const state = homeRef.current?.listing.roles[role];
      if (!state || state.kind !== "present") {
        if (state?.kind === "conflict") show({ text: roleConflictText(roleInfo(role).label, state.names), error: true, log: null });
        return;
      }
      const remembered = scopeLayout(uiRef.current, key);
      setScopesNow(addScope(scopesRef.current, knowScope(key, role, roleInfo(role).label, state.name, remembered.expanded)));
    }
    switchTo(key);
    if (!scopesRef.current[key].restored) void restoreScope(key);
  };

  const goHome = () => {
    if (lockRef.current) return;
    switchTo(HOME_KEY);
  };

  /**
   * Change the alabs root (BUILD_PLAN Step 2 item 24). Under the transition
   * lock: a dialog-only pick that changes nothing in Rust; every dirty-buffer
   * approval while the old root and all scopes stay intact; then the window
   * is locked and `open_subject` validates and opens the new folder before
   * replacing the handle. Failure keeps the old root and every scope. Success
   * disposes the old scopes and switches to the new root's Home before the
   * lock is released, so backend and frontend never disagree while any
   * filesystem action can run.
   */
  const changeRoot = () =>
    runTransition("change root", async () => {
      if (lockRef.current) return;
      let path: string | null;
      try {
        path = await pickFolder();
      } catch (err) {
        fail(err);
        return;
      }
      if (path === null) return;
      let approvals = await confirmAll();
      if (!approvals) return;
      const old = rootRef.current;
      if (old) await flushUi();
      setLock(true, "Changing root…");
      try {
        // Under the lock nothing can edit a buffer; re-check anyway before the handle moves.
        while (unapproved(allTabs(scopesRef.current).map((t) => t.relPath), approvals, versionsOf).length > 0) {
          const again = await confirmAll();
          if (!again) return;
          approvals = again;
        }
        let opened: RootInfo;
        // Invalidate before the native transition starts, not after its reply.
        // A cancelled/failed transition does not silently restart a Raven run.
        queueRef.current?.clear();
        setBuilds(new Map());
        try {
          opened = await openRoot(path);
        } catch (err) {
          show(rootOpenNotice(path, String(err)), path);
          return;
        }
        // The backend now holds the new root. Switch the frontend before anything else can run.
        if (!disposeAllScopes(approvals)) {
          // Cannot happen under the lock; recorded rather than trusted.
          void log("error", "root change: a buffer changed under the lock; scopes replaced", old?.path ?? null);
          setScopesNow(freshScopes());
          activeKeyRef.current = HOME_KEY;
          setActiveKey(HOME_KEY);
        }
        rootRef.current = opened;
        setRoot(opened);
        homeRef.current = null;
        setHome(null);
        setNotice(null);
        const nextUi = rememberRoot(uiRef.current, opened.path);
        setUiNow(nextUi);
        lastWrittenRef.current = null;
        await loadHome();
      } finally {
        setLock(false, null);
      }
    });

  /** First launch: choose the root. The same transactional path as a change, with nothing to approve. */
  const chooseRoot = changeRoot;

  /**
   * Create the default folder for a not-created knowledge role directly
   * inside the root, then enter it (DESIGN.md 6.1: the row asks nothing,
   * creates the folder, then enters it). A failed create goes to the notice
   * line and enters nothing.
   */
  /** The Wiki section's model choice: disposable machine state only, written with the layout. */
  const selectLocalModel = (name: string | null) => {
    setUiNow(setLocalModel(uiRef.current, name));
    void flushUi();
  };

  const createRole = async (role: Role) => {
    if (lockRef.current) return;
    const state = homeRef.current?.listing.roles[role];
    if (!state || state.kind !== "missing") return;
    const folder = ROLES.find((r) => r.role === role)?.folder ?? role;
    try {
      await createDir("", folder);
    } catch (err) {
      fail(err);
      return;
    }
    if (!(await loadHome())) return;
    enterRole(role);
  };

  const active = scopes[activeKey] ?? scopes[HOME_KEY];

  /**
   * What this window is called from outside it. On the desktop the title bar
   * is the application's; in Chrome this is the tab, and a tab that says only
   * `alabs` is no use once there are several. It names the place, then the
   * root, then alabs, because a tab strip cuts the end off first.
   */
  useEffect(() => {
    document.title = root === null ? "alabs" : `${active.name} · ${root.name} · alabs`;
  }, [active.name, root]);

  const toggleDir = (key: ScopeKey, relPath: string) =>
    updateScope(key, null, (s) => {
      const expanded = new Set(s.expanded);
      if (expanded.has(relPath)) expanded.delete(relPath);
      else expanded.add(relPath);
      return { ...s, expanded };
    });

  const selectDir = (key: ScopeKey, relPath: string) => updateScope(key, null, (s) => ({ ...s, selectedDir: relPath }));

  /** Switch tabs inside the active scope, remembering where the outgoing tab's cursor was. */
  const showTab = (id: TabId) => {
    if (lockRef.current) return;
    const key = activeKeyRef.current;
    captureView();
    const parsed = parseId(id);
    if (parsed?.kind === "editor") revealPending(key, parsed.relPath);
    updateScope(key, id, (s) => ({ ...s, tabs: activateTab(s.tabs, id) }));
  };

  /** Show the place's pinned Overview: no file tab is active. */
  const showOverview = () => {
    if (lockRef.current) return;
    const key = activeKeyRef.current;
    captureView();
    updateScope(key, null, (s) => (s.kind === "home" || s.tabs.active === null ? s : { ...s, tabs: { ...s.tabs, active: null } }));
  };

  /**
   * The one entry point for every surface that opens a real file (tree,
   * search, Overview, Markdown, the Visual View and its inspector). The path
   * must belong to the active place (`views/<place>/**` included); anything
   * else is refused with a notice. An open tab is shown as it is. A Markdown
   * or Visual View tab holds no buffer: the surface reads and checks its
   * file when shown. Otherwise the file is brought to life through
   * `materializeTab` and committed through the guard, so a scope disposed
   * meanwhile receives nothing, the cap refuses rather than evicts, and a
   * file that cannot be read opens as an unsupported tab that says why.
   */
  const openPath = async (relPath: string, line: number | null = null, kind?: TabKind) => {
    if (lockRef.current) return;
    const current = rootRef.current;
    const key = activeKeyRef.current;
    const scope = scopesRef.current[key];
    if (!current || !scope || scope.kind === "home") return;
    const listing = homeRef.current?.listing;
    const owned = (listing ? ownerOfPath(relPath, listing) === key : false) || isAtOrUnder(relPath, scope.prefix);
    if (!owned) {
      show(failureNotice(`path is outside the subject: ${relPath}`));
      return;
    }
    const tabKind = kind ?? (line !== null ? "editor" : defaultTabKind(relPath));
    captureView();
    if (tabKind === "markdown" || tabKind === "view") {
      // A rendered surface: no buffer, no model, no cap; it reads the file when shown.
      const id = tabIdOf(tabKind, relPath);
      const tab = tabKind === "markdown" ? markdownTab(relPath) : viewTab(relPath);
      updateScope(key, null, (s) => ({ ...s, tabs: findTab(s.tabs, id) ? activateTab(s.tabs, id) : openTab(s.tabs, tab) }));
      return;
    }
    const id = editorId(relPath);
    if (line !== null) setReveal({ relPath, line, column: 1 });
    else revealPending(key, relPath);
    if (findTab(scope.tabs, id)) {
      updateScope(key, id, (s) => ({ ...s, tabs: activateTab(s.tabs, id) }));
      return;
    }
    const result = await materializeTab(key, relPath);
    if (result.kind === "stale") {
      // The tab may have been opened by a second click while the read was in flight.
      if (rootRef.current?.path === current.path && !lockRef.current) updateScope(key, id, (s) => ({ ...s, tabs: activateTab(s.tabs, id) }));
      return;
    }
    if (result.kind === "refused") {
      show(tooManyOpenFilesNotice());
      return;
    }
    if (lockRef.current) {
      // A restore took the window while the read was in flight: its lock owns the scope now.
      if (result.kind === "tab") disposeModel(modelUri(current.path, relPath));
      return;
    }
    if (result.kind === "failed") {
      const name = baseName(relPath);
      updateScope(key, null, (s) => ({ ...s, tabs: openTab(s.tabs, { kind: "unsupported", relPath, name, message: result.reason }) }));
      return;
    }
    updateScope(key, null, (s) => ({ ...s, tabs: openTab(s.tabs, result.tab) }));
  };

  /**
   * The Home node's `◫ visual view` target: enter the place, wait for its
   * remembered tabs, then show its Visual View tab. The view file is read
   * and checked by the tab itself, never here.
   */
  const openVisualView = async (name: string) => {
    await enterPlace(name);
    if (activeKeyRef.current !== workKey(name)) return;
    await openPath(visualViewPath(name), null, "view");
  };

  /** Open or select the Task or Changes tab of the active work place (the Overview actions). */
  const openSurface = (kind: "task" | "changes") => {
    if (lockRef.current) return;
    const key = activeKeyRef.current;
    const scope = scopesRef.current[key];
    if (!scope || scope.kind !== "work") return;
    captureView();
    updateScope(key, null, (s) => ({ ...s, tabs: openTab(s.tabs, surfaceTab(kind, s.prefix)) }));
  };

  const setTaskDraft = (update: (draft: TaskDraft) => TaskDraft) => {
    const key = activeKeyRef.current;
    updateScope(key, null, (s) => (s.kind === "work" ? { ...s, task: update(s.task) } : s));
  };

  /**
   * `Copy task packet` (DESIGN.md 6.10, BUILD_PLAN Step 6). The blocker is
   * checked here again, never trusted to the button: an empty task or a
   * ticked context file with unsaved edits refuses, and nothing is ever
   * saved on the user's behalf. The packet goes to the clipboard from this
   * click; if the clipboard refuses, the packet is shown selected for
   * manual copy. In a Git place the handoff baseline (commit, time, clean)
   * is then recorded in disposable state, replacing the place's earlier
   * one, and the Changes readout carries the task-started cue until the
   * next Refresh. Task text is never stored.
   */
  const copyTaskPacket = async () => {
    if (lockRef.current) return;
    const current = rootRef.current;
    const key = activeKeyRef.current;
    const scope = scopesRef.current[key];
    if (!current || !scope || scope.kind !== "work") return;
    const chosen = selectedContext(contextCandidates(scopesRef.current, key), scope.task.selected);
    const blocker = copyBlocker(scope.task.text, chosen);
    if (blocker) {
      if (blocker.kind === "dirty") show(taskBlockedNotice(blocker.relPath));
      return;
    }
    const packet = taskPacket({
      place: scope.name,
      rootPath: current.path,
      task: scope.task.text,
      context: chosen.map((c) => c.relPath),
      constraints: scope.task.constraints,
    });
    let copied = false;
    let reason = "";
    try {
      await navigator.clipboard.writeText(packet);
      copied = true;
    } catch (err) {
      reason = String(err);
    }
    if (rootRef.current?.path !== current.path) return;
    updateScope(key, null, (s) => ({ ...s, task: { ...s.task, fallback: copied ? null : packet } }));
    show(copied ? taskCopiedNotice(chosen.length) : copyFailedNotice(reason), current.path);
    if (gitOf(scope) !== "repo") return;
    const at = Date.now();
    const result = await gitQuery(scope.prefix, { kind: "head" });
    if (rootRef.current?.path !== current.path || !scopesRef.current[key]) return;
    if (result.kind === "head" && result.commit !== null) {
      setUiNow(setBaseline(uiRef.current, scope.prefix, { commit: result.commit, at, clean: result.clean }));
      updateScope(key, null, (s) => ({ ...s, taskStartedAt: at }));
    } else {
      void log("warn", `task baseline for ${scope.prefix} not recorded: ${JSON.stringify(result)}`, current.path);
    }
  };

  /** `Open in Terminal`: Terminal.app at the active work place, resolved through the root. Nothing waits on Terminal. */
  const openTerminalHere = async () => {
    if (lockRef.current) return;
    const current = rootRef.current;
    const scope = scopesRef.current[activeKeyRef.current];
    if (!current || !scope || scope.kind !== "work") return;
    try {
      await openTerminal(scope.prefix);
    } catch (err) {
      show(terminalFailedNotice(scope.name, String(err)), current.path);
    }
  };

  const startCreate = (kind: "file" | "folder") => {
    if (lockRef.current) return;
    const scope = scopesRef.current[activeKeyRef.current];
    if (!scope || scope.kind === "home" || statusOf(scope) === "missing") return;
    setNewName("");
    setNameError(null);
    setNamePrompt({ kind, parent: scope.selectedDir || scope.prefix });
  };

  const startNewPlace = () => {
    if (lockRef.current || !rootRef.current) return;
    setNewName("");
    setNameError(null);
    setNamePrompt({ kind: "place" });
  };

  const startRename = (entry: Entry) => {
    if (lockRef.current) return;
    setNewName(entry.name);
    setNameError(null);
    setNamePrompt({ kind: "rename", entry });
  };

  const startMove = (entry: Entry) => {
    if (lockRef.current) return;
    const scope = scopesRef.current[activeKeyRef.current];
    if (!scope) return;
    setNewName(displayPath(parentOf(entry.rel_path), scope.prefix));
    setNameError(null);
    setNamePrompt({ kind: "move", entry });
  };

  const cancelPrompt = () => setNamePrompt(null);

  const bumpRefresh = (key: ScopeKey, ...dirs: string[]) =>
    updateScope(key, null, (s) => {
      const refresh = { ...s.refresh };
      for (const dir of dirs) refresh[dir] = (refresh[dir] ?? 0) + 1;
      return { ...s, refresh };
    });

  /**
   * Replace a clean tab's buffer with `content` just read from disk. The active
   * editor keeps its cursor and scroll position; inactive tabs keep the view
   * state the editor wrapper restores when they are shown again.
   */
  const reloadModel = (model: monacoEditor.ITextModel, content: string) => {
    const editor = editorRef.current;
    const shown = editor?.getModel() === model;
    const position = shown ? editor?.getPosition() : null;
    const scrollTop = shown ? editor?.getScrollTop() : null;
    model.setValue(content);
    if (shown && editor) {
      if (position) editor.setPosition(model.validatePosition(position));
      if (scrollTop !== null && scrollTop !== undefined) editor.setScrollTop(scrollTop);
    }
  };

  /**
   * Explicit Refresh (BUILD_PLAN Step 3 item 15): one root listing (places,
   * knowledge folders, view checks, so a missing place can reconnect), the
   * active place's tree and Overview re-read, then every loaded tab in every
   * scope checked against disk by its known path. Clean buffers whose file
   * changed are reloaded in place; dirty buffers are never overwritten and
   * are marked as conflicted; tabs whose file is gone stay open and are
   * marked as missing. No inactive folder is listed, nothing is scanned, and
   * alabs never watches or polls the disk.
   */
  const refresh = async () => {
    if (lockRef.current) return;
    const current = rootRef.current;
    if (!current || refreshingRef.current) return;
    if (savingRef.current) {
      show(failureNotice("A save is in progress. Refresh skipped"));
      return;
    }
    refreshingRef.current = true;
    const activeScope = scopesRef.current[activeKeyRef.current];
    let changed = 0;
    let missing = 0;
    let failed = 0;
    let places = 0;
    try {
      const data = await loadHome();
      if (rootRef.current?.path !== current.path) return;
      // The place showing re-lists its tree and re-reads its Overview; every
      // open Markdown or Visual View surface re-reads and re-checks its own
      // file (a known path, no listing).
      if (activeScope && activeScope.kind !== "home") updateScope(activeScope.key, null, (s) => ({ ...s, reload: s.reload + 1 }));
      for (const scope of Object.values(scopesRef.current)) {
        const surfaces = scope.tabs.tabs.some((t) => t.kind === "markdown" || t.kind === "view" || t.kind === "changes");
        if (scope.kind === "home" || (!surfaces && scope.taskStartedAt === null)) continue;
        // Refresh is the manual return path: the task-started cue ends here.
        updateScope(scope.key, null, (s) => ({ ...s, surfaceReload: surfaces ? s.surfaceReload + 1 : s.surfaceReload, taskStartedAt: null }));
      }
      for (const scope of Object.values(scopesRef.current)) {
        const key = scope.key;
        const loaded = scope.tabs.tabs.filter((t) => t.kind === "loaded");
        if (loaded.length === 0) continue;
        places += 1;
        const setDisk = (relPath: string, disk: "ok" | "conflict" | "missing") =>
          updateScope(key, editorId(relPath), (s) => ({
            ...s,
            tabs: updateTab(s.tabs, editorId(relPath), (t) => (t.kind === "loaded" ? { ...t, disk } : t)),
          }));
        for (const tab of loaded) {
          try {
            const stamp = await statFile(tab.relPath);
            if (rootRef.current?.path !== current.path) return;
            // The tab may have been edited, saved, moved or closed while we waited.
            const liveScope = scopesRef.current[key];
            const live = liveScope ? findEditorTab(liveScope.tabs, tab.relPath) : undefined;
            if (!live || live.kind !== "loaded") continue;
            let outcome = reconcileOutcome(live, stamp);
            if (outcome === "reload") {
              const file = await readFile(tab.relPath);
              if (rootRef.current?.path !== current.path) return;
              const model = monacoEditor.getModel(modelUri(current.path, tab.relPath));
              const nowScope = scopesRef.current[key];
              const now = nowScope ? findEditorTab(nowScope.tabs, tab.relPath) : undefined;
              if (!model || !now || now.kind !== "loaded") continue;
              if (model.getAlternativeVersionId() !== now.savedVersion) {
                outcome = "conflict";
              } else {
                reloadModel(model, file.content);
                const savedVersion = model.getAlternativeVersionId();
                updateScope(key, editorId(tab.relPath), (s) => ({
                  ...s,
                  tabs: updateTab(s.tabs, editorId(tab.relPath), (t) =>
                    t.kind === "loaded" ? { ...t, stamp: file.stamp, savedVersion, dirty: false, disk: "ok" } : t,
                  ),
                }));
                changed += 1;
                continue;
              }
            }
            const disk = outcome === "conflict" ? "conflict" : outcome === "missing" ? "missing" : "ok";
            if (disk === "conflict") changed += 1;
            if (disk === "missing") missing += 1;
            setDisk(tab.relPath, disk);
          } catch {
            failed += 1;
          }
        }
      }
      if (data) show(refreshNotice({ changed, missing, failed, places }));
    } finally {
      refreshingRef.current = false;
    }
  };

  /**
   * Point every open tab of the active scope at or under `oldPath` to its new
   * path. Monaco model URIs are immutable, so each affected model is recreated
   * at the new URI with its current buffer and disposed at the old one; dirty
   * edits are preserved. No other model is ever disposed: a tab whose new URI
   * is unexpectedly taken keeps its buffer at the old path and is marked
   * missing on disk.
   */
  const followMove = (key: ScopeKey, oldPath: string, newPath: string) => {
    const current = rootRef.current;
    const scope = scopesRef.current[key];
    if (!current || !scope) return;
    // The shown editor loses its model when that model is recreated below;
    // its cursor and scroll are put back once the re-keyed tab is showing.
    captureView();
    const before = scopesRef.current[key];
    if (!before) return;
    const stranded = new Set<string>();
    for (const tab of before.tabs.tabs) {
      const moved = movedPath(tab.relPath, oldPath, newPath);
      if (moved !== null && monacoEditor.getModel(modelUri(current.path, moved))) stranded.add(tab.relPath);
    }
    let next = moveTabs(before.tabs, oldPath, newPath, stranded);
    for (const path of stranded) {
      next = updateTab(next, editorId(path), (t) => (t.kind === "loaded" ? { ...t, disk: "missing" } : t));
    }
    for (const tab of before.tabs.tabs) {
      const moved = movedPath(tab.relPath, oldPath, newPath);
      if (moved === null || tab.kind !== "loaded" || stranded.has(tab.relPath)) continue;
      const old = monacoEditor.getModel(modelUri(current.path, tab.relPath));
      if (!old) continue;
      const model = monacoEditor.createModel(old.getValue(), languageForFile(baseName(moved)), modelUri(current.path, moved));
      old.dispose();
      // A dirty buffer keeps a saved version no model version can reach, so it stays dirty until saved.
      const savedVersion = tab.dirty ? 0 : model.getAlternativeVersionId();
      next = updateTab(next, editorId(moved), (t) => (t.kind === "loaded" ? { ...t, savedVersion } : t));
    }
    const activeBefore = shownEditor(before);
    const activeView = activeBefore ? before.views[activeBefore.relPath] : undefined;
    const activeAfter = next.active === null ? null : parseId(next.active);
    if (activeAfter?.kind === "editor" && next.active !== before.tabs.active && activeView) {
      setReveal({ relPath: activeAfter.relPath, ...activeView });
    }
    const views: Record<string, ViewState> = {};
    for (const [path, view] of Object.entries(before.views))
      views[stranded.has(path) ? path : (movedPath(path, oldPath, newPath) ?? path)] = view;
    const dir = movedPath(before.selectedDir, oldPath, newPath);
    updateScope(key, null, (s) => ({
      ...s,
      tabs: next,
      views,
      selectedDir: dir ?? s.selectedDir,
      expanded: new Set([...s.expanded].map((p) => movedPath(p, oldPath, newPath) ?? p)),
    }));
    if (stranded.size > 0) show(failureNotice(`${[...stranded].join(", ")}: destination is open in another tab; buffer kept`));
  };

  /**
   * Every root-relative path that currently owns a buffer: open tabs in every
   * scope and live Monaco models. A rename or move may not land on any of them.
   */
  const bufferPaths = (rootPath: string): string[] => {
    const paths = new Set(allTabs(scopesRef.current).map((t) => t.relPath));
    for (const model of monacoEditor.getModels()) {
      const rel = relOfModel(rootPath, model);
      if (rel !== null) paths.add(rel);
    }
    return [...paths];
  };

  /**
   * Rename or move `entry` so it becomes `to`, inside the active place. The
   * destination is checked here and again in Rust before anything moves:
   * it must stay inside the place (BUILD_PLAN Step 3 item 17) and must not
   * be held by an open buffer. Resolves to the modal's error line, or null.
   */
  const relocate = async (entry: Entry, toParent: string, newName: string, verb: "Renamed" | "Moved"): Promise<string | null> => {
    if (lockRef.current) return null;
    if (savingRef.current) return "A save is in progress. Try again in a moment.";
    const current = rootRef.current;
    const key = activeKeyRef.current;
    const scope = scopesRef.current[key];
    if (!current || !scope || scope.kind === "home") return null;
    const to = joinRel(toParent, newName);
    const climbs = to.split("/").some((part) => part === "" || part === "." || part === "..");
    if (climbs || !isAtOrUnder(entry.rel_path, scope.prefix) || !isAtOrUnder(to, scope.prefix)) return outsidePlaceNotice(scope.name).text;
    const hit = destinationCollision(bufferPaths(current.path), entry.rel_path, to);
    if (hit !== null) return `${hit} is open in a tab. Close it first.`;
    let relPath: string;
    try {
      relPath = await moveItem(entry.rel_path, toParent, newName, scope.prefix);
    } catch (err) {
      const notice = failureNotice(err);
      if (notice.log !== null) void log("error", notice.log, current.path);
      return notice.text;
    }
    if (rootRef.current?.path !== current.path || !scopesRef.current[key]) return null;
    followMove(key, entry.rel_path, relPath);
    bumpRefresh(key, parentOf(entry.rel_path), parentOf(relPath), ...(entry.is_dir ? [relPath] : []));
    show(summaryNotice(`${verb} ${displayPath(entry.rel_path, scope.prefix)} to ${displayPath(relPath, scope.prefix)}.`));
    return null;
  };

  const renameEntry = (entry: Entry, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return Promise.resolve("Enter a name.");
    return relocate(entry, parentOf(entry.rel_path), trimmed, "Renamed");
  };

  const moveEntry = (entry: Entry, folder: string) => {
    const scope = scopesRef.current[activeKeyRef.current];
    if (!scope) return Promise.resolve(null);
    return relocate(entry, joinRel(scope.prefix, cleanFolderPath(folder)), entry.name, "Moved");
  };

  const submitPrompt = async () => {
    if (lockRef.current) return;
    if (!namePrompt) return;
    const current = rootRef.current;
    if (!current) return;
    const key = activeKeyRef.current;
    const scope = scopesRef.current[key];
    try {
      if (namePrompt.kind === "place") {
        const name = newName.trim();
        if (!name) {
          setNameError("Enter a name.");
          return;
        }
        try {
          await createDir("", name);
        } catch (err) {
          if (String(err).startsWith("already exists")) {
            setNameError(`A folder named ${name} already exists.`);
            return;
          }
          throw err;
        }
        setNamePrompt(null);
        await loadHome();
        return;
      }
      if (!scope || scope.kind === "home") return;
      if (namePrompt.kind === "move" || namePrompt.kind === "rename") {
        const error =
          namePrompt.kind === "move" ? await moveEntry(namePrompt.entry, newName) : await renameEntry(namePrompt.entry, newName);
        if (error !== null) setNameError(error);
        else setNamePrompt(null);
        return;
      }
      const name = newName.trim();
      if (!name) {
        setNameError("Enter a name.");
        return;
      }
      const { kind, parent } = namePrompt;
      const relPath = kind === "file" ? await createFile(parent, name) : await createDir(parent, name);
      setNamePrompt(null);
      // Show the new item: its parent folder is expanded (idempotent) and re-listed.
      updateScope(key, null, (s) => (s.expanded.has(parent) || parent === s.prefix ? s : { ...s, expanded: new Set(s.expanded).add(parent) }));
      bumpRefresh(key, parent);
      show(summaryNotice(`Created ${displayPath(relPath, scope.prefix)}.`));
      if (kind === "file") await openPath(relPath);
    } catch (err) {
      setNameError(failureNotice(err).text);
    }
  };

  /**
   * Move `entry` to the Trash. Every tab of the active scope at or under it
   * is approved first (a dirty one through Save, Discard, or Cancel); a
   * Discard approves the exact buffer version on screen for this operation.
   * The user then confirms the delete. A buffer edited after its approval is
   * asked about again; a failed or cancelled Trash disposes nothing. A buffer
   * edited in the last instant before disposal is kept and marked missing.
   */
  const startDelete = (entry: Entry) =>
    runTransition("delete", async () => {
      const current = rootRef.current;
      const key = activeKeyRef.current;
      if (!current || !scopesRef.current[key]) return;
      /** Editor tabs at or under the entry: the buffers that need approval. Markdown tabs simply close. */
      const under = () =>
        (scopesRef.current[key]?.tabs.tabs ?? [])
          .filter((t) => kindOf(t) === "editor")
          .map((t) => t.relPath)
          .filter((p) => isAtOrUnder(p, entry.rel_path));
      const approvals = new Map<string, Approval>();
      const collect = async (paths: string[]): Promise<boolean> => {
        for (const path of paths) {
          const approval = await confirmTab(key, path);
          if (!approval) return false;
          approvals.set(path, approval);
        }
        return true;
      };
      if (!(await collect(under()))) return;
      let error: string | null = null;
      for (;;) {
        const confirmed = await ask<boolean>(
          (resolve) => setDeletePrompt({ entry, error, resolve }),
          () => setDeletePrompt(null),
        );
        if (!confirmed) return;
        if (savingRef.current) {
          error = "A save is in progress. Try again in a moment.";
          continue;
        }
        const stale = unapproved(under(), approvals, versionsOf);
        if (stale.length > 0) {
          if (!(await collect(stale))) return;
          continue;
        }
        try {
          await trashItem(entry.rel_path);
          break;
        } catch (err) {
          error = failureNotice(err).text;
        }
      }
      const paths = under();
      const kept = new Set(unapproved(paths, approvals, versionsOf));
      for (const path of paths) {
        if (!kept.has(path)) disposeModel(modelUri(current.path, path));
      }
      updateScope(key, null, (s) => {
        let tabs = s.tabs;
        if (kept.size === 0) tabs = closeTabsUnder(tabs, entry.rel_path);
        else {
          for (const tab of s.tabs.tabs) {
            if (!isAtOrUnder(tab.relPath, entry.rel_path)) continue;
            tabs =
              tab.kind === "loaded" && kept.has(tab.relPath)
                ? updateTab(tabs, idOf(tab), (t) => (t.kind === "loaded" ? { ...t, disk: "missing" } : t))
                : closeTab(tabs, idOf(tab));
          }
        }
        const views = { ...s.views };
        for (const path of Object.keys(views)) if (isAtOrUnder(path, entry.rel_path) && !kept.has(path)) delete views[path];
        return {
          ...s,
          tabs,
          views,
          expanded: new Set([...s.expanded].filter((p) => !isAtOrUnder(p, entry.rel_path))),
          selectedDir: isAtOrUnder(s.selectedDir, entry.rel_path) ? parentOf(entry.rel_path) : s.selectedDir,
        };
      });
      bumpRefresh(key, parentOf(entry.rel_path));
      const scope = scopesRef.current[key];
      const shown = displayPath(entry.rel_path, scope?.prefix ?? "");
      show(
        kept.size === 0
          ? summaryNotice(`Moved ${shown} to the Trash.`)
          : failureNotice(`Moved ${shown} to the Trash; ${[...kept].join(", ")} edited meanwhile, kept in tab`),
      );
    });

  /** Close one tab of the active scope. An editor buffer is dropped only for the exact version approved; a Markdown tab holds nothing. */
  const requestClose = (id: TabId) =>
    runTransition("close", async () => {
      const key = activeKeyRef.current;
      const parsed = parseId(id);
      if (!parsed) return;
      const relPath = parsed.relPath;
      if (parsed.kind !== "editor") {
        // A rendered surface or the place's own Task or Changes tab holds no buffer.
        updateScope(key, id, (s) => ({ ...s, tabs: closeTab(s.tabs, id) }));
        return;
      }
      for (;;) {
        const approval = await confirmTab(key, relPath);
        const scope = scopesRef.current[key];
        if (!approval || !scope || !findTab(scope.tabs, id)) return;
        // Edited since the approval: ask again rather than drop it.
        if (!approvalHolds(approval, liveVersion(relPath))) continue;
        const current = rootRef.current;
        if (current) disposeModel(modelUri(current.path, relPath));
        updateScope(key, id, (s) => {
          const views = { ...s.views };
          delete views[relPath];
          return { ...s, tabs: closeTab(s.tabs, id), views };
        });
        return;
      }
    });

  /** Cmd+W: close the active closable tab. On Home or the Overview there is none. */
  const closeActiveTab = () => {
    const id = scopesRef.current[activeKeyRef.current]?.tabs.active ?? null;
    return id === null ? Promise.resolve() : requestClose(id);
  };
  const closeActiveTabRef = useRef(closeActiveTab);
  closeActiveTabRef.current = closeActiveTab;

  const saveActive = () => {
    const key = activeKeyRef.current;
    const scope = scopesRef.current[key];
    const tab = scope ? shownEditor(scope) : undefined;
    if (tab) void saveTabRef.current(key, tab.relPath);
  };

  /** Cmd+Shift+] and Cmd+Shift+[: step through the strip, the pinned Overview first, wrapping around. */
  const stepTab = (delta: 1 | -1) => {
    if (lockRef.current) return;
    const scope = scopesRef.current[activeKeyRef.current];
    if (!scope || scope.kind === "home" || scope.tabs.tabs.length === 0) return;
    const order: Array<TabId | null> = [null, ...scope.tabs.tabs.map(idOf)];
    const at = order.indexOf(scope.tabs.active);
    const next = order[(at + delta + order.length) % order.length];
    if (next === null) showOverview();
    else showTab(next);
  };

  const setSearching = (key: ScopeKey, on: boolean) => updateScope(key, null, (s) => (s.searching === on ? s : { ...s, searching: on }));

  /** Cmd+Shift+F: the sidebar Search of the place showing. */
  const focusSearch = () => {
    if (lockRef.current) return;
    const scope = scopesRef.current[activeKeyRef.current];
    if (!scope || scope.kind === "home" || statusOf(scope) === "missing") return;
    setSearching(scope.key, true);
    setSearchFocus((n) => n + 1);
  };

  /** Escape: close a modal; else clear Search and return focus to the editor. */
  const escape = () => {
    const modals = modalsRef.current;
    if (modals.prompt) return modals.prompt.resolve("cancel");
    if (modals.recreatePrompt) return modals.recreatePrompt.resolve(false);
    if (modals.deletePrompt) return modals.deletePrompt.resolve(false);
    if (modals.namePrompt) return setNamePrompt(null);
    const scope = scopesRef.current[activeKeyRef.current];
    if (scope && scope.searching) {
      setSearching(scope.key, false);
      editorRef.current?.focus();
    }
  };

  /**
   * The keyboard contract (DESIGN.md section 8). Cmd+W belongs to the host:
   * in the app window the File menu reaches the frontend as a
   * `close-tab-requested` event and the key itself is only swallowed so
   * nothing else can act on it; in Chrome the key is Chrome's own.
   */
  const handleKey = (e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "preventDefault">) => {
    const cmd = (e.metaKey || e.ctrlKey) && !e.altKey;
    const key = e.key.toLowerCase();
    if (e.key === "Escape") return escape();
    if (!cmd) return;
    if (!e.shiftKey && key === "s") {
      e.preventDefault();
      return saveActive();
    }
    if (!e.shiftKey && key === "w") {
      // Command-W belongs to the host either way, so alabs never closes a
      // tab from the raw key: the desktop menu delivers it as an event, and
      // Chrome closes its own tab.
      if (host.menuOwnsCloseTab) e.preventDefault();
      return;
    }
    if (!e.shiftKey && key === "r") {
      e.preventDefault();
      return void refresh();
    }
    if (!e.shiftKey && key === "0") {
      e.preventDefault();
      return goHome();
    }
    if (e.shiftKey && key === "f") {
      e.preventDefault();
      return focusSearch();
    }
    if (e.shiftKey && (e.key === "]" || e.key === "}")) {
      e.preventDefault();
      return stepTab(1);
    }
    if (e.shiftKey && (e.key === "[" || e.key === "{")) {
      e.preventDefault();
      return stepTab(-1);
    }
  };
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;

  /**
   * The shown model changed: recompute the active tab's dirty flag. Reads a
   * version number, never the text. Monaco raises the content-change event
   * for an undo or redo before it restores the alternative version id, so
   * the version is read once the edit has settled; otherwise a buffer undone
   * back to its saved state would stay marked unsaved (found in Step 7).
   */
  const onModelChanged = () => queueMicrotask(recomputeDirty);

  const recomputeDirty = () => {
    const current = rootRef.current;
    const key = activeKeyRef.current;
    const scope = scopesRef.current[key];
    const tab = scope ? shownEditor(scope) : undefined;
    if (!current || !tab) return;
    const path = tab.relPath;
    const model = monacoEditor.getModel(modelUri(current.path, path));
    if (!model) return;
    updateScope(key, editorId(path), (s) => ({
      ...s,
      tabs: updateTab(s.tabs, editorId(path), (t) => (t.kind === "loaded" ? { ...t, dirty: model.getAlternativeVersionId() !== t.savedVersion } : t)),
    }));
    // Unsaved text stops being only in this tab a moment after typing stops.
    keepDraftSoon(path);
  };

  // The shortcuts, wherever focus is (the editor's own Cmd+S is added on mount too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleKeyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Quit after every buffer in every scope is approved. The approvals are
   * re-checked after the layout is written, immediately before exiting; a
   * buffer edited in between is asked about again.
   */
  const requestQuit = () =>
    runTransition("quit", async () => {
      for (;;) {
        const approvals = await confirmAll();
        if (!approvals) return;
        await flushUi();
        const paths = allTabs(scopesRef.current).map((t) => t.relPath);
        if (unapproved(paths, approvals, versionsOf).length === 0) {
          await quit();
          return;
        }
      }
    });
  const requestQuitRef = useRef(requestQuit);
  requestQuitRef.current = requestQuit;

  // Closing the window or quitting the app both go through the unsaved-edits guard.
  useEffect(() => {
    let disposed = false;
    const unlistenClose = host.onWindowClose(() => void requestQuitRef.current());
    const unlistenQuit = host.onQuitRequested(() => void requestQuitRef.current());
    // File > Close Tab (Cmd+W) from the native menu: the tab, never the window.
    const unlistenCloseTab = host.onCloseTabRequested(() => void closeActiveTabRef.current());
    return () => {
      disposed = true;
      void unlistenClose.then((fn) => disposed && fn());
      void unlistenQuit.then((fn) => disposed && fn());
      void unlistenCloseTab.then((fn) => disposed && fn());
    };
  }, []);

  const shownTab = active.kind === "home" ? undefined : activeTab(active.tabs);

  // A search hit or a restored view: move the cursor once that tab is showing.
  // The editor wrapper switches models in its own effect, which runs first.
  useEffect(() => {
    if (!reveal || shownTab?.kind !== "loaded" || shownTab.relPath !== reveal.relPath) return;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (reveal.line !== undefined) {
      const position = model.validatePosition({ lineNumber: reveal.line, column: reveal.column ?? 1 });
      editor.setPosition(position);
      if (reveal.scrollTop === undefined) editor.revealLineInCenter(position.lineNumber);
    }
    if (reveal.scrollTop !== undefined) editor.setScrollTop(reveal.scrollTop);
    editor.focus();
    setReveal(null);
  }, [reveal, active.tabs.active, shownTab, editorReady]);

  // While the Task tab showing has a ticked context file with unsaved edits,
  // the notice line says which file to save; it clears when the block lifts.
  const shownDraft = active.kind === "work" && shownTab?.kind === "task" ? active.task : null;
  const shownBlocker = shownDraft === null ? null : copyBlocker(shownDraft.text, selectedContext(contextCandidates(scopes, active.key), shownDraft.selected));
  const blockedPath = shownBlocker?.kind === "dirty" ? shownBlocker.relPath : null;
  useEffect(() => {
    if (blockedPath !== null) {
      setNotice(taskBlockedNotice(blockedPath));
      return;
    }
    setNotice((n) => (n !== null && isTaskBlockedNotice(n) ? null : n));
  }, [blockedPath]);

  const activeWork = ui.activeWork;
  const activeWorkScope = activeWork === null ? undefined : scopes[workKey(activeWork)];
  const counts = active.kind === "home" ? null : scopeCounts(active);
  const dirtyPaths = (scope: Scope) => new Set(scope.tabs.tabs.filter((t) => t.kind === "loaded" && t.dirty).map((t) => t.relPath));
  const listing = home?.listing ?? null;
  const shownNotice: Notice | null = lockText !== null ? { text: lockText, error: false, log: null } : notice;
  const placeScopes = Object.values(scopes).filter((s) => s.kind !== "home");
  const live: LivePlace[] = placeScopes.map((s) => ({
    key: s.key,
    kind: s.kind === "know" ? "know" : "work",
    prefix: s.prefix,
    role: s.role,
    status: placeStatus(s, listing),
  }));
  const liveRoles = new Set(placeScopes.flatMap((s) => (s.role === null ? [] : [s.role])));
  const activeMissing = active.kind !== "home" && placeStatus(active, listing) === "missing";
  const whereGit = active.kind === "work" ? whereGitText(active.git, Date.now() / 1000) : null;

  initial?.actions?.({
    enterPlace,
    openVisualView,
    runRaven,
    runRavenRoot,
    enterRole,
    createRole,
    goHome,
    changeRoot,
    openPath,
    showTab,
    showOverview,
    requestClose,
    closeActiveTab,
    saveActive,
    refresh,
    requestQuit,
    renameEntry,
    moveEntry,
    openTask: () => openSurface("task"),
    openChanges: () => openSurface("changes"),
    setTaskDraft,
    copyTaskPacket,
    openTerminal: openTerminalHere,
    selectLocalModel,
    modelChanged: onModelChanged,
    beginEditing,
    takeOverEditing,
    reviewDraft,
    discardDraft,
    exportDraft,
    keepDraftNow,
    handleKey,
    snapshot: () => ({
      activeKey: activeKeyRef.current,
      activeWork: uiRef.current.activeWork,
      scopes: scopesRef.current,
      listing: homeRef.current?.listing ?? null,
      baselines: uiRef.current.baselines,
      localModel: uiRef.current.localModel,
      builds: queueRef.current?.snapshot() ?? new Map(),
      writing: writingRef.current,
      drafts: recorderRef.current
        ? new Map(recorderRef.current.paths().flatMap((path) => {
            const state = recorderRef.current?.state(path);
            return state ? ([[path, state]] as [string, DraftState][]) : [];
          }))
        : new Map<string, DraftState>(),
      views: new Set(homeRef.current?.views ?? []),
      rootView: homeRef.current?.rootView ?? null,
      rootReload: rootReloadRef.current,
    }),
  });

  const whereRight =
    active.kind === "home"
      ? root?.path ?? ""
      : shownTab && shownTab.kind !== "task" && shownTab.kind !== "changes"
        ? `${displayPath(shownTab.relPath, active.prefix)}${shownTab.kind === "loaded" && shownTab.dirty ? " •" : ""}`
        : `${root?.path ?? ""}/${active.prefix}`;
  const gitOf = (scope: Scope) => (scope.kind === "work" ? (home?.git.get(scope.prefix) ?? "none") : "none");

  return (
    <div className="shell">
      <Rail
        root={root}
        listing={listing}
        repos={home?.git ?? null}
        live={live}
        activeKey={activeKey}
        activeWork={activeWork}
        locked={locked}
        canChangeRoot={!ownsRoot}
        onHome={goHome}
        onOpenPlace={enterPlace}
        onOpenRole={enterRole}
        onCreateRole={(role) => void createRole(role)}
        onChangeRoot={() => void changeRoot()}
      />
      <aside className="sidebar" role="complementary" inert={locked}>
        {root && active.kind === "home" && (
          <HomeSidebar
            root={root}
            home={home}
            locked={locked}
            activeWork={activeWork}
            liveRoles={liveRoles}
            builds={builds}
            onRefresh={() => void refresh()}
            onOpenPlace={(name) => void enterPlace(name)}
            onOpenView={(name) => void openVisualView(name)}
            onOpenRole={enterRole}
            onNewFolder={startNewPlace}
            onCreateRole={(role) => void createRole(role)}
          />
        )}
        {root &&
          placeScopes.map((scope) => (
            <div key={scope.key} hidden={scope.key !== activeKey} className="sidebar-scope">
              <FileTree
                  prefix={scope.prefix}
                  placeName={scope.name}
                  activePath={activeTab(scope.tabs)?.relPath ?? null}
                  dirtyPaths={dirtyPaths(scope)}
                  selectedDir={scope.selectedDir}
                  expanded={scope.expanded}
                  refresh={scope.refresh}
                  reload={scope.reload}
                  locked={locked}
                  missing={placeStatus(scope, listing) === "missing"}
                  searching={scope.searching}
                  onSearching={(on) => setSearching(scope.key, on)}
                  searchFocus={searchFocus}
                  onRefresh={() => void refresh()}
                  onOpenFile={(relPath) => void openPath(relPath)}
                  onOpenResult={(relPath, line) => void openPath(relPath, line)}
                  onSelectDir={(relPath) => selectDir(scope.key, relPath)}
                  onToggleDir={(relPath) => toggleDir(scope.key, relPath)}
                  onNewFile={() => startCreate("file")}
                  onNewFolder={() => startCreate("folder")}
                  onRename={startRename}
                  onMove={startMove}
                  onDelete={(entry) => void startDelete(entry)}
                />
            </div>
          ))}
      </aside>
      <main className="main" role="main" inert={locked} aria-busy={locked}>
        <div className="tab-strip" role="tablist">
          {active.kind === "home" && (
            <div role="tab" aria-selected className="tab tab-active tab-pinned">
              <span className="tab-name">⌂ Home</span>
            </div>
          )}
          {active.kind !== "home" && (
            <div
              role="tab"
              aria-selected={active.tabs.active === null}
              className={"tab tab-pinned" + (active.tabs.active === null ? " tab-active" : "")}
              title={`${root?.path ?? ""}/${active.prefix}`}
              onClick={showOverview}
            >
              <span className="tab-name">⌂ Overview</span>
            </div>
          )}
          {active.kind !== "home" &&
            active.tabs.tabs.map((tab) => {
              const id = idOf(tab);
              const dirty = tab.kind === "loaded" && tab.dirty;
              const disk = tab.kind === "loaded" ? tab.disk : "ok";
              const isActive = id === active.tabs.active;
              return (
                <div
                  key={id}
                  role="tab"
                  aria-selected={isActive}
                  className={"tab" + (isActive ? " tab-active" : "") + (dirty ? " tab-dirty" : "") + (disk !== "ok" ? " tab-disk" : "")}
                  title={
                    disk === "missing"
                      ? `${tab.relPath} (missing on disk)`
                      : disk === "conflict"
                        ? `${tab.relPath} (changed on disk)`
                        : disk === "uncertain"
                        ? `${tab.relPath} (last save unconfirmed)`
                        : tab.kind === "markdown"
                          ? `${tab.relPath} · rendered`
                          : tab.kind === "view"
                            ? `${tab.relPath} · visual view`
                            : tab.kind === "task" || tab.kind === "changes"
                              ? `${tab.relPath} · ${tab.kind}`
                              : tab.relPath
                  }
                  onClick={() => showTab(id)}
                >
                  {tab.kind === "view" && <span className="tag tab-kind">view</span>}
                  <span className="tab-name">{tab.name}</span>
                  {disk !== "ok" && (
                    <span
                      className="tab-disk-mark"
                      aria-label={
                        disk === "missing" ? "missing on disk" : disk === "uncertain" ? "last save unconfirmed" : "changed on disk"
                      }
                    >
                      !
                    </span>
                  )}
                  <button
                    className="tab-close"
                    title={dirty ? "unsaved changes" : "close"}
                    aria-label={`close ${tab.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void requestClose(id);
                    }}
                  >
                    <span className="tab-dot">•</span>
                    <span className="tab-x">×</span>
                  </button>
                </div>
              );
            })}
        </div>
        <div className="where mono">
          <span className="where-mark">◉</span>
          <span className="where-place strong">{active.kind === "home" ? "Home" : active.name}</span>
          {root && (
            <>
              <span className="where-sep muted">/</span>
              <span className="where-path muted" title={whereRight}>
                <span className="ltr">{whereRight}</span>
              </span>
              {whereGit && <span className="where-git muted">{whereGit}</span>}
            </>
          )}
        </div>
        {shownNotice && (
          <div className={"notice" + (shownNotice.error ? " notice-error" : "")} role="status">
            {shownNotice.text}
          </div>
        )}
        <div className="body">
          {!root && (
            <div className="first-launch">
              <p>Choose your alabs root folder.</p>
              <button type="button" className="chip chip-primary" onClick={() => void chooseRoot()} disabled={locked}>
                Choose folder…
              </button>
            </div>
          )}
          {root && active.kind === "home" && (
            <HomeBody
              root={root}
              home={home}
              loading={homeLoading}
              activeWork={activeWork}
              activeCounts={activeWorkScope ? scopeCounts(activeWorkScope) : null}
              locked={locked}
              rootBuild={builds.get(ROOT_BUILD_KEY) ?? null}
              rootReload={rootReload}
              onOpenPlace={(name) => void enterPlace(name)}
              onOpenView={(name) => void openVisualView(name)}
              onOpenRole={enterRole}
              onRebuildRoot={runRavenRoot}
              onRefresh={() => void refresh()}
            />
          )}
          {root &&
            placeScopes.map((scope) => (
              <div key={scope.key} hidden={scope.key !== activeKey || scope.tabs.active !== null} className="overview-scope">
                <Overview
                  prefix={scope.prefix}
                  placeName={scope.name}
                  isWork={scope.kind === "work"}
                  rootPath={root.path}
                  missing={placeStatus(scope, listing) === "missing"}
                  reload={scope.reload}
                  locked={locked}
                  gitKind={gitOf(scope)}
                  hasView={scope.kind === "work" && (home?.views.has(scope.prefix) ?? false)}
                  dirtyPaths={dirtyPaths(scope)}
                  onOpenPath={(relPath) => void openPath(relPath)}
                  onOpenEditor={(relPath) => void openPath(relPath, null, "editor")}
                  onOpenView={() => void openPath(visualViewPath(scope.prefix), null, "view")}
                  onOpenTask={() => openSurface("task")}
                  onOpenChanges={() => openSurface("changes")}
                  onOpenTerminal={() => void openTerminalHere()}
                  onRevealDir={(relPath) => {
                    updateScope(scope.key, null, (s) => ({ ...s, expanded: new Set(s.expanded).add(relPath), selectedDir: relPath }));
                  }}
                  onRefresh={() => void refresh()}
                  onHome={goHome}
                  onGit={(git: GitInspection | null) => updateScope(scope.key, null, (s) => (s.git === git ? s : { ...s, git }))}
                  ask={
                    scope.role === "wiki"
                      ? {
                          rootPath: root.path,
                          folders: { context: listing?.roles.context.kind === "present" ? listing.roles.context.name : null, wiki: scope.prefix },
                          model: ui.localModel,
                          onSelectModel: selectLocalModel,
                        }
                      : undefined
                  }
                />
              </div>
            ))}
          {root &&
            placeScopes.flatMap((scope) =>
              scope.tabs.tabs
                .filter((tab) => tab.kind === "markdown")
                .map((tab) => (
                  <div
                    key={`${scope.key}|${tab.relPath}`}
                    hidden={scope.key !== activeKey || scope.tabs.active !== idOf(tab)}
                    className="overview-scope"
                  >
                    <MarkdownView
                      relPath={tab.relPath}
                      prefix={scope.prefix}
                      reload={scope.surfaceReload}
                      locked={locked}
                      dirtyInEditor={dirtyPaths(scope).has(tab.relPath)}
                      onOpenPath={(relPath) => void openPath(relPath)}
                      onOpenSource={() => void openPath(tab.relPath, null, "editor")}
                      onOpenTab={() => showTab(editorId(tab.relPath))}
                    />
                  </div>
                )),
            )}
          {root &&
            placeScopes.flatMap((scope) =>
              scope.tabs.tabs
                .filter((tab) => tab.kind === "view")
                .map((tab) => (
                  <div
                    key={`${scope.key}|view|${tab.relPath}`}
                    hidden={scope.key !== activeKey || scope.tabs.active !== idOf(tab)}
                    className="overview-scope"
                  >
                    <VisualView
                      relPath={tab.relPath}
                      placeName={scope.name}
                      reload={scope.surfaceReload}
                      locked={locked}
                      shown={scope.key === activeKey && scope.tabs.active === idOf(tab)}
                      onOpenPath={(relPath) => void openPath(relPath)}
                      onOpenSource={() => void openPath(tab.relPath, null, "editor")}
                      onRefresh={() => void refresh()}
                      build={builds.get(scope.prefix) ?? null}
                      onRebuild={() => runRaven(scope.prefix)}
                    />
                  </div>
                )),
            )}
          {root &&
            placeScopes
              .filter((scope) => scope.kind === "work")
              .flatMap((scope) =>
                scope.tabs.tabs
                  .filter((tab) => tab.kind === "task")
                  .map((tab) => (
                    <div key={`${scope.key}|task`} hidden={scope.key !== activeKey || scope.tabs.active !== idOf(tab)} className="overview-scope">
                      <TaskView
                        placeName={scope.name}
                        draft={scope.task}
                        candidates={contextCandidates(scopes, scope.key)}
                        locked={locked}
                        onDraft={(update) => updateScope(scope.key, null, (s) => ({ ...s, task: update(s.task) }))}
                        onCopy={() => void copyTaskPacket()}
                        onTerminal={() => void openTerminalHere()}
                      />
                    </div>
                  )),
              )}
          {root &&
            placeScopes
              .filter((scope) => scope.kind === "work")
              .flatMap((scope) =>
                scope.tabs.tabs
                  .filter((tab) => tab.kind === "changes")
                  .map((tab) => (
                    <div key={`${scope.key}|changes`} hidden={scope.key !== activeKey || scope.tabs.active !== idOf(tab)} className="overview-scope">
                      <ChangesView
                        prefix={scope.prefix}
                        placeName={scope.name}
                        gitKind={gitOf(scope)}
                        baseline={ui.baselines[scope.prefix] ?? null}
                        taskStartedAt={scope.taskStartedAt}
                        reload={scope.surfaceReload}
                        locked={locked}
                        dirtyPaths={dirtyPaths(scope)}
                        onOpenPath={(relPath) => void openPath(relPath)}
                        onOpenTab={(relPath) => showTab(editorId(relPath))}
                        onRefresh={() => void refresh()}
                      />
                    </div>
                  )),
              )}
          {root && active.kind !== "home" && shownTab && (shownTab.kind === "loaded" || shownTab.kind === "unsupported") && (
            <div className="editor-body">
              {shownTab.kind === "unsupported" && (
                <div className="editor-message">
                  <div className="mono muted">{displayPath(shownTab.relPath, active.prefix)}</div>
                  <div>{failureNotice(shownTab.message).text}</div>
                </div>
              )}
              {shownTab.kind === "loaded" && shownTab.disk === "missing" && (
                <div className="disk-banner" role="status">
                  File no longer exists on disk.
                  {shownTab.dirty ? " Your unsaved edits are kept in this tab." : ""}{" "}
                  {activeMissing ? "Put the folder back, then Refresh, to save it." : "Saving will ask before recreating it."}
                </div>
              )}
              {shownTab.kind === "loaded" && shownTab.disk === "conflict" && (
                <div className="disk-banner" role="status">
                  This file changed on disk since it was opened. Your unsaved edits are kept in this tab and saving is blocked
                  while they differ from the disk copy.
                </div>
              )}
              {shownTab.kind === "loaded" && shownTab.disk === "uncertain" && (
                <div className="disk-banner" role="status">
                  alabs never heard back from the last save of this file, and the file has changed on disk since. It may have been
                  that save, or something else. Your edits are kept in this tab. Refresh to see what is on disk before saving
                  again; alabs will not write anything until you do.
                </div>
              )}
              {shownTab.kind === "loaded" && !writing && canEdit && (
                <div className="disk-banner" role="status">
                  Another alabs window is editing this root, so this one is read-only.{" "}
                  <button type="button" className="chip" onClick={() => void takeOverEditing(true)}>
                    Take over editing
                  </button>
                </div>
              )}
              {shownTab.kind === "loaded" &&
                (() => {
                  const kept = drafts.get(shownTab.relPath);
                  if (!kept || kept.trouble === null) return null;
                  return (
                    <div className="disk-banner" role="status">
                      {kept.kept === "pending"
                        ? "alabs could not keep your unsaved work for this file anywhere. It is only in this tab."
                        : "alabs kept your unsaved work, but not everywhere it wanted to."}{" "}
                      <button type="button" className="chip" onClick={() => exportDraft(shownTab.relPath)}>
                        Save a copy…
                      </button>
                    </div>
                  );
                })()}
              {shownTab.kind === "loaded" && (
                <Editor
                  path={modelUri(root.path, shownTab.relPath).toString()}
                  keepCurrentModel
                  theme="vs-dark"
                  onMount={(editor) => {
                    editorRef.current = editor;
                    setEditorReady((n) => n + 1);
                    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, saveActive);
                    // Subscribed here rather than via the wrapper's onChange, which
                    // would copy the whole buffer out of the editor on every keystroke.
                    editor.onDidChangeModelContent(onModelChanged);
                  }}
                  options={{
                    readOnly: locked || !canEdit || !writing,
                    minimap: { enabled: false },
                    wordWrap: "on",
                    fontSize: 14,
                  }}
                />
              )}
            </div>
          )}
        </div>
      </main>
      <footer className="status mono">
        <span className="where-mark">◉</span>{" "}
        {active.kind === "home" || !counts ? "Home" : `${active.name} · ${counts.tabs} ${counts.tabs === 1 ? "tab" : "tabs"} · ${counts.unsaved} unsaved`}
      </footer>
      {namePrompt && (
        <div className="modal-backdrop">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={namePrompt.kind === "place" ? "New folder" : namePrompt.kind}
            onSubmit={(e) => {
              e.preventDefault();
              void submitPrompt();
            }}
          >
            <div className="modal-text">
              {namePrompt.kind === "place" && `New folder inside ${root?.path ?? "the root"}`}
              {namePrompt.kind === "rename" && `Rename ${displayPath(namePrompt.entry.rel_path, active.prefix)}`}
              {namePrompt.kind === "move" && `Move ${displayPath(namePrompt.entry.rel_path, active.prefix)} to folder (blank for ${active.name})`}
              {(namePrompt.kind === "file" || namePrompt.kind === "folder") &&
                `New ${namePrompt.kind} in ${displayPath(namePrompt.parent, active.prefix) || active.name}`}
            </div>
            <input
              className="input modal-input mono"
              autoFocus
              spellCheck={false}
              placeholder={namePrompt.kind === "move" ? `path inside ${active.name}` : namePrompt.kind === "file" ? "name.ext" : "folder name"}
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setNameError(null);
              }}
            />
            {nameError && <div className="modal-error">{nameError}</div>}
            <div className="modal-actions">
              <button type="button" className="chip" onClick={cancelPrompt}>
                Cancel
              </button>
              <button type="submit" className="chip chip-primary">
                {namePrompt.kind === "rename" ? "Rename" : namePrompt.kind === "move" ? "Move" : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}
      {deletePrompt && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Move to Trash"
          >
            <div className="modal-text">
              Move {deletePrompt.entry.is_dir ? "folder" : "file"} <strong>{deletePrompt.entry.name}</strong> to the Trash?
              {deletePrompt.entry.is_dir && " Everything inside it will go with it."}
            </div>
            {deletePrompt.error && <div className="modal-error">{deletePrompt.error}</div>}
            <div className="modal-actions">
              <button type="button" className="chip" autoFocus onClick={() => deletePrompt.resolve(false)}>
                Cancel
              </button>
              <button type="button" className="chip chip-primary" onClick={() => deletePrompt.resolve(true)}>
                Move to Trash
              </button>
            </div>
          </div>
        </div>
      )}
      {waiting && (
        <div className="modal-backdrop">
          <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="Unsaved work from before">
            <div className="modal-text">
              alabs kept unsaved work from before. Nothing has been written to your files: open one to look at it beside what is
              on disk, save a copy, or throw it away.
            </div>
            <ul className="recovery-list">
              {waiting.drafts.map((draft) => (
                <li key={draft.relPath} className="recovery-row">
                  <span className="mono recovery-path">{draft.relPath}</span>
                  <span className="muted recovery-when">
                    {draft.stamp === null ? "file missing · " : ""}
                    {new Date(draft.updatedAt).toLocaleString()}
                  </span>
                  <span className="recovery-actions">
                    <button type="button" className="chip chip-primary" onClick={() => void reviewDraft(draft)}>
                      Open
                    </button>
                    <button type="button" className="chip" onClick={() => exportDraft(draft.relPath, draft.contents)}>
                      Save a copy…
                    </button>
                    <button type="button" className="chip chip-danger" onClick={() => discardDraft(draft)}>
                      Discard
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {waiting.unreadable.length > 0 && (
              <div className="modal-text muted">
                alabs could not read {waiting.unreadable.length === 1 ? "one kept file" : `${waiting.unreadable.length} kept files`}
                . {waiting.unreadable.length === 1 ? "It was" : "They were"} left exactly where {waiting.unreadable.length === 1 ? "it is" : "they are"}:
                <ul className="recovery-list">
                  {waiting.unreadable.map((name) => (
                    <li key={name} className="mono recovery-path">
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="chip" autoFocus onClick={() => setWaiting(null)}>
                Later
              </button>
            </div>
          </div>
        </div>
      )}
      {recreatePrompt && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Recreate file"
          >
            <div className="modal-text">
              <strong>{recreatePrompt.relPath}</strong> no longer exists on disk. Recreate it at that path with the contents of this
              tab? Your edits stay in the tab either way.
            </div>
            <div className="modal-actions">
              <button type="button" className="chip" autoFocus onClick={() => recreatePrompt.resolve(false)}>
                Keep in tab only
              </button>
              <button type="button" className="chip chip-primary" onClick={() => recreatePrompt.resolve(true)}>
                Recreate file
              </button>
            </div>
          </div>
        </div>
      )}
      {prompt && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Unsaved changes"
          >
            <div className="modal-text">{prompt.name} has unsaved changes. Save them before continuing?</div>
            <div className="modal-actions">
              <button type="button" className="chip" onClick={() => prompt.resolve("cancel")}>
                Cancel
              </button>
              <button type="button" className="chip chip-danger" onClick={() => prompt.resolve("discard")}>
                Discard
              </button>
              <button type="button" className="chip chip-primary" autoFocus onClick={() => prompt.resolve("save")}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
