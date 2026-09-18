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
import { appendLog, quit, readFile, saveUiState, statFile } from "./subject";
import type { Entry, FileContent, FileStamp } from "./subject";
import { classifyRoot, visualViewPath, workKey } from "./places";
import { editorId, idOf, markdownId, tabIdOf } from "./tabs";
import { EMPTY_STATE, setRoot, setScopeLayout, type UiState } from "./uiState";

// Step 5 at the App level: the `view` tab kind, `openPath` with kind
// `view`, ownership of `views/<place>/**`, restore and persistence of
// `view:` ids, Refresh reaching view surfaces, closing, the Home target, and
// a landmark file opening beside the view without destroying it. Driven the
// same way as the Step 3 and 4 tests: one server render with seeded state,
// then the actions the shell hands out. The surfaces are mocked; the Visual
// View's own read, check, selection and inspector are tested for real in
// VisualView.test.tsx and viewSanitize.test.ts.
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
vi.mock("./VisualView", () => ({ VisualView: (_props: ComponentProps<typeof VisualView>) => null }));
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
const VIEW = visualViewPath("defiance");
const viewId = tabIdOf("view", VIEW);
const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });
const stamp = (mtime = 0): FileStamp => ({ identity: "1:2", mtime_secs: mtime, mtime_nanos: 0, len: 9 });
const file = (relPath: string): FileContent => ({ name: relPath.split("/").pop() ?? relPath, content: "from disk", stamp: stamp() });
const tabIds = (actions: AppActions, key: string) => actions.snapshot().scopes[key].tabs.tabs.map(idOf);
const tabs = (actions: AppActions, key: string) => actions.snapshot().scopes[key].tabs.tabs;
const active = (actions: AppActions, key: string) => actions.snapshot().scopes[key].tabs.active;
const logged = () => vi.mocked(appendLog).mock.calls.map((c) => String(c[0]));
const readPaths = () => vi.mocked(readFile).mock.calls.map((c) => String(c[0]));

/** Defiance remembers one editor tab; cockpit remembers one editor tab; optionally defiance also remembers its view tab as active. */
function rememberedUi(withView = false): UiState {
  let ui = setRoot(EMPTY_STATE, root.path);
  ui = setScopeLayout(ui, "work:defiance", {
    expanded: [],
    tabs: withView ? ["editor:defiance/first.txt", viewId] : ["editor:defiance/first.txt"],
    active: withView ? viewId : "editor:defiance/first.txt",
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
    home: { listing: classifyRoot([dir("defiance"), dir("cockpit"), dir("views"), dir("context")]), views: new Set(["defiance"]), git: new Map([["defiance", "repo"]]), rootView: { exists: false, saved: null } },
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

beforeEach(() => {
  vi.clearAllMocks();
  fixture.models.clear();
  vi.mocked(readFile).mockImplementation(async (path) => file(path));
  vi.mocked(statFile).mockResolvedValue(null);
});

describe("the view tab kind through openPath", () => {
  it("kind view opens a view: tab named after the place with no read and no model; again shows the same tab; Open source opens the Editor tab for the same file beside it", async () => {
    const actions = render();
    await enterDefiance(actions);
    const reads = readPaths().length;
    await actions.openPath(VIEW, null, "view");
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), viewId]);
    expect(active(actions, workKey("defiance"))).toBe(viewId);
    expect(tabs(actions, workKey("defiance"))[1]).toEqual({ kind: "view", relPath: VIEW, name: "defiance" });
    expect(readPaths()).toHaveLength(reads);
    expect(fixture.models.has(`/root/${VIEW}`)).toBe(false);

    await actions.openPath(VIEW, null, "view");
    expect(tabIds(actions, workKey("defiance"))).toHaveLength(2);

    // Open source: the real view file in the Editor, owned by defiance, beside the view tab.
    await actions.openPath(VIEW, null, "editor");
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), viewId, editorId(VIEW)]);
    expect(active(actions, workKey("defiance"))).toBe(editorId(VIEW));
    expect(fixture.models.has(`/root/${VIEW}`)).toBe(true);
    expect(readPaths()).toContain(VIEW);
    expect(actions.snapshot().activeKey).toBe(workKey("defiance"));
    expect(Object.keys(actions.snapshot().scopes)).not.toContain("work:views");
  });

  it("without an explicit kind an .svg path opens in the Editor, so the view is never guessed from an extension", async () => {
    const actions = render();
    await enterDefiance(actions);
    await actions.openPath("defiance/docs/diagram.svg");
    expect(active(actions, workKey("defiance"))).toBe(editorId("defiance/docs/diagram.svg"));
    expect(fixture.models.has("/root/defiance/docs/diagram.svg")).toBe(true);
  });
});

describe("ownership: views/<place>/** belongs to the place", () => {
  it("another place cannot open defiance's view as a view or as source, and gets the notice and a log line", async () => {
    const actions = render();
    await actions.enterPlace("cockpit");
    expect(fixture.models.has("/root/cockpit/notes.txt")).toBe(true);
    await actions.openPath(VIEW, null, "view");
    await actions.openPath(VIEW, null, "editor");
    expect(tabIds(actions, workKey("cockpit"))).toEqual([editorId("cockpit/notes.txt")]);
    expect(fixture.models.has(`/root/${VIEW}`)).toBe(false);
    expect(logged().filter((l) => l.includes(`outside the subject: ${VIEW}`))).toHaveLength(2);
    // The place that owns it can.
    await enterDefiance(actions);
    await actions.openPath(VIEW, null, "view");
    expect(active(actions, workKey("defiance"))).toBe(viewId);
  });

  it("a landmark path outside the place is refused by the same openPath the inspector calls; one inside opens", async () => {
    const actions = render();
    await enterDefiance(actions);
    await actions.openPath(VIEW, null, "view");
    for (const outside of ["context/notes.md", "cockpit/notes.txt", "../defiance/README.md", "/etc/passwd", "views/cockpit/map.svg"]) {
      await actions.openPath(outside);
    }
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), viewId]);
    expect(logged().filter((l) => l.includes("outside the subject")).length).toBe(5);
    expect(fixture.models.size).toBe(1);
    await actions.openPath("defiance/src/defiance/corpus.py");
    expect(fixture.models.has("/root/defiance/src/defiance/corpus.py")).toBe(true);
  });
});

describe("a landmark file opens beside the view", () => {
  it("opening a source file from the view keeps the view tab open; the file's tab is shown; the view can be shown again; a .md landmark renders", async () => {
    const actions = render();
    await enterDefiance(actions);
    await actions.openPath(VIEW, null, "view");
    await actions.openPath("defiance/src/defiance/corpus.py");
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), viewId, editorId("defiance/src/defiance/corpus.py")]);
    expect(active(actions, workKey("defiance"))).toBe(editorId("defiance/src/defiance/corpus.py"));
    actions.showTab(viewId);
    expect(active(actions, workKey("defiance"))).toBe(viewId);
    expect(tabIds(actions, workKey("defiance"))).toHaveLength(3);
    await actions.openPath("defiance/README.md");
    expect(active(actions, workKey("defiance"))).toBe(markdownId("defiance/README.md"));
    expect(tabIds(actions, workKey("defiance"))).toContain(viewId);
    // A place switch and back leaves the view tab where it was.
    await actions.enterPlace("cockpit");
    await actions.enterPlace("defiance");
    expect(tabIds(actions, workKey("defiance"))).toContain(viewId);
    expect(actions.snapshot().activeKey).toBe(workKey("defiance"));
  });
});

describe("restore, persistence and the Home target", () => {
  it("a remembered view tab restores in strip order and active, with no read of the view file, and is written back as view:", async () => {
    const actions = render(rememberedUi(true));
    await enterDefiance(actions);
    expect(readPaths()).toEqual(["defiance/first.txt"]);
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), viewId]);
    expect(active(actions, workKey("defiance"))).toBe(viewId);
    expect(logged().some((l) => l.includes("defiance restored: 2 tabs"))).toBe(true);

    await actions.requestQuit();
    expect(quit).toHaveBeenCalled();
    const written = vi.mocked(saveUiState).mock.calls.map((c) => JSON.parse(String(c[0])) as UiState);
    const layout = written[written.length - 1].scopes["work:defiance"];
    expect(layout.tabs).toEqual(["editor:defiance/first.txt", viewId]);
    expect(layout.active).toBe(viewId);
  });

  it("the Home node's visual view target enters the place, waits for its restore, then shows the view tab", async () => {
    const actions = render();
    expect(actions.snapshot().activeKey).toBe("home");
    await actions.openVisualView("defiance");
    expect(actions.snapshot().activeKey).toBe(workKey("defiance"));
    expect(actions.snapshot().activeWork).toBe("defiance");
    expect(fixture.models.has("/root/defiance/first.txt")).toBe(true);
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt"), viewId]);
    expect(active(actions, workKey("defiance"))).toBe(viewId);
    expect(readPaths()).not.toContain(VIEW);
    // A second visit shows the same tab, adds nothing and reads nothing.
    actions.goHome();
    await actions.openVisualView("defiance");
    expect(tabIds(actions, workKey("defiance"))).toHaveLength(2);
    expect(readPaths()).toEqual(["defiance/first.txt"]);
  });

  it("a place that is not listed cannot be entered for its view", async () => {
    const actions = render();
    await actions.openVisualView("nowhere");
    expect(actions.snapshot().activeKey).toBe("home");
    expect(Object.keys(actions.snapshot().scopes)).toEqual(["home"]);
  });
});

describe("Refresh and close", () => {
  it("Refresh bumps the surface counter of every scope holding a view tab, whether or not it is showing, and no other", async () => {
    const actions = render();
    await enterDefiance(actions);
    await actions.openPath(VIEW, null, "view");
    await actions.enterPlace("cockpit");
    await actions.refresh();
    const after = actions.snapshot().scopes;
    expect(after[workKey("defiance")].surfaceReload).toBe(1);
    expect(after[workKey("defiance")].reload).toBe(0);
    expect(after[workKey("cockpit")].surfaceReload).toBe(0);
    expect(after[workKey("cockpit")].reload).toBe(1);
    expect(after.home.surfaceReload).toBe(0);
    expect(tabIds(actions, workKey("defiance"))).toContain(viewId);
    // Refresh never reads the view here: the surface reads its own file.
    expect(readPaths()).not.toContain(VIEW);
  });

  it("closing a view tab never asks, even while an editor tab in the place is dirty; Close Tab closes it; the remaining tabs are intact", async () => {
    const actions = render();
    await enterDefiance(actions);
    const first = fixture.models.get("/root/defiance/first.txt")!;
    first.content = "dirty";
    first.version = 4;
    await actions.openPath(VIEW, null, "view");
    await actions.closeActiveTab();
    await tick();
    expect(tabIds(actions, workKey("defiance"))).toEqual([editorId("defiance/first.txt")]);
    expect(fixture.prompts).toEqual([]);
    expect(first.dispose).not.toHaveBeenCalled();
    expect(active(actions, workKey("defiance"))).toBe(editorId("defiance/first.txt"));
  });
});
