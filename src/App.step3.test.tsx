import type { ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { type AppActions, type AppInitial } from "./App";
import { FileTree } from "./FileTree";
import { Rail } from "./Rail";
import { HomeBody } from "./Home";
import { Overview } from "./Overview";
import { appendLog, askLocalModel, createDir, listDir, listLocalModels, moveItem, quit, readFile, recreateFile, saveFile, saveUiState, statFile } from "./subject";
import type { Entry, FileContent, FileStamp } from "./subject";
import { classifyRoot, knowKey, workKey } from "./places";
import { editorId } from "./tabs";
import { placeStatus } from "./scopeState";
import { MAX_LIVE_MODELS } from "./openPath";
import { EMPTY_STATE, setRoot, setScopeLayout, type UiState } from "./uiState";

// Step 3 regressions (BUILD_PLAN items 11 to 22), driven the same way as
// App.regression.test.tsx: one server render with seeded state, then the
// actions the shell hands out. Native services and Monaco are mocked; undo
// history and the cursor are the manual check in the running app.
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
  prompts: [] as Array<{ name: string; resolve: (choice: Choice) => void }>,
}));

vi.mock("./FileTree", () => ({ FileTree: (_props: ComponentProps<typeof FileTree>) => null }));
vi.mock("./Overview", () => ({ Overview: (_props: ComponentProps<typeof Overview>) => null }));
vi.mock("./Rail", () => ({ Rail: (_props: ComponentProps<typeof Rail>) => null }));
vi.mock("./Home", () => ({ HomeBody: (_props: ComponentProps<typeof HomeBody>) => null, HomeSidebar: () => null }));
vi.mock("@monaco-editor/react", () => ({ default: () => null }));
vi.mock("monaco-editor", () => ({
  Uri: { file: (path: string) => path },
  KeyCode: {},
  KeyMod: {},
  editor: {
    getModel: (uri: string) => fixture.models.get(uri),
    getModels: () => [...fixture.models.keys()].map((path) => ({ uri: { scheme: "file", path } })),
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
  loadUiState: vi.fn(),
  moveItem: vi.fn(),
  quit: vi.fn(),
  recreateFile: vi.fn(),
  saveFile: vi.fn(),
  saveUiState: vi.fn(async () => {}),
  appendLog: vi.fn(async () => {}),
  trashItem: vi.fn(),
  askLocalModel: vi.fn(async () => ({ kind: "unavailable" })),
  listLocalModels: vi.fn(async () => ({ kind: "unavailable" })),
}));

const root = { path: "/root", name: "root" };
const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });
const fileEntry = (relPath: string): Entry => ({ name: relPath.split("/").pop() ?? relPath, rel_path: relPath, is_dir: false });
const stamp = (identity = "1:2", mtime = 0): FileStamp => ({ identity, mtime_secs: mtime, mtime_nanos: 0, len: 9 });
const file = (relPath: string): FileContent => ({ name: relPath.split("/").pop() ?? relPath, content: "from disk", stamp: stamp() });

/** What `list_dir("")` returns: the root's children, changed by tests to simulate Finder work between Refreshes. */
let rootEntries: Entry[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Root layout remembering two defiance tabs and one cockpit tab. */
function rememberedUi(): UiState {
  let ui = setRoot(EMPTY_STATE, root.path);
  ui = setScopeLayout(ui, "work:defiance", {
    expanded: [],
    tabs: ["editor:defiance/first.txt", "editor:defiance/later.txt"],
    active: "editor:defiance/first.txt",
    views: {},
    visited: 2,
  });
  ui = setScopeLayout(ui, "work:cockpit", { expanded: [], tabs: ["editor:cockpit/notes.md"], active: null, views: {}, visited: 1 });
  return ui;
}

function render(entries: Entry[] = [dir("defiance"), dir("cockpit"), dir("views"), dir("wiki")], ui: UiState = rememberedUi()): AppActions {
  rootEntries = entries;
  let actions!: AppActions;
  fixture.prompts = [];
  const initial: AppInitial = {
    ui,
    root,
    home: { listing: classifyRoot(entries), views: new Set(), git: new Map(), rootView: { exists: false, saved: null } },
    actions: (a) => {
      actions = a;
    },
    onUnsavedPrompt: (name, resolve) => fixture.prompts.push({ name, resolve }),
  };
  renderToString(<App initial={initial} />);
  return actions;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const logged = () => vi.mocked(appendLog).mock.calls.map((c) => String(c[0]));
const key = (k: string, mods: Partial<{ meta: boolean; shift: boolean }> = {}) => ({
  key: k,
  metaKey: mods.meta ?? false,
  ctrlKey: false,
  shiftKey: mods.shift ?? false,
  altKey: false,
  preventDefault: vi.fn(),
});

async function enterDefianceWithDirtyFirst(actions: AppActions) {
  actions.enterPlace("defiance");
  await vi.waitFor(() => expect(fixture.models.has("/root/defiance/later.txt")).toBe(true));
  const first = fixture.models.get("/root/defiance/first.txt")!;
  first.content = "edited";
  first.version = 7;
  return first;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.models.clear();
  vi.mocked(readFile).mockImplementation(async (path) => file(path));
  vi.mocked(statFile).mockResolvedValue(null);
  vi.mocked(listDir).mockImplementation(async (rel) => (rel === "" ? rootEntries : []));
  vi.mocked(moveItem).mockImplementation(async (_from, toParent, name) => `${toParent}/${name}`);
});

describe("the Step 3 acceptance flow", () => {
  it("edit Defiance, visit Wiki, visit Home, return: the buffer, tab, cursor owner and active work are intact and nothing asked", async () => {
    const actions = render();
    const first = await enterDefianceWithDirtyFirst(actions);
    expect(actions.snapshot().activeWork).toBe("defiance");

    actions.enterRole("wiki");
    await tick();
    let snap = actions.snapshot();
    expect(snap.activeKey).toBe(knowKey("wiki"));
    expect(snap.activeWork).toBe("defiance");
    expect(snap.scopes[knowKey("wiki")].prefix).toBe("wiki");
    expect(snap.scopes[knowKey("wiki")].kind).toBe("know");
    await actions.openPath("wiki/notes.md", null, "editor");
    expect(fixture.models.has("/root/wiki/notes.md")).toBe(true);
    expect(snap.scopes[workKey("defiance")].tabs.active).toBe("editor:defiance/first.txt");

    actions.goHome();
    expect(actions.snapshot().activeKey).toBe("home");
    expect(actions.snapshot().activeWork).toBe("defiance");

    actions.enterPlace("defiance");
    await tick();
    snap = actions.snapshot();
    expect(snap.activeKey).toBe(workKey("defiance"));
    const scope = snap.scopes[workKey("defiance")];
    expect(scope.tabs.tabs.map((t) => t.relPath)).toEqual(["defiance/first.txt", "defiance/later.txt"]);
    expect(scope.tabs.active).toBe("editor:defiance/first.txt");
    expect(fixture.models.get("/root/defiance/first.txt")).toBe(first);
    expect(first.content).toBe("edited");
    expect(first.dispose).not.toHaveBeenCalled();
    // Returning re-reads nothing: two restore reads plus the wiki file.
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(saveFile).not.toHaveBeenCalled();
    expect(fixture.prompts).toEqual([]);
    // The wiki scope is still live too, with its own tab.
    expect(snap.scopes[knowKey("wiki")].tabs.tabs.map((t) => t.relPath)).toEqual(["wiki/notes.md"]);
    // The local model is optional: the whole flow, Wiki included, never called or listed it.
    expect(askLocalModel).not.toHaveBeenCalled();
    expect(listLocalModels).not.toHaveBeenCalled();
  });

  it("a chosen local model is remembered as its name only in the disposable state, survives a restart, and its clearing is remembered too", async () => {
    const actions = render();
    expect(actions.snapshot().localModel).toBeNull();
    actions.selectLocalModel("small:1b");
    await tick();
    expect(actions.snapshot().localModel).toBe("small:1b");
    const written = vi.mocked(saveUiState).mock.calls.map((c) => String(c[0]));
    expect(written.length).toBeGreaterThan(0);
    expect(JSON.parse(written[written.length - 1]).localModel).toBe("small:1b");
    // Restart: the written state is what the next launch loads.
    const { parseState } = await import("./uiState");
    const restarted = render(undefined, parseState(written[written.length - 1]).state);
    expect(restarted.snapshot().localModel).toBe("small:1b");
    // Choosing and clearing never touches a file in the root, never calls the model, and does not change navigation.
    restarted.selectLocalModel(null);
    await tick();
    expect(restarted.snapshot().localModel).toBeNull();
    expect(saveFile).not.toHaveBeenCalled();
    expect(askLocalModel).not.toHaveBeenCalled();
    expect(listLocalModels).not.toHaveBeenCalled();
    expect(restarted.snapshot().activeKey).toBe("home");
  });

  it("a knowledge place owns only its own folder; a fresh conflicted role is inert; a not-created role opens nothing", async () => {
    const actions = render([dir("defiance"), dir("Wiki"), dir("wiki"), dir("context")]);
    actions.enterRole("wiki");
    await tick();
    expect(actions.snapshot().scopes[knowKey("wiki")]).toBeUndefined();
    expect(actions.snapshot().activeKey).toBe("home");
    actions.enterRole("definitions");
    expect(actions.snapshot().scopes[knowKey("definitions")]).toBeUndefined();

    actions.enterRole("context");
    await tick();
    expect(actions.snapshot().activeKey).toBe(knowKey("context"));
    await actions.openPath("defiance/first.txt");
    await actions.openPath("views/defiance/index.html");
    expect(readFile).not.toHaveBeenCalled();
    expect(logged().some((l) => l.includes("outside the subject: defiance/first.txt"))).toBe(true);
    await actions.openPath("context/me.md", null, "editor");
    expect(fixture.models.has("/root/context/me.md")).toBe(true);
  });

  it("a role conflict that appears after the scope is live keeps it enterable and bound to its folder", async () => {
    const actions = render();
    actions.enterRole("wiki");
    await tick();
    await actions.openPath("wiki/notes.md", null, "editor");
    const notes = fixture.models.get("/root/wiki/notes.md")!;
    notes.content = "unsaved";
    notes.version = 3;

    rootEntries = [dir("defiance"), dir("cockpit"), dir("wiki"), dir("Wiki")];
    await actions.refresh();
    let snap = actions.snapshot();
    expect(snap.listing?.roles.wiki.kind).toBe("conflict");
    expect(placeStatus(snap.scopes[knowKey("wiki")], snap.listing)).toBe("conflict");

    actions.goHome();
    actions.enterRole("wiki");
    await tick();
    snap = actions.snapshot();
    expect(snap.activeKey).toBe(knowKey("wiki"));
    expect(snap.scopes[knowKey("wiki")].prefix).toBe("wiki");
    expect(fixture.models.get("/root/wiki/notes.md")).toBe(notes);
    expect(notes.content).toBe("unsaved");
    await actions.openPath("wiki/more.md", null, "editor");
    expect(fixture.models.has("/root/wiki/more.md")).toBe(true);
    expect(fixture.prompts).toEqual([]);
  });
});

describe("Step 7 fixes", () => {
  it("a not-created knowledge row creates the default folder and then enters it (DESIGN.md 6.1)", async () => {
    const actions = render([dir("defiance"), dir("cockpit"), dir("views")]);
    expect(actions.snapshot().listing?.roles.wiki.kind).toBe("missing");
    vi.mocked(createDir).mockImplementation(async (parent, name) => {
      rootEntries = [...rootEntries, dir(name)];
      return `${parent}${name}`;
    });
    await actions.createRole("wiki");
    expect(createDir).toHaveBeenCalledWith("", "wiki");
    const snap = actions.snapshot();
    expect(snap.listing?.roles.wiki).toEqual({ kind: "present", name: "wiki" });
    expect(snap.activeKey).toBe(knowKey("wiki"));
    expect(snap.scopes[knowKey("wiki")].prefix).toBe("wiki");
    // Visiting knowledge never changes the active work place.
    expect(snap.activeWork).toBe(null);
  });

  it("a failed create enters nothing and names the failure; a present role is never created over", async () => {
    const actions = render([dir("defiance"), dir("cockpit"), dir("definitions")]);
    vi.mocked(createDir).mockRejectedValue("cannot create wiki: disk full");
    await actions.createRole("wiki");
    const snap = actions.snapshot();
    expect(snap.activeKey).toBe("home");
    expect(snap.scopes[knowKey("wiki")]).toBeUndefined();
    expect(logged().some((l) => l.includes("cannot create wiki: disk full"))).toBe(true);
    vi.mocked(createDir).mockClear();
    await actions.createRole("definitions");
    expect(createDir).not.toHaveBeenCalled();
    expect(actions.snapshot().activeKey).toBe("home");
  });

  it("an undo back to the saved version clears the unsaved mark although Monaco reports the version late", async () => {
    const actions = render();
    actions.enterPlace("defiance");
    await vi.waitFor(() => expect(fixture.models.has("/root/defiance/first.txt")).toBe(true));
    actions.showTab(editorId("defiance/first.txt"));
    const first = fixture.models.get("/root/defiance/first.txt")!;
    const tab = () => actions.snapshot().scopes[workKey("defiance")].tabs.tabs.find((t) => t.relPath === "defiance/first.txt")!;
    expect(tab()).toMatchObject({ kind: "loaded", dirty: false, savedVersion: 1 });

    // A keystroke: the model moves on and the tab is marked unsaved once the event settles.
    first.version = 2;
    actions.modelChanged();
    expect(tab()).toMatchObject({ dirty: false });
    await Promise.resolve();
    expect(tab()).toMatchObject({ dirty: true });

    // Undo, as Monaco raises it: the event arrives while the alternative version id is still
    // the incremented one; only afterwards is it overwritten with the saved version.
    first.version = 3;
    actions.modelChanged();
    first.version = 1;
    await Promise.resolve();
    expect(tab()).toMatchObject({ dirty: false });

    // Redo the same way: unsaved again.
    first.version = 4;
    actions.modelChanged();
    first.version = 2;
    await Promise.resolve();
    expect(tab()).toMatchObject({ dirty: true });
  });
});

describe("scope ownership", () => {
  it("an open still in flight lands in the scope that started it, never in the place shown when it completes", async () => {
    const actions = render();
    await enterDefianceWithDirtyFirst(actions);
    const slow = deferred<FileContent>();
    vi.mocked(readFile).mockImplementation(async (path) => (path === "defiance/slow.txt" ? slow.promise : file(path)));
    const open = actions.openPath("defiance/slow.txt");
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(fixture.models.has("/root/cockpit/notes.md")).toBe(true));
    slow.resolve(file("defiance/slow.txt"));
    await open;
    const snap = actions.snapshot();
    expect(snap.activeKey).toBe(workKey("cockpit"));
    expect(snap.scopes[workKey("defiance")].tabs.tabs.map((t) => t.relPath)).toContain("defiance/slow.txt");
    expect(snap.scopes[workKey("cockpit")].tabs.tabs.map((t) => t.relPath)).toEqual(["cockpit/notes.md"]);
    expect(fixture.models.has("/root/defiance/slow.txt")).toBe(true);
  });

  it("closing one scope's tab leaves every other scope untouched, and a path another scope holds is not closable from here", async () => {
    const actions = render();
    const first = await enterDefianceWithDirtyFirst(actions);
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(fixture.models.has("/root/cockpit/notes.md")).toBe(true));
    const notes = fixture.models.get("/root/cockpit/notes.md")!;
    await actions.requestClose("editor:cockpit/notes.md");
    expect(notes.dispose).toHaveBeenCalledTimes(1);
    let snap = actions.snapshot();
    expect(snap.scopes[workKey("cockpit")].tabs.tabs).toEqual([]);
    expect(snap.scopes[workKey("defiance")].tabs.tabs).toHaveLength(2);
    expect(first.dispose).not.toHaveBeenCalled();
    // Defiance is not showing: its tab cannot be closed from cockpit.
    await actions.requestClose("editor:defiance/first.txt");
    snap = actions.snapshot();
    expect(snap.scopes[workKey("defiance")].tabs.tabs).toHaveLength(2);
    expect(first.dispose).not.toHaveBeenCalled();
    expect(fixture.prompts).toEqual([]);
  });
});

describe("missing places (item 16)", () => {
  it("stays reachable with its buffers, fails Save by name, reconnects at the same path, and another name is a new place", async () => {
    const actions = render();
    const first = await enterDefianceWithDirtyFirst(actions);

    // Finder moved defiance away; Refresh notices.
    rootEntries = [dir("cockpit"), dir("wiki")];
    await actions.refresh();
    let snap = actions.snapshot();
    expect(placeStatus(snap.scopes[workKey("defiance")], snap.listing)).toBe("missing");
    expect(snap.scopes[workKey("defiance")].tabs.tabs).toHaveLength(2);
    expect(first.content).toBe("edited");
    expect(first.dispose).not.toHaveBeenCalled();
    expect(logged().some((l) => l.includes("Refresh: 2 missing, across 1 place"))).toBe(true);

    // Still enterable from Home; a place that never existed is not.
    actions.goHome();
    actions.enterPlace("defiance");
    expect(actions.snapshot().activeKey).toBe(workKey("defiance"));
    actions.enterPlace("nowhere");
    expect(actions.snapshot().scopes[workKey("nowhere")]).toBeUndefined();

    // Save fails with the named error, keeps the buffer, offers no recreate.
    vi.mocked(saveFile).mockRejectedValue("cannot access defiance/first.txt: No such file or directory (os error 2)");
    actions.saveActive();
    await vi.waitFor(() => expect(logged().some((l) => l.includes("defiance is missing from the root"))).toBe(true));
    expect(recreateFile).not.toHaveBeenCalled();
    expect(first.content).toBe("edited");
    expect(first.dispose).not.toHaveBeenCalled();
    snap = actions.snapshot();
    const tab = snap.scopes[workKey("defiance")].tabs.tabs[0];
    expect(tab.kind === "loaded" && tab.disk).toBe("missing");

    // A folder under a different name is a new place; the old scope stays missing.
    rootEntries = [dir("cockpit"), dir("wiki"), dir("defiance2")];
    await actions.refresh();
    actions.enterPlace("defiance2");
    await tick();
    snap = actions.snapshot();
    expect(snap.activeKey).toBe(workKey("defiance2"));
    expect(snap.scopes[workKey("defiance2")].tabs.tabs).toEqual([]);
    expect(placeStatus(snap.scopes[workKey("defiance")], snap.listing)).toBe("missing");

    // The folder back at the same path plus Refresh reconnects the same scope.
    rootEntries = [dir("cockpit"), dir("wiki"), dir("defiance"), dir("defiance2")];
    await actions.refresh();
    snap = actions.snapshot();
    expect(placeStatus(snap.scopes[workKey("defiance")], snap.listing)).toBe("present");
    expect(fixture.models.get("/root/defiance/first.txt")).toBe(first);
    expect(snap.scopes[workKey("defiance")].tabs.tabs.map((t) => t.relPath)).toEqual(["defiance/first.txt", "defiance/later.txt"]);
  });
});

describe("rename and move stay within the place (item 17)", () => {
  it("a within-place rename or move follows the tab and its dirty buffer; leaving the place is refused before Rust is asked", async () => {
    const actions = render();
    const first = await enterDefianceWithDirtyFirst(actions);
    expect(await actions.renameEntry(fileEntry("defiance/first.txt"), "renamed.txt")).toBeNull();
    expect(moveItem).toHaveBeenCalledWith("defiance/first.txt", "defiance", "renamed.txt", "defiance");
    let snap = actions.snapshot();
    expect(snap.scopes[workKey("defiance")].tabs.tabs.map((t) => t.relPath)).toEqual(["defiance/renamed.txt", "defiance/later.txt"]);
    expect(snap.scopes[workKey("defiance")].tabs.active).toBe("editor:defiance/renamed.txt");
    expect(fixture.models.get("/root/defiance/renamed.txt")?.content).toBe("edited");
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(fixture.models.has("/root/defiance/first.txt")).toBe(false);

    expect(await actions.moveEntry(fileEntry("defiance/renamed.txt"), "sub")).toBeNull();
    expect(moveItem).toHaveBeenLastCalledWith("defiance/renamed.txt", "defiance/sub", "renamed.txt", "defiance");
    snap = actions.snapshot();
    expect(snap.scopes[workKey("defiance")].tabs.active).toBe("editor:defiance/sub/renamed.txt");

    vi.mocked(moveItem).mockClear();
    const refused = "Destination is outside defiance. Use Finder, then Refresh.";
    expect(await actions.moveEntry(fileEntry("defiance/sub/renamed.txt"), "../cockpit")).toBe(refused);
    expect(await actions.moveEntry(fileEntry("defiance/sub/renamed.txt"), "/cockpit/../../x")).toBe(refused);
    expect(await actions.renameEntry(fileEntry("cockpit/notes.md"), "n.md")).toBe(refused);
    expect(moveItem).not.toHaveBeenCalled();
    expect(fixture.models.has("/root/defiance/sub/renamed.txt")).toBe(true);

    // Rust's own refusal reaches the modal in the same words.
    vi.mocked(moveItem).mockRejectedValueOnce("path is outside the scope defiance: defiance/link");
    expect(await actions.moveEntry(fileEntry("defiance/sub/renamed.txt"), "link")).toBe(refused);
    expect(logged().some((l) => l.includes("outside the scope defiance"))).toBe(true);
  });

  it("applies the same rule inside a knowledge place", async () => {
    const actions = render();
    actions.enterRole("wiki");
    await tick();
    expect(await actions.moveEntry(fileEntry("wiki/a.md"), "../defiance")).toBe("Destination is outside Wiki. Use Finder, then Refresh.");
    expect(moveItem).not.toHaveBeenCalled();
    expect(await actions.renameEntry(fileEntry("wiki/a.md"), "b.md")).toBeNull();
    expect(moveItem).toHaveBeenCalledWith("wiki/a.md", "wiki", "b.md", "wiki");
  });
});

describe("the live-model cap (item 18)", () => {
  it("refuses the next open at the cap without evicting anything, and a restore stops at the cap and says so", async () => {
    const actions = render();
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(fixture.models.has("/root/cockpit/notes.md")).toBe(true));
    for (let i = 1; i < MAX_LIVE_MODELS - 1; i += 1) await actions.openPath(`cockpit/f${i}.txt`);
    expect(fixture.models.size).toBe(MAX_LIVE_MODELS - 1);

    // 199 live, two remembered: one restores, one is refused and named.
    actions.enterPlace("defiance");
    await vi.waitFor(() => expect(logged().some((l) => l.includes("defiance restored: 1 tab, 1 not opened: too many open files across places"))).toBe(true));
    expect(fixture.models.size).toBe(MAX_LIVE_MODELS);
    expect(fixture.models.has("/root/defiance/first.txt")).toBe(true);
    expect(fixture.models.has("/root/defiance/later.txt")).toBe(false);

    const before = vi.mocked(readFile).mock.calls.length;
    await actions.openPath("defiance/one-more.txt");
    expect(readFile).toHaveBeenCalledTimes(before);
    expect(fixture.models.size).toBe(MAX_LIVE_MODELS);
    expect(logged().some((l) => l.includes("live model cap reached"))).toBe(true);
    for (const model of fixture.models.values()) expect(model.dispose).not.toHaveBeenCalled();
    // An already open file still shows.
    await actions.openPath("defiance/first.txt");
    expect(actions.snapshot().scopes[workKey("defiance")].tabs.active).toBe("editor:defiance/first.txt");
  });
});

describe("Refresh across scopes (item 15)", () => {
  it("stats every loaded tab in every scope: dirty and changed is a conflict, clean and changed reloads, gone is missing", async () => {
    const actions = render();
    const first = await enterDefianceWithDirtyFirst(actions);
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(fixture.models.has("/root/cockpit/notes.md")).toBe(true));
    const notes = fixture.models.get("/root/cockpit/notes.md")!;
    vi.mocked(statFile).mockImplementation(async (path) => (path === "defiance/later.txt" ? null : stamp("1:2", 9)));
    vi.mocked(readFile).mockImplementation(async (path) => ({ ...file(path), content: "newer", stamp: stamp("1:2", 9) }));
    vi.mocked(listDir).mockClear();
    vi.mocked(readFile).mockClear();
    await actions.refresh();
    expect(listDir).toHaveBeenCalledWith("");
    expect(statFile).toHaveBeenCalledTimes(3);
    // The two changed files are read; the dirty one is then kept as a conflict, never overwritten.
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledWith("cockpit/notes.md");
    expect(readFile).not.toHaveBeenCalledWith("defiance/later.txt");
    expect(notes.content).toBe("newer");
    expect(first.content).toBe("edited");
    const snap = actions.snapshot();
    const [f, l] = snap.scopes[workKey("defiance")].tabs.tabs;
    expect(f.kind === "loaded" && f.disk).toBe("conflict");
    expect(l.kind === "loaded" && l.disk).toBe("missing");
    const n = snap.scopes[workKey("cockpit")].tabs.tabs[0];
    expect(n.kind === "loaded" && n.disk === "ok" && !n.dirty).toBe(true);
    expect(logged().some((l) => l.includes("Refresh: 2 files changed on disk, 1 missing, across 2 places"))).toBe(true);
  });
});

describe("keyboard (DESIGN.md section 8)", () => {
  it("Cmd+W belongs to the host and closes nothing itself; File > Close Tab closes the active tab and nothing on the Overview or Home; Cmd+Shift+] steps through the strip; Cmd+0 goes Home; Cmd+R refreshes", async () => {
    const actions = render();
    await enterDefianceWithDirtyFirst(actions);
    actions.handleKey(key("]", { meta: true, shift: true }));
    expect(actions.snapshot().scopes[workKey("defiance")].tabs.active).toBe("editor:defiance/later.txt");
    actions.handleKey(key("]", { meta: true, shift: true }));
    expect(actions.snapshot().scopes[workKey("defiance")].tabs.active).toBeNull();
    actions.handleKey(key("[", { meta: true, shift: true }));
    expect(actions.snapshot().scopes[workKey("defiance")].tabs.active).toBe("editor:defiance/later.txt");

    // The raw Cmd+W closes nothing: with a native menu it is only swallowed,
    // and in Chrome it is Chrome's own key. What closes a tab is the menu's
    // event, which is the same call as the tab strip's close control.
    const later = fixture.models.get("/root/defiance/later.txt")!;
    const swallowed = key("w", { meta: true });
    actions.handleKey(swallowed);
    await tick();
    expect(swallowed.preventDefault).toHaveBeenCalled();
    expect(later.dispose).not.toHaveBeenCalled();
    expect(actions.snapshot().scopes[workKey("defiance")].tabs.active).toBe("editor:defiance/later.txt");

    // Close Tab on a clean tab closes it; on the Overview it does nothing.
    await actions.closeActiveTab();
    await vi.waitFor(() => expect(later.dispose).toHaveBeenCalledTimes(1));
    expect(actions.snapshot().scopes[workKey("defiance")].tabs.active).toBe("editor:defiance/first.txt");
    actions.showOverview();
    await actions.closeActiveTab();
    await tick();
    expect(actions.snapshot().scopes[workKey("defiance")].tabs.tabs).toHaveLength(1);
    expect(fixture.prompts).toEqual([]);

    // Cmd+Shift+F opens Search in the place; Escape closes it.
    actions.handleKey(key("f", { meta: true, shift: true }));
    expect(actions.snapshot().scopes[workKey("defiance")].searching).toBe(true);
    actions.handleKey(key("Escape"));
    expect(actions.snapshot().scopes[workKey("defiance")].searching).toBe(false);

    const e = key("0", { meta: true });
    actions.handleKey(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(actions.snapshot().activeKey).toBe("home");
    await actions.closeActiveTab();
    await tick();
    expect(actions.snapshot().scopes[workKey("defiance")].tabs.tabs).toHaveLength(1);

    vi.mocked(listDir).mockClear();
    actions.handleKey(key("r", { meta: true }));
    await vi.waitFor(() => expect(listDir).toHaveBeenCalledWith(""));
  });
});

describe("buffer safety across delayed operations", () => {
  it("typing while Refresh reads an external edit keeps the new buffer and reports a conflict", async () => {
    const actions = render();
    await actions.enterPlace("defiance");
    const first = fixture.models.get("/root/defiance/first.txt")!;
    const reading = deferred<FileContent>();
    vi.mocked(statFile).mockImplementation(async (path) => path.endsWith("first.txt") ? stamp("2:3", 5) : stamp());
    vi.mocked(readFile).mockImplementation(() => reading.promise);
    const refreshing = actions.refresh();
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(3));
    first.setValue("typed while disk read waits");
    actions.modelChanged();
    reading.resolve({ ...file("defiance/first.txt"), content: "external replacement", stamp: stamp("2:3", 5) });
    await refreshing;
    expect(first.content).toBe("typed while disk read waits");
    expect(actions.snapshot().scopes[workKey("defiance")].tabs.tabs[0]).toMatchObject({ dirty: true, disk: "conflict" });
    expect(saveFile).not.toHaveBeenCalled();
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it("a failed save retains the dirty buffer through navigation and a later save succeeds", async () => {
    const actions = render();
    const first = await enterDefianceWithDirtyFirst(actions);
    actions.modelChanged();
    vi.mocked(statFile).mockResolvedValue(stamp());
    vi.mocked(saveFile).mockRejectedValueOnce(new Error("disk full"));
    actions.saveActive();
    await vi.waitFor(() => expect(logged().some((line) => line.includes("disk full"))).toBe(true));
    await actions.enterPlace("cockpit");
    actions.goHome();
    await actions.enterPlace("defiance");
    expect(first.content).toBe("edited");
    expect(first.dispose).not.toHaveBeenCalled();
    expect(actions.snapshot().scopes[workKey("defiance")].tabs.tabs[0]).toMatchObject({ dirty: true });
    vi.mocked(saveFile).mockResolvedValue(stamp("2:4", 6));
    actions.saveActive();
    await vi.waitFor(() => expect(actions.snapshot().scopes[workKey("defiance")].tabs.tabs[0]).toMatchObject({ dirty: false }));
    expect(saveFile).toHaveBeenLastCalledWith("defiance/first.txt", "edited", stamp());
  });
});

it.each(["close", "quit"] as const)("%s re-prompts after typing during Save; Cancel retains the later edit", async (action) => {
  const actions = render();
  const first = await enterDefianceWithDirtyFirst(actions);
  const saving = deferred<FileStamp>();
  vi.mocked(saveFile).mockImplementationOnce(() => saving.promise);
  const transition = action === "close" ? actions.closeActiveTab() : actions.requestQuit();
  await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
  fixture.prompts[0].resolve("save");
  await vi.waitFor(() => expect(saveFile).toHaveBeenCalledWith("defiance/first.txt", "edited", stamp()));
  first.setValue("later unsaved edit");
  saving.resolve(stamp("2:3", 5));
  await vi.waitFor(() => expect(fixture.prompts).toHaveLength(2));
  fixture.prompts[1].resolve("cancel");
  await transition;
  expect(first.content).toBe("later unsaved edit");
  expect(first.dispose).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
  expect(actions.snapshot().scopes[workKey("defiance")].tabs.tabs[0]).toMatchObject({ dirty: true, stamp: stamp("2:3", 5) });
});
