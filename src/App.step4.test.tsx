import type { ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { type AppActions, type AppInitial } from "./App";
import { FileTree } from "./FileTree";
import { Rail } from "./Rail";
import { HomeBody } from "./Home";
import { Overview } from "./Overview";
import { MarkdownView } from "./MarkdownView";
import { appendLog, quit, readFile, saveUiState, statFile } from "./subject";
import type { Entry, FileContent, FileStamp } from "./subject";
import { classifyRoot, workKey } from "./places";
import { editorId, idOf, markdownId } from "./tabs";
import { EMPTY_STATE, setRoot, setScopeLayout, type UiState } from "./uiState";

// Step 4 at the App level: the Markdown tab kind, kind selection in
// `openPath`, restore and persistence of `markdown:` ids, Refresh reloading
// surfaces while never touching a dirty buffer, and closing. Driven the same
// way as the Step 2 and 3 tests: one server render with seeded state, then
// the actions the shell hands out. The rendered surfaces are mocked; their
// own reads are tested in overviewFacts.test.ts and in the browser.
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
vi.mock("./MarkdownView", () => ({ MarkdownView: (_props: ComponentProps<typeof MarkdownView>) => null }));
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
  gitFacts: vi.fn(async () => ({ kind: "none" })),
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
const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });
const fileEntry = (relPath: string): Entry => ({ name: relPath.split("/").pop() ?? relPath, rel_path: relPath, is_dir: false });
const stamp = (mtime = 0): FileStamp => ({ identity: "1:2", mtime_secs: mtime, mtime_nanos: 0, len: 9 });
const file = (relPath: string): FileContent => ({ name: relPath.split("/").pop() ?? relPath, content: "from disk", stamp: stamp() });
const tabIds = (actions: AppActions, key: string) => actions.snapshot().scopes[key].tabs.tabs.map(idOf);
const active = (actions: AppActions, key: string) => actions.snapshot().scopes[key].tabs.active;
const logged = () => vi.mocked(appendLog).mock.calls.map((c) => String(c[0]));
const key = (k: string, mods: Partial<{ meta: boolean; shift: boolean }> = {}) => ({
  key: k,
  metaKey: mods.meta ?? false,
  ctrlKey: false,
  shiftKey: mods.shift ?? false,
  altKey: false,
  preventDefault: vi.fn(),
});

/** Defiance remembers one editor tab; cockpit remembers a rendered README before an editor tab, with the README active. */
function rememberedUi(): UiState {
  let ui = setRoot(EMPTY_STATE, root.path);
  ui = setScopeLayout(ui, "work:defiance", { expanded: [], tabs: ["editor:defiance/first.txt"], active: "editor:defiance/first.txt", views: {}, visited: 2 });
  ui = setScopeLayout(ui, "work:cockpit", {
    expanded: [],
    tabs: ["markdown:cockpit/README.md", "editor:cockpit/notes.txt"],
    active: "markdown:cockpit/README.md",
    views: {},
    visited: 1,
  });
  return ui;
}

function render(): AppActions {
  let actions!: AppActions;
  fixture.prompts = [];
  const initial: AppInitial = {
    ui: rememberedUi(),
    root,
    home: { listing: classifyRoot([dir("defiance"), dir("cockpit"), dir("wiki")]), views: new Set(), git: new Map([["defiance", "repo"]]), rootView: { exists: false, saved: null } },
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
  actions.enterPlace("defiance");
  await vi.waitFor(() => expect(fixture.models.has("/root/defiance/first.txt")).toBe(true));
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.models.clear();
  vi.mocked(readFile).mockImplementation(async (path) => file(path));
  vi.mocked(statFile).mockResolvedValue(null);
});

describe("kind selection in openPath (Step 3 item 20, built here)", () => {
  it("a .md file opens rendered with no read and no model; Open source opens the Editor tab beside it; a search hit with a line opens the Editor", async () => {
    const actions = render();
    await enterDefiance(actions);
    const reads = vi.mocked(readFile).mock.calls.length;
    await actions.openPath("defiance/README.md");
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), markdownId("defiance/README.md")]);
    expect(active(actions, workKey("defiance"))).toBe(markdownId("defiance/README.md"));
    expect(readFile).toHaveBeenCalledTimes(reads);
    expect(fixture.models.has("/root/defiance/README.md")).toBe(false);

    await actions.openPath("defiance/README.md", null, "editor");
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), markdownId("defiance/README.md"), editorId("defiance/README.md")]);
    expect(active(actions, workKey("defiance"))).toBe(editorId("defiance/README.md"));
    expect(fixture.models.has("/root/defiance/README.md")).toBe(true);

    // Opening the rendered view again shows the existing tab; nothing is added.
    await actions.openPath("defiance/README.md");
    expect(tabIds(actions, workKey("defiance"))).toHaveLength(3);
    expect(active(actions, workKey("defiance"))).toBe(markdownId("defiance/README.md"));

    // A content search hit names a line, so it opens the Editor even for .md.
    await actions.openPath("defiance/docs/guide.md", 4);
    expect(active(actions, workKey("defiance"))).toBe(editorId("defiance/docs/guide.md"));
    expect(fixture.models.has("/root/defiance/docs/guide.md")).toBe(true);
    // Anything else opens in the Editor by default; .MD counts as Markdown.
    await actions.openPath("defiance/a.py");
    expect(active(actions, workKey("defiance"))).toBe(editorId("defiance/a.py"));
    await actions.openPath("defiance/NOTES.MD");
    expect(active(actions, workKey("defiance"))).toBe(markdownId("defiance/NOTES.MD"));
  });

  it("a rendered view still obeys the place boundary and the lock", async () => {
    const actions = render();
    await enterDefiance(actions);
    await actions.openPath("cockpit/README.md");
    await actions.openPath("wiki/notes.md");
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt")]);
    expect(logged().filter((l) => l.includes("outside the subject")).length).toBe(2);
  });
});

describe("restore and persistence of markdown: ids", () => {
  it("a remembered rendered README restores in strip order with no read, and is written back as markdown:", async () => {
    const actions = render();
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(fixture.models.has("/root/cockpit/notes.txt")).toBe(true));
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).not.toHaveBeenCalledWith("cockpit/README.md");
    expect(tabIds(actions, workKey("cockpit"))).toEqual([markdownId("cockpit/README.md"), editorId("cockpit/notes.txt")]);
    expect(active(actions, workKey("cockpit"))).toBe(markdownId("cockpit/README.md"));
    expect(logged().some((l) => l.includes("cockpit restored: 2 tabs"))).toBe(true);

    await actions.requestQuit();
    expect(quit).toHaveBeenCalled();
    const written = vi.mocked(saveUiState).mock.calls.map((c) => JSON.parse(String(c[0])) as UiState);
    expect(written.length).toBeGreaterThan(0);
    const layout = written[written.length - 1].scopes["work:cockpit"];
    expect(layout.tabs).toEqual(["markdown:cockpit/README.md", "editor:cockpit/notes.txt"]);
    expect(layout.active).toBe("markdown:cockpit/README.md");
  });
});

describe("Refresh reloads the Overview and every open Markdown surface, never a dirty buffer", () => {
  it("bumps the tree and Overview of the place showing, the surfaces of every scope with a rendered tab, and marks the dirty README as a conflict with its text intact", async () => {
    const actions = render();
    await enterDefiance(actions);
    await actions.openPath("defiance/README.md");
    await actions.openPath("defiance/README.md", null, "editor");
    const readme = fixture.models.get("/root/defiance/README.md")!;
    readme.content = "edited in the editor";
    readme.version = 5;
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(fixture.models.has("/root/cockpit/notes.txt")).toBe(true));
    const before = actions.snapshot().scopes;
    expect(before[workKey("defiance")].reload).toBe(0);
    expect(before[workKey("defiance")].surfaceReload).toBe(0);

    // The README changed on disk under the dirty editor tab.
    vi.mocked(statFile).mockImplementation(async (path) => (path === "defiance/README.md" ? stamp(9) : stamp()));
    vi.mocked(readFile).mockClear();
    await actions.refresh();
    const after = actions.snapshot().scopes;
    // Cockpit is showing: its tree and Overview re-read; its rendered README re-reads.
    expect(after[workKey("cockpit")].reload).toBe(1);
    expect(after[workKey("cockpit")].surfaceReload).toBe(1);
    // Defiance is not showing: no listing, but its rendered README re-reads from disk.
    expect(after[workKey("defiance")].reload).toBe(0);
    expect(after[workKey("defiance")].surfaceReload).toBe(1);
    // Home never re-reads surfaces.
    expect(after.home.surfaceReload).toBe(0);
    // The changed file is read, then the live buffer wins: it is untouched and marked, never overwritten.
    expect(readFile).toHaveBeenCalledWith("defiance/README.md");
    expect(readme.content).toBe("edited in the editor");
    expect(readme.version).toBe(5);
    const tab = after[workKey("defiance")].tabs.tabs.find((t) => idOf(t) === editorId("defiance/README.md"));
    expect(tab?.kind === "loaded" && tab.disk).toBe("conflict");
    expect(logged().some((l) => l.includes("Refresh: 1 file changed on disk, across 2 places"))).toBe(true);
    expect(fixture.prompts).toEqual([]);
  });

  it("a scope with no rendered tab is not bumped", async () => {
    const actions = render();
    await enterDefiance(actions);
    await actions.refresh();
    expect(actions.snapshot().scopes[workKey("defiance")].surfaceReload).toBe(0);
    expect(actions.snapshot().scopes[workKey("defiance")].reload).toBe(1);
  });
});

describe("closing, stepping and moving rendered tabs", () => {
  it("closes a rendered tab without asking even when the editor for the same path is dirty; quitting then asks exactly once", async () => {
    const actions = render();
    await enterDefiance(actions);
    await actions.openPath("defiance/README.md", null, "editor");
    const readme = fixture.models.get("/root/defiance/README.md")!;
    readme.content = "dirty";
    readme.version = 3;
    await actions.openPath("defiance/README.md");
    expect(active(actions, workKey("defiance"))).toBe(markdownId("defiance/README.md"));
    await actions.closeActiveTab();
    await tick();
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), editorId("defiance/README.md")]);
    expect(fixture.prompts).toEqual([]);
    expect(readme.dispose).not.toHaveBeenCalled();

    // A rendered and a dirty editor tab for the same path: one question, no loop.
    await actions.openPath("defiance/README.md");
    const quitting = actions.requestQuit();
    await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
    expect(fixture.prompts[0].name).toBe("README.md");
    fixture.prompts[0].resolve("discard");
    await quitting;
    expect(fixture.prompts).toHaveLength(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("Cmd+Shift+] steps through rendered tabs too, and a rename follows both tabs for the path", async () => {
    const actions = render();
    await enterDefiance(actions);
    await actions.openPath("defiance/README.md");
    await actions.openPath("defiance/README.md", null, "editor");
    actions.showOverview();
    actions.handleKey(key("]", { meta: true, shift: true }));
    expect(active(actions, workKey("defiance"))).toBe(editorId("defiance/first.txt"));
    actions.handleKey(key("]", { meta: true, shift: true }));
    expect(active(actions, workKey("defiance"))).toBe(markdownId("defiance/README.md"));
    actions.handleKey(key("]", { meta: true, shift: true }));
    expect(active(actions, workKey("defiance"))).toBe(editorId("defiance/README.md"));

    expect(await actions.renameEntry(fileEntry("defiance/README.md"), "GUIDE.md")).toBeNull();
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), markdownId("defiance/GUIDE.md"), editorId("defiance/GUIDE.md")]);
    expect(active(actions, workKey("defiance"))).toBe(editorId("defiance/GUIDE.md"));
    expect(fixture.models.has("/root/defiance/GUIDE.md")).toBe(true);
  });
});
