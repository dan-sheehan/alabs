import type { ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { type AppActions, type AppInitial } from "./App";
import { FileTree } from "./FileTree";
import { Rail } from "./Rail";
import { HomeBody } from "./Home";
import { Overview } from "./Overview";
import { MarkdownView } from "./MarkdownView";
import { VisualView } from "./VisualView";
import { TaskView } from "./TaskView";
import { ChangesView } from "./ChangesView";
import { appendLog, gitQuery, moveItem, openTerminal, quit, readFile, saveFile, saveUiState, statFile } from "./subject";
import type { Entry, FileContent, FileStamp, GitQueryResult } from "./subject";
import { classifyRoot, workKey } from "./places";
import { editorId, idOf, markdownId, tabIdOf } from "./tabs";
import { contextCandidates } from "./task";
import { EMPTY_STATE, setRoot, setScopeLayout, type UiState } from "./uiState";

// Step 6 at the App level: the Task and Changes tab kinds, the scope-owned
// draft, context candidates, the copy with its blockers, the clipboard
// success and fallback paths, the handoff baseline (recorded, replaced,
// never task text, never for a non-Git place), Open in Terminal, the
// task-started cue and Refresh, restore and persistence of `task:` and
// `changes:` ids, and the ownership rules the throwaway diff models never
// join. Driven like the Step 3 to 5 tests: one server render with seeded
// state, then the actions the shell hands out. The surfaces are mocked;
// their own behaviour is tested in TaskView.test.tsx and ChangesView.test.tsx.
interface Model {
  content: string;
  version: number;
  dispose: ReturnType<typeof vi.fn>;
  getAlternativeVersionId: () => number;
  getValue: () => string;
  setValue: (text: string) => void;
}

type Choice = "save" | "discard" | "cancel";

const fixture = vi.hoisted(() => ({
  models: new Map<string, Model>(),
  /** Models under a non-file scheme, as the Changes tab makes them; never file buffers. */
  foreign: [] as Array<{ uri: { scheme: string; path: string } }>,
  prompts: [] as Array<{ name: string; resolve: (choice: Choice) => void }>,
}));

vi.mock("./FileTree", () => ({ FileTree: (_props: ComponentProps<typeof FileTree>) => null }));
vi.mock("./Overview", () => ({ Overview: (_props: ComponentProps<typeof Overview>) => null }));
vi.mock("./MarkdownView", () => ({ MarkdownView: (_props: ComponentProps<typeof MarkdownView>) => null }));
vi.mock("./VisualView", () => ({ VisualView: (_props: ComponentProps<typeof VisualView>) => null }));
vi.mock("./TaskView", () => ({ TaskView: (_props: ComponentProps<typeof TaskView>) => null }));
vi.mock("./ChangesView", () => ({ ChangesView: (_props: ComponentProps<typeof ChangesView>) => null }));
vi.mock("./Rail", () => ({ Rail: (_props: ComponentProps<typeof Rail>) => null }));
vi.mock("./Home", () => ({ HomeBody: (_props: ComponentProps<typeof HomeBody>) => null, HomeSidebar: () => null }));
vi.mock("@monaco-editor/react", () => ({ default: () => null }));
vi.mock("monaco-editor", () => ({
  Uri: { file: (path: string) => path, from: (parts: { scheme: string; path: string }) => parts },
  KeyCode: {},
  KeyMod: {},
  editor: {
    getModel: (uri: string) => fixture.models.get(uri),
    getModels: () => [...[...fixture.models.keys()].map((path) => ({ uri: { scheme: "file", path } })), ...fixture.foreign],
    createModel: (content: string, _language: string, uri: string) => {
      const model: Model = {
        content,
        version: 1,
        getAlternativeVersionId: () => model.version,
        getValue: () => model.content,
        setValue: (text: string) => {
          model.content = text;
          model.version += 1;
        },
        dispose: vi.fn(() => {
          fixture.models.delete(uri);
        }),
      };
      fixture.models.set(uri, model);
      return model;
    },
  },
}));
// The runtime seam: no host event fires in a test, and every native call
// goes through the mocked `./subject` below rather than the bridge.
vi.mock("./runtime", () => {
  const never = async () => () => {};
  return {
    bridge: { invoke: vi.fn(), listen: never },
    host: {
      pickFolder: vi.fn(),
      quit: vi.fn(),
      onWindowClose: never,
      onQuitRequested: never,
      onCloseTabRequested: never,
      menuOwnsCloseTab: true,
    },
  };
});
vi.mock("./subject", () => ({
  searchPlace: vi.fn(),
  pickFolder: vi.fn(),
  openRoot: vi.fn(),
  readFile: vi.fn(),
  collectInventory: vi.fn(),
  generateLocalModelJson: vi.fn(),
  writeViewFiles: vi.fn(),
  writeRootViewFiles: vi.fn(),
  statFile: vi.fn(),
  createFile: vi.fn(),
  createDir: vi.fn(),
  listDir: vi.fn(async () => []),
  entryKind: vi.fn(async () => "none"),
  gitFacts: vi.fn(async () => ({ kind: "none" })),
  gitQuery: vi.fn(),
  openTerminal: vi.fn(async () => {}),
  loadUiState: vi.fn(),
  moveItem: vi.fn(async (_from: string, toParent: string, name: string) => `${toParent}/${name}`),
  quit: vi.fn(),
  recreateFile: vi.fn(),
  saveFile: vi.fn(),
  saveUiState: vi.fn(async () => {}),
  appendLog: vi.fn(async () => {}),
  trashItem: vi.fn(),
}));

const root = { path: "/root", name: "root" };
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const taskId = tabIdOf("task", "defiance");
const changesId = tabIdOf("changes", "defiance");
const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });
const stamp = (mtime = 0): FileStamp => ({ identity: "1:2", mtime_secs: mtime, mtime_nanos: 0, len: 9 });
const file = (relPath: string): FileContent => ({ name: relPath.split("/").pop() ?? relPath, content: "from disk", stamp: stamp() });
const tabIds = (actions: AppActions, key: string) => actions.snapshot().scopes[key].tabs.tabs.map(idOf);
const active = (actions: AppActions, key: string) => actions.snapshot().scopes[key].tabs.active;
const scope = (actions: AppActions, key: string) => actions.snapshot().scopes[key];
const logged = () => vi.mocked(appendLog).mock.calls.map((c) => String(c[0]));
const written = () => vi.mocked(saveUiState).mock.calls.map((c) => String(c[0]));
const writeText = vi.fn<(text: string) => Promise<void>>();
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText } }, configurable: true, writable: true });

/** Defiance and cockpit each remember one editor tab; optionally defiance also remembers its Task and Changes tabs and a stray one. */
function rememberedUi(surfaces = false): UiState {
  let ui = setRoot(EMPTY_STATE, root.path);
  ui = setScopeLayout(ui, "work:defiance", {
    expanded: [],
    tabs: surfaces ? ["editor:defiance/first.txt", taskId, changesId, "task:cockpit"] : ["editor:defiance/first.txt"],
    active: surfaces ? changesId : "editor:defiance/first.txt",
    views: {},
    visited: 2,
  });
  ui = setScopeLayout(ui, "work:cockpit", { expanded: [], tabs: ["editor:cockpit/notes.txt"], active: "editor:cockpit/notes.txt", views: {}, visited: 1 });
  return ui;
}

function render(ui: UiState = rememberedUi()): AppActions {
  let actions!: AppActions;
  fixture.prompts = [];
  const initial: AppInitial = {
    ui,
    root,
    home: {
      listing: classifyRoot([dir("defiance"), dir("cockpit"), dir("views"), dir("wiki")]),
      views: new Set(["defiance"]),
      git: new Map([["defiance", "repo"]]),
      rootView: { exists: false, saved: null },
    },
    actions: (a) => {
      actions = a;
    },
    onUnsavedPrompt: (name, resolve) => fixture.prompts.push({ name, resolve }),
  };
  renderToString(<App initial={initial} />);
  return actions;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function enterDefiance(actions: AppActions) {
  await actions.enterPlace("defiance");
  expect(fixture.models.has("/root/defiance/first.txt")).toBe(true);
}

/** Write a task and tick `paths`; the draft is the scope's. */
function draft(actions: AppActions, text: string, paths: string[] = []) {
  actions.setTaskDraft((d) => ({ ...d, text, selected: new Set(paths) }));
}

const head = (commit: string | null, clean: boolean): GitQueryResult => ({ kind: "head", commit, clean });

beforeEach(() => {
  vi.clearAllMocks();
  fixture.models.clear();
  fixture.foreign = [];
  vi.mocked(readFile).mockImplementation(async (path) => file(path));
  vi.mocked(statFile).mockResolvedValue(null);
  vi.mocked(saveFile).mockResolvedValue(stamp(5));
  vi.mocked(gitQuery).mockResolvedValue(head(COMMIT_A, true));
  writeText.mockResolvedValue(undefined);
});

describe("the Task tab and its draft", () => {
  it("opens once per place from the Overview action, only in a work place, and the draft survives a place switch and a close", async () => {
    const actions = render();
    actions.openTask();
    expect(Object.keys(actions.snapshot().scopes)).toEqual(["home"]);
    await enterDefiance(actions);
    actions.openTask();
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), taskId]);
    expect(active(actions, workKey("defiance"))).toBe(taskId);
    actions.showTab(editorId("defiance/first.txt"));
    actions.openTask();
    expect(tabIds(actions, workKey("defiance"))).toHaveLength(2);
    expect(active(actions, workKey("defiance"))).toBe(taskId);

    draft(actions, "Add a rule", ["defiance/first.txt"]);
    actions.setTaskDraft((d) => ({ ...d, constraints: "No data changes" }));
    await actions.enterPlace("cockpit");
    expect(active(actions, workKey("cockpit"))).toBe(editorId("cockpit/notes.txt"));
    expect(scope(actions, workKey("cockpit")).task.text).toBe("");
    await actions.enterPlace("defiance");
    expect(scope(actions, workKey("defiance")).task).toMatchObject({ text: "Add a rule", constraints: "No data changes" });
    expect([...scope(actions, workKey("defiance")).task.selected]).toEqual(["defiance/first.txt"]);
    // Closing the tab keeps the draft in the scope; reopening shows it again.
    await actions.requestClose(taskId);
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt")]);
    expect(scope(actions, workKey("defiance")).task.text).toBe("Add a rule");
    actions.openTask();
    expect(active(actions, workKey("defiance"))).toBe(taskId);
    // A knowledge place has no Task action.
    actions.enterRole("wiki");
    actions.openTask();
    expect(Object.keys(actions.snapshot().scopes)).not.toContain("work:wiki");
    expect(actions.snapshot().scopes["know:wiki"].tabs.tabs).toEqual([]);
  });

  it("context candidates are the open file-backed tabs of the work place and the knowledge places only", async () => {
    const actions = render();
    await actions.enterPlace("cockpit");
    actions.enterRole("wiki");
    await actions.openPath("wiki/git.md");
    await actions.openPath("wiki/tauri.md", null, "editor");
    await enterDefiance(actions);
    await actions.openPath("defiance/README.md");
    await actions.openPath("views/defiance/map.svg", null, "view");
    actions.openTask();
    actions.openChanges();
    await actions.openPath("defiance/src/a.py");
    const candidates = contextCandidates(actions.snapshot().scopes, workKey("defiance"));
    expect(candidates.map((c) => c.relPath)).toEqual(["defiance/first.txt", "defiance/README.md", "defiance/src/a.py", "wiki/git.md", "wiki/tauri.md"]);
    expect(candidates.every((c) => !c.dirty)).toBe(true);
  });
});

describe("Copy task packet", () => {
  it("an empty task copies nothing; a ticked file with unsaved edits blocks; saving it or unticking it re-enables; the packet text is exact", async () => {
    const actions = render();
    await enterDefiance(actions);
    await actions.openPath("defiance/src/a.py");
    actions.openTask();
    draft(actions, "   ", ["defiance/first.txt"]);
    await actions.copyTaskPacket();
    expect(writeText).not.toHaveBeenCalled();
    expect(gitQuery).not.toHaveBeenCalled();

    // A keystroke in the shown editor: the model moves on and the tab is marked unsaved.
    const first = fixture.models.get("/root/defiance/first.txt")!;
    actions.showTab(editorId("defiance/first.txt"));
    first.setValue("edited");
    actions.modelChanged();
    await Promise.resolve();
    expect(scope(actions, workKey("defiance")).tabs.tabs[0]).toMatchObject({ kind: "loaded", dirty: true });
    draft(actions, "Add a validation rule.\nKeep the CLI unchanged.", ["defiance/first.txt", "defiance/src/a.py"]);
    expect(contextCandidates(actions.snapshot().scopes, workKey("defiance")).find((c) => c.relPath === "defiance/first.txt")?.dirty).toBe(true);
    await actions.copyTaskPacket();
    expect(writeText).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(first.content).toBe("edited");

    // Unticking the dirty file re-enables Copy.
    draft(actions, "Add a validation rule.\nKeep the CLI unchanged.", ["defiance/src/a.py"]);
    await actions.copyTaskPacket();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenLastCalledWith(
      ["Work folder: defiance", "Root: /root", "", "Task:", "Add a validation rule.\nKeep the CLI unchanged.", "", "Context:", "defiance/src/a.py", "", "Constraints:", "none", ""].join("\n"),
    );
    expect(logged().some((l) => l.includes("Task packet copied · 1 context file"))).toBe(true);
    // The dirty buffer was never touched by the copy.
    expect(first.content).toBe("edited");
    expect(saveFile).not.toHaveBeenCalled();

    // Ticking it again blocks; saving it (the user's own Cmd+S) re-enables.
    draft(actions, "Add a validation rule.", ["defiance/first.txt"]);
    await actions.copyTaskPacket();
    expect(writeText).toHaveBeenCalledTimes(1);
    actions.saveActive();
    await tick();
    await tick();
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(scope(actions, workKey("defiance")).tabs.tabs[0]).toMatchObject({ kind: "loaded", dirty: false });
    await actions.copyTaskPacket();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("Context:\ndefiance/first.txt\n"));
  });

  it("success records the baseline (commit, time, clean) and the task-started cue; a new packet replaces the baseline; Refresh ends the cue", async () => {
    const actions = render();
    await enterDefiance(actions);
    actions.openTask();
    draft(actions, "one");
    const before = Date.now();
    await actions.copyTaskPacket();
    expect(gitQuery).toHaveBeenCalledWith("defiance", { kind: "head" });
    const baseline = actions.snapshot().baselines.defiance;
    expect(baseline.commit).toBe(COMMIT_A);
    expect(baseline.clean).toBe(true);
    expect(baseline.at).toBeGreaterThanOrEqual(before);
    expect(scope(actions, workKey("defiance")).taskStartedAt).toBe(baseline.at);
    expect(Object.keys(baseline)).toEqual(["commit", "at", "clean"]);

    vi.mocked(gitQuery).mockResolvedValue(head(COMMIT_B, false));
    draft(actions, "two");
    await actions.copyTaskPacket();
    expect(actions.snapshot().baselines.defiance).toMatchObject({ commit: COMMIT_B, clean: false });
    expect(Object.keys(actions.snapshot().baselines)).toEqual(["defiance"]);

    actions.openChanges();
    await actions.refresh();
    expect(scope(actions, workKey("defiance")).taskStartedAt).toBeNull();
    expect(scope(actions, workKey("defiance")).surfaceReload).toBe(1);
    expect(actions.snapshot().baselines.defiance.commit).toBe(COMMIT_B);
  });

  it("a clipboard failure shows the packet for manual copy, names the failure, and still records the baseline", async () => {
    const actions = render();
    await enterDefiance(actions);
    actions.openTask();
    draft(actions, "one");
    writeText.mockRejectedValueOnce(new Error("NotAllowedError"));
    await actions.copyTaskPacket();
    expect(scope(actions, workKey("defiance")).task.fallback).toBe(["Work folder: defiance", "Root: /root", "", "Task:", "one", "", "Context:", "none", "", "Constraints:", "none", ""].join("\n"));
    expect(logged().some((l) => l.includes("clipboard copy failed: Error: NotAllowedError"))).toBe(true);
    expect(actions.snapshot().baselines.defiance.commit).toBe(COMMIT_A);
    // The next successful copy clears the shown packet.
    await actions.copyTaskPacket();
    expect(scope(actions, workKey("defiance")).task.fallback).toBeNull();
  });

  it("never persists task text; the baseline is written; a non-Git place records nothing; a repository with no commits records nothing", async () => {
    const actions = render();
    await enterDefiance(actions);
    actions.openTask();
    draft(actions, "SECRET-TASK-TEXT");
    actions.setTaskDraft((d) => ({ ...d, constraints: "SECRET-CONSTRAINT" }));
    await actions.copyTaskPacket();
    await actions.requestQuit();
    expect(quit).toHaveBeenCalled();
    const last = written()[written().length - 1];
    expect(last).not.toContain("SECRET");
    const state = JSON.parse(last) as UiState;
    expect(state.baselines.defiance).toMatchObject({ commit: COMMIT_A, clean: true });
    expect(state.scopes["work:defiance"].tabs).toContain(taskId);

    // cockpit is a plain folder: no Git call, no baseline, no cue.
    vi.clearAllMocks();
    vi.mocked(gitQuery).mockResolvedValue(head(COMMIT_B, true));
    await actions.enterPlace("cockpit");
    actions.openTask();
    draft(actions, "plain");
    await actions.copyTaskPacket();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(gitQuery).not.toHaveBeenCalled();
    expect(actions.snapshot().baselines.cockpit).toBeUndefined();
    expect(scope(actions, workKey("cockpit")).taskStartedAt).toBeNull();

    // A repository with no commits yet has nothing to record; the copy still happened.
    vi.clearAllMocks();
    vi.mocked(gitQuery).mockResolvedValue(head(null, false));
    await actions.enterPlace("defiance");
    draft(actions, "unborn");
    await actions.copyTaskPacket();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(actions.snapshot().baselines.defiance.commit).toBe(COMMIT_A);
    expect(logged().some((l) => l.includes("task baseline for defiance not recorded"))).toBe(true);
  });
});

describe("Open in Terminal", () => {
  it("asks Rust for the place, only in a work place, and names a failure in the notice and the log", async () => {
    const actions = render();
    await actions.openTerminal();
    expect(openTerminal).not.toHaveBeenCalled();
    await enterDefiance(actions);
    await actions.openTerminal();
    expect(openTerminal).toHaveBeenCalledWith("defiance");
    expect(logged().some((l) => l.includes("Terminal"))).toBe(false);
    vi.mocked(openTerminal).mockRejectedValueOnce("cannot start open: No such file or directory");
    await actions.openTerminal();
    expect(logged().some((l) => l.includes("open Terminal for defiance failed: cannot start open"))).toBe(true);
    actions.enterRole("wiki");
    await actions.openTerminal();
    expect(openTerminal).toHaveBeenCalledTimes(2);
  });
});

describe("the Changes tab", () => {
  it("opens once per place, closes with Close Tab without a prompt while a buffer is dirty, and Refresh reaches it", async () => {
    const actions = render();
    await enterDefiance(actions);
    const first = fixture.models.get("/root/defiance/first.txt")!;
    first.setValue("dirty");
    actions.openChanges();
    actions.openChanges();
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), changesId]);
    expect(active(actions, workKey("defiance"))).toBe(changesId);
    await actions.enterPlace("cockpit");
    await actions.refresh();
    expect(scope(actions, workKey("defiance")).surfaceReload).toBe(1);
    expect(scope(actions, workKey("cockpit")).surfaceReload).toBe(0);
    await actions.enterPlace("defiance");
    await actions.closeActiveTab();
    await tick();
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt")]);
    expect(fixture.prompts).toEqual([]);
    expect(first.dispose).not.toHaveBeenCalled();
    expect(first.content).toBe("dirty");
  });

  it("remembered task: and changes: ids restore for the place's own folder only, with no read, and are written back", async () => {
    const actions = render(rememberedUi(true));
    await enterDefiance(actions);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), taskId, changesId]);
    expect(active(actions, workKey("defiance"))).toBe(changesId);
    expect(scope(actions, workKey("defiance")).task.text).toBe("");
    expect(logged().some((l) => l.includes("defiance restored: 3 tabs"))).toBe(true);
    await actions.requestQuit();
    const state = JSON.parse(written()[written().length - 1]) as UiState;
    expect(state.scopes["work:defiance"].tabs).toEqual(["editor:defiance/first.txt", taskId, changesId]);
    expect(state.scopes["work:defiance"].active).toBe(changesId);
  });

  it("a changed file opens through openPath: inside the place it opens, outside it is refused with the notice and a log line", async () => {
    const actions = render();
    await enterDefiance(actions);
    actions.openChanges();
    await actions.openPath("defiance/src/ingest.py");
    expect(active(actions, workKey("defiance"))).toBe(editorId("defiance/src/ingest.py"));
    expect(fixture.models.has("/root/defiance/src/ingest.py")).toBe(true);
    await actions.openPath("defiance/README.md");
    expect(active(actions, workKey("defiance"))).toBe(markdownId("defiance/README.md"));
    await actions.openPath("cockpit/notes.txt");
    expect(tabIds(actions, workKey("defiance"))).not.toContain(editorId("cockpit/notes.txt"));
    expect(logged().filter((l) => l.includes("outside the subject: cockpit/notes.txt"))).toHaveLength(1);
    expect(tabIds(actions, workKey("defiance"))).toContain(changesId);
  });

  it("throwaway comparison models never join buffer ownership: a rename may land on their path and they are never counted", async () => {
    const actions = render();
    await enterDefiance(actions);
    fixture.foreign.push({ uri: { scheme: "alabs-git", path: "/root/defiance/renamed.txt" } }, { uri: { scheme: "alabs-git", path: "/7/left/first.txt" } });
    const entry: Entry = { name: "first.txt", rel_path: "defiance/first.txt", is_dir: false };
    expect(await actions.renameEntry(entry, "renamed.txt")).toBeNull();
    expect(moveItem).toHaveBeenCalledWith("defiance/first.txt", "defiance", "renamed.txt", "defiance");
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/renamed.txt")]);
    // A real buffer at the destination still refuses.
    await actions.openPath("defiance/other.txt");
    const back: Entry = { name: "renamed.txt", rel_path: "defiance/renamed.txt", is_dir: false };
    expect(await actions.renameEntry(back, "other.txt")).toBe("defiance/other.txt is open in a tab. Close it first.");
  });
});
