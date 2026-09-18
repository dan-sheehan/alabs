import type { ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { type AppActions, type AppInitial } from "./App";
import { FileTree } from "./FileTree";
import { Rail } from "./Rail";
import { HomeBody } from "./Home";
import { appendLog, openRoot, pickFolder, readFile, saveFile, saveUiState, statFile } from "./subject";
import type { Entry, FileContent, FileStamp } from "./subject";
import { classifyRoot } from "./places";
import { EMPTY_STATE, setRoot, setScopeLayout, type UiState } from "./uiState";

// Render the real App once with seeded state (React effects do not run in a
// server render) and drive the actions it hands out during that render. The
// transitions read and write refs synchronously, which is exactly what these
// regressions guard: a lock or a guard that also protects callbacks from an
// earlier render. Native services and Monaco are mocked; the DOM interaction
// is the manual check in the running app.
interface Model {
  content: string;
  version: number;
  dispose: ReturnType<typeof vi.fn>;
  getAlternativeVersionId: () => number;
  getValue: () => string;
}

type Choice = "save" | "discard" | "cancel";

const fixture = vi.hoisted(() => ({
  rail: {} as ComponentProps<typeof Rail>,
  home: {} as ComponentProps<typeof HomeBody>,
  models: new Map<string, Model>(),
  prompts: [] as Array<{ name: string; resolve: (choice: Choice) => void }>,
}));

vi.mock("./FileTree", () => ({ FileTree: (_props: ComponentProps<typeof FileTree>) => null }));
vi.mock("./Rail", () => ({
  Rail: (props: ComponentProps<typeof Rail>) => {
    fixture.rail = props;
    return null;
  },
}));
vi.mock("./Home", () => ({
  HomeBody: (props: ComponentProps<typeof HomeBody>) => {
    fixture.home = props;
    return null;
  },
  HomeSidebar: () => null,
}));
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
  viewSession: vi.fn(async () => 1),
  searchPlace: vi.fn(),
  listLocalModels: vi.fn(async () => ({ kind: "unavailable" })),
  askLocalModel: vi.fn(async () => ({ kind: "unavailable" })),
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
}));

const root = { path: "/root", name: "root" };
const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });
const listing = classifyRoot([dir("defiance"), dir("cockpit"), dir("views")]);
const stamp = (identity = "1:2"): FileStamp => ({ identity, mtime_secs: 0, mtime_nanos: 0, len: 9 });
const file = (relPath: string, identity?: string): FileContent => ({
  name: relPath.split("/").pop() ?? relPath,
  content: "from disk",
  stamp: stamp(identity),
});

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

function render(ui: UiState = rememberedUi(), withRoot = true): { actions: AppActions; html: string } {
  let actions!: AppActions;
  fixture.prompts = [];
  const initial: AppInitial = {
    ui,
    root: withRoot ? root : null,
    home: withRoot ? { listing, views: new Set(), git: new Map(), rootView: { exists: false, saved: null } } : null,
    actions: (a) => {
      actions = a;
    },
    onUnsavedPrompt: (name, resolve) => fixture.prompts.push({ name, resolve }),
  };
  const html = renderToString(<App initial={initial} />);
  return { actions, html };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.models.clear();
  vi.mocked(readFile).mockImplementation(async (path) => file(path));
  vi.mocked(statFile).mockResolvedValue(null);
});

describe("CRITICAL: the restore lock", () => {
  it("blocks file open, Refresh and place switch until every remembered tab of the entered place has restored", async () => {
    const later = deferred<FileContent>();
    vi.mocked(readFile).mockImplementation(async (path) => (path === "defiance/later.txt" ? later.promise : file(path)));
    const { actions } = render();
    actions.enterPlace("defiance");
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledWith("defiance/later.txt"));
    const first = fixture.models.get("/root/defiance/first.txt")!;
    expect(first).toBeDefined();

    // Under the lock: nothing opens, nothing refreshes, no place switch, no root change.
    await actions.openPath("defiance/first.txt");
    await actions.openPath("defiance/fresh.txt");
    await actions.openPath("defiance/later.txt", 1);
    await actions.refresh();
    actions.enterPlace("cockpit");
    actions.goHome();
    await actions.changeRoot();
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readFile).not.toHaveBeenCalledWith("cockpit/notes.md");
    expect(statFile).not.toHaveBeenCalled();
    expect(pickFolder).not.toHaveBeenCalled();
    expect(first.dispose).not.toHaveBeenCalled();

    later.resolve(file("defiance/later.txt"));
    await vi.waitFor(() => expect(fixture.models.has("/root/defiance/later.txt")).toBe(true));
    first.content = "new unsaved edit";
    first.version = 2;
    await actions.openPath("defiance/fresh.txt");
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(fixture.models.has("/root/defiance/fresh.txt")).toBe(true);
    expect(first.content).toBe("new unsaved edit");
    expect(first.dispose).not.toHaveBeenCalled();
    // And the lock is gone: a place switch now works and lists nothing twice.
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledWith("cockpit/notes.md"));
  });

  it("resumes interaction when every remembered file fails to restore, and reports the failure", async () => {
    const missing = deferred<FileContent>();
    vi.mocked(readFile).mockImplementation(() => missing.promise);
    const { actions } = render();
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
    await actions.openPath("cockpit/fresh.txt");
    expect(readFile).toHaveBeenCalledTimes(1);
    missing.reject(new Error("missing file"));
    await vi.waitFor(() => expect(appendLog).toHaveBeenCalled());
    vi.mocked(readFile).mockImplementation(async (path) => file(path));
    await actions.openPath("cockpit/fresh.txt");
    expect(fixture.models.has("/root/cockpit/fresh.txt")).toBe(true);
    expect(String(vi.mocked(appendLog).mock.calls[0][0])).toContain("1 file could not be opened: notes.md");
  });
});

describe("non-destructive place switching", () => {
  it("keeps a dirty buffer and its tabs intact across Home and another place, and never prompts", async () => {
    const { actions } = render();
    actions.enterPlace("defiance");
    await vi.waitFor(() => expect(fixture.models.has("/root/defiance/later.txt")).toBe(true));
    const first = fixture.models.get("/root/defiance/first.txt")!;
    first.content = "edited";
    first.version = 7;
    actions.goHome();
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(fixture.models.has("/root/cockpit/notes.md")).toBe(true));
    await actions.openPath("cockpit/other.md", null, "editor");
    actions.goHome();
    actions.enterPlace("defiance");
    await tick();
    // Returning re-reads nothing and disposes nothing: the scope is live.
    expect(readFile).toHaveBeenCalledTimes(4);
    expect(fixture.models.get("/root/defiance/first.txt")).toBe(first);
    expect(first.content).toBe("edited");
    expect(first.dispose).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(fixture.prompts).toEqual([]);
  });

  it("refuses to open a path that another place owns, and opens its own view files", async () => {
    const { actions } = render();
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(fixture.models.has("/root/cockpit/notes.md")).toBe(true));
    await actions.openPath("defiance/first.txt");
    await actions.openPath("views/defiance/index.html");
    await actions.openPath("README.md");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(fixture.models.has("/root/defiance/first.txt")).toBe(false);
    await actions.openPath("views/cockpit/index.html");
    expect(fixture.models.has("/root/views/cockpit/index.html")).toBe(true);
  });
});

describe("CRITICAL: root change is transactional (item 24)", () => {
  async function enterBothWithDirtyDefiance() {
    const { actions } = render();
    actions.enterPlace("defiance");
    await vi.waitFor(() => expect(fixture.models.has("/root/defiance/later.txt")).toBe(true));
    const first = fixture.models.get("/root/defiance/first.txt")!;
    first.content = "unsaved";
    first.version = 3;
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(fixture.models.has("/root/cockpit/notes.md")).toBe(true));
    return { actions, first };
  }

  it("a dirty buffer in an inactive scope still prompts; Cancel after selection leaves both sides on the old root", async () => {
    const { actions, first } = await enterBothWithDirtyDefiance();
    vi.mocked(pickFolder).mockResolvedValue("/elsewhere");
    const change = actions.changeRoot();
    await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(fixture.prompts[0].name).toBe("first.txt");
    expect(openRoot).not.toHaveBeenCalled();
    fixture.prompts[0].resolve("cancel");
    await change;
    expect(openRoot).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(first.dispose).not.toHaveBeenCalled();
    expect(first.content).toBe("unsaved");
    // The old scopes still work against the old root.
    await actions.openPath("cockpit/other.md", null, "editor");
    expect(fixture.models.has("/root/cockpit/other.md")).toBe(true);
  });

  it("an open failure keeps the old root and every buffer, and names the failure", async () => {
    const { actions, first } = await enterBothWithDirtyDefiance();
    vi.mocked(pickFolder).mockResolvedValue("/elsewhere");
    vi.mocked(openRoot).mockRejectedValue("cannot open /elsewhere: No such file or directory (os error 2)");
    const change = actions.changeRoot();
    await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
    fixture.prompts[0].resolve("discard");
    await change;
    expect(openRoot).toHaveBeenCalledWith("/elsewhere");
    expect(first.dispose).not.toHaveBeenCalled();
    expect(first.content).toBe("unsaved");
    expect(fixture.models.has("/root/cockpit/notes.md")).toBe(true);
    await actions.openPath("cockpit/other.md", null, "editor");
    expect(fixture.models.has("/root/cockpit/other.md")).toBe(true);
    const logged = vi.mocked(appendLog).mock.calls.map((c) => String(c[0]));
    // The failure is logged with the technical reason, but no absolute root path, not even the candidate's.
    expect(logged.some((l) => l.includes("cannot open") && l.includes("<root>") && l.includes("os error 2"))).toBe(true);
    expect(logged.some((l) => l.includes("/elsewhere") || l.includes("/root"))).toBe(false);
  });

  it("success replaces both sides together: the old layout is written, then every old buffer is disposed", async () => {
    const { actions, first } = await enterBothWithDirtyDefiance();
    const cockpit = fixture.models.get("/root/cockpit/notes.md")!;
    vi.mocked(pickFolder).mockResolvedValue("/elsewhere");
    vi.mocked(openRoot).mockResolvedValue({ path: "/elsewhere", name: "elsewhere" });
    vi.mocked(saveFile).mockResolvedValue(stamp("1:2"));
    const change = actions.changeRoot();
    await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
    fixture.prompts[0].resolve("save");
    await change;
    expect(saveFile).toHaveBeenCalledWith("defiance/first.txt", "unsaved", stamp("1:2"));
    expect(openRoot).toHaveBeenCalledWith("/elsewhere");
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(cockpit.dispose).toHaveBeenCalledTimes(1);
    expect(fixture.models.size).toBe(0);
    const written = vi.mocked(saveUiState).mock.calls.map((c) => JSON.parse(String(c[0])) as UiState);
    expect(written.length).toBeGreaterThan(0);
    expect(written[0].root).toBe("/root");
    expect(written[0].scopes["work:cockpit"].tabs).toEqual(["editor:cockpit/notes.md"]);
    expect(written[0].scopes["work:defiance"].tabs).toEqual(["editor:defiance/first.txt", "editor:defiance/later.txt"]);
    // After the switch, a file open reaches nothing of the old root.
    await actions.openPath("cockpit/other.md", null, "editor");
    expect(fixture.models.size).toBe(0);
  });

  it("a cancelled folder pick changes nothing on either side", async () => {
    const { actions, first } = await enterBothWithDirtyDefiance();
    vi.mocked(pickFolder).mockResolvedValue(null);
    await actions.changeRoot();
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(fixture.prompts).toHaveLength(0);
    expect(openRoot).not.toHaveBeenCalled();
    expect(first.dispose).not.toHaveBeenCalled();
  });
});

describe("regression: two in-root paths to one file (item 28)", () => {
  it("open as two tabs; after one saves, the second save is a named conflict and keeps its dirty buffer", async () => {
    const { actions } = render();
    vi.mocked(readFile).mockImplementation(async (path) => file(path, "9:9"));
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(fixture.models.has("/root/cockpit/notes.md")).toBe(true));
    await actions.openPath("cockpit/a/link.txt");
    await actions.openPath("cockpit/b/real.txt");
    const viaLink = fixture.models.get("/root/cockpit/a/link.txt")!;
    const direct = fixture.models.get("/root/cockpit/b/real.txt")!;
    expect(viaLink).not.toBe(direct);

    // The first save lands and gives the file a new stamp on disk.
    const after = { ...stamp("9:9"), mtime_secs: 5 };
    vi.mocked(saveFile).mockResolvedValueOnce(after);
    viaLink.content = "from link";
    viaLink.version = 2;
    actions.showTab("editor:cockpit/a/link.txt");
    actions.saveActive();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile).toHaveBeenCalledWith("cockpit/a/link.txt", "from link", stamp("9:9"));

    // The second tab holds the old stamp: Rust refuses, alabs marks the conflict and keeps the buffer.
    vi.mocked(saveFile).mockRejectedValueOnce("cockpit/b/real.txt changed on disk since it was opened; save refused");
    vi.mocked(statFile).mockResolvedValueOnce(after);
    direct.content = "from direct";
    direct.version = 2;
    actions.showTab("editor:cockpit/b/real.txt");
    actions.saveActive();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(appendLog).toHaveBeenCalledWith(expect.stringContaining("changed on disk")));
    expect(direct.dispose).not.toHaveBeenCalled();
    expect(direct.content).toBe("from direct");
    expect(fixture.models.get("/root/cockpit/b/real.txt")).toBe(direct);
    // Closing that tab now asks: the buffer is still dirty, not silently dropped.
    const close = actions.requestClose("editor:cockpit/b/real.txt");
    await vi.waitFor(() => expect(fixture.prompts).toHaveLength(1));
    fixture.prompts[0].resolve("cancel");
    await close;
    expect(direct.dispose).not.toHaveBeenCalled();
  });
});

describe("log failures never block", () => {
  it("a failing log write leaves the triggering action's result unchanged", async () => {
    vi.mocked(appendLog).mockRejectedValue(new Error("disk full"));
    const missing = deferred<FileContent>();
    vi.mocked(readFile).mockImplementation(() => missing.promise);
    const { actions } = render();
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
    missing.reject(new Error("missing file"));
    await vi.waitFor(() => expect(appendLog).toHaveBeenCalled());
    // The restore finished and released the lock even though the log write failed.
    vi.mocked(readFile).mockImplementation(async (path) => file(path));
    await vi.waitFor(async () => {
      await actions.openPath("cockpit/fresh.txt");
      expect(fixture.models.has("/root/cockpit/fresh.txt")).toBe(true);
    });
  });

  it("never logs the absolute root path", async () => {
    const { actions } = render();
    actions.enterPlace("cockpit");
    await vi.waitFor(() => expect(fixture.models.has("/root/cockpit/notes.md")).toBe(true));
    await vi.waitFor(() => expect(appendLog).toHaveBeenCalled());
    for (const call of vi.mocked(appendLog).mock.calls) expect(String(call[0])).not.toContain("/root");
    expect(String(vi.mocked(appendLog).mock.calls[0][0])).toContain("cockpit restored: 1 tab");
  });
});

describe("first launch", () => {
  it("shows one sentence and one chip, and no foundation words", () => {
    const { html } = render(EMPTY_STATE, false);
    expect(html).toContain("Choose your alabs root folder.");
    expect(html).toContain("Choose folder…");
    expect(html).toContain("◉");
    expect(html).not.toContain("subject");
    expect(html).not.toContain("Select a file to view it.");
  });
});
