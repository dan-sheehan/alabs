import type { ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { type AppActions, type AppInitial } from "./App";
import { FileTree } from "./FileTree";
import { Rail } from "./Rail";
import { HomeBody, HomeSidebar } from "./Home";
import { Overview } from "./Overview";
import { MarkdownView } from "./MarkdownView";
import { VisualView } from "./VisualView";
import { appendLog, collectInventory, entryKind, generateLocalModelJson, listDir, openRoot, pickFolder, readFile, statFile, writeRootViewFiles, writeViewFiles } from "./subject";
import type { Entry, FileContent, FileStamp, Inventory, LocalModelResult } from "./subject";
import { classifyRoot, placeViewJsonPath, rootViewJsonPath, rootViewPath, visualViewPath } from "./places";
import { ROOT_INSTRUCTION } from "./rootEvidence";
import { serializeRootMap, type RootMap } from "./rootMap";
import { EMPTY_STATE, setLocalModel, setRoot, type UiState } from "./uiState";
import { RAVEN } from "./creatures";

// The root Visual View at the App level: an existing root map opens with
// no model at all; Refresh never builds one; Run Raven builds it after the place runs queued
// before it, on the same one-at-a-time queue, from the view.json files
// they wrote; a failure leaves Home usable and the old files alone; a
// Rebuild replaces them only on success; the Home column and canvas get
// the current facts; the log holds no content.

interface Model {
  content: string;
  version: number;
  dispose: ReturnType<typeof vi.fn>;
  getAlternativeVersionId: () => number;
  getValue: () => string;
  setValue: (text: string) => void;
}

const fixture = vi.hoisted(() => ({
  models: new Map<string, Model>(),
  sidebar: [] as Array<Record<string, unknown>>,
  body: [] as Array<Record<string, unknown>>,
}));

vi.mock("./FileTree", () => ({ FileTree: (_props: ComponentProps<typeof FileTree>) => null }));
vi.mock("./Overview", () => ({ Overview: (_props: ComponentProps<typeof Overview>) => null }));
vi.mock("./MarkdownView", () => ({ MarkdownView: (_props: ComponentProps<typeof MarkdownView>) => null }));
vi.mock("./VisualView", () => ({ VisualView: (_props: ComponentProps<typeof VisualView>) => null }));
vi.mock("./Rail", () => ({ Rail: (_props: ComponentProps<typeof Rail>) => null }));
vi.mock("./Home", () => ({
  HomeBody: (props: ComponentProps<typeof HomeBody>) => {
    fixture.body.push(props as unknown as Record<string, unknown>);
    return null;
  },
  HomeSidebar: (props: ComponentProps<typeof HomeSidebar>) => {
    fixture.sidebar.push(props as unknown as Record<string, unknown>);
    return null;
  },
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
vi.mock("./viewSanitize", () => ({
  parseView: (svg: string) => ({
    kind: "ok",
    svg: null,
    landmarks: Array.from(svg.matchAll(/data-landmark="([^"]*)"/g), (m) => ({ name: m[1], note: "", paths: [], badPaths: [] })),
  }),
}));
vi.mock("./subject", () => ({
  viewSession: vi.fn(async () => 1),
  pickFolder: vi.fn(),
  openRoot: vi.fn(),
  readFile: vi.fn(),
  collectInventory: vi.fn(),
  generateLocalModelJson: vi.fn(),
  writeViewFiles: vi.fn(async () => {}),
  writeRootViewFiles: vi.fn(async () => {}),
  statFile: vi.fn(),
  createFile: vi.fn(),
  createDir: vi.fn(),
  listDir: vi.fn(async () => []),
  entryKind: vi.fn(async () => "none"),
  gitFacts: vi.fn(async () => ({ kind: "none" })),
  loadUiState: vi.fn(),
  moveItem: vi.fn(),
  quit: vi.fn(),
  recreateFile: vi.fn(),
  saveFile: vi.fn(),
  saveUiState: vi.fn(async () => {}),
  appendLog: vi.fn(async () => {}),
  trashItem: vi.fn(),
  searchPlace: vi.fn(async () => ({ results: [], summary: { files: 0, results: 0, truncated: false, cancelled: false } })),
}));

const root = { path: "/root", name: "root" };
const MODEL = "chosen-local-model";
const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });
const stamp = (): FileStamp => ({ identity: "1:2", mtime_secs: 0, mtime_nanos: 0, len: 9 });
const file = (relPath: string, content: string): FileContent => ({ name: relPath.split("/").pop() ?? relPath, content, stamp: stamp() });
const logged = () => vi.mocked(appendLog).mock.calls.map((c) => String(c[0]).replace(/^\S+ (info|warn|error) /, ""));
const tick = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** The root: cockpit without a map, defiance with one, the three knowledge folders. */
const ROOT_ENTRIES = [dir("cockpit"), dir("context"), dir("defiance"), dir("definitions"), dir("views"), dir("wiki")];
const listing = () => classifyRoot(ROOT_ENTRIES);

/** Files on disk: the places' contents, and whatever a build wrote. */
let disk: Record<string, string>;
const BASE_FILES: Record<string, string> = {
  "cockpit/README.md": "# Cockpit\n\nStart with src/app.js.\n",
  "cockpit/src/app.js": "import { boot } from './boot.js';\nboot();\n",
  "defiance/README.md": "# Defiance\n\nA corpus for one season.\n",
};

function inventoryOf(place: string): Inventory {
  const entries = Object.keys(BASE_FILES)
    .filter((p) => p.startsWith(`${place}/`))
    .map((p) => ({ path: p.slice(place.length + 1), is_dir: false, size: BASE_FILES[p].length }));
  return { entries, truncated: false, files: entries.length, folders: 0 };
}

/** A true place map for cockpit, with one landmark the root prompt should later see as a candidate. */
function placeMapFor(place: string): string {
  return JSON.stringify({
    version: 1,
    title: `${place} title`,
    summary: `${place} summary.`,
    groups: [{ id: "all", label: "Everything", note: "" }],
    landmarks: [{ id: "boot-script", groupId: "all", label: "Boot script", note: "", paths: ["src/app.js"] }],
    connections: [],
  });
}

/** A root answer that names every current place and role. */
function rootAnswer(over: Partial<{ places: unknown[]; knowledge: unknown[] }> = {}): string {
  return JSON.stringify({
    version: 1,
    title: "alabs root",
    places: over.places ?? [
      { placeId: "cockpit", description: "Cockpit summary.", highlightIds: ["boot-script"] },
      { placeId: "defiance", description: "A corpus for one season.", highlightIds: [] },
    ],
    knowledge: over.knowledge ?? [{ role: "Context" }, { role: "Wiki" }, { role: "Definitions" }],
  });
}

const isRootPrompt = (prompt: string) => prompt.startsWith("=== ALABS ROOT ===");

/** Model answers: places answer with a true map; the root answers as told. Held answers wait for release. */
function modelAnswers(rootBehaviour: "answer" | "invalid" | "unavailable" | "hold", placeBehaviour: "answer" | "hold" = "answer") {
  const held: Array<{ key: string; prompt: string; release: (r: LocalModelResult) => void }> = [];
  vi.mocked(generateLocalModelJson).mockImplementation(
    (_model: string, _system: string, prompt: string) =>
      new Promise<LocalModelResult>((resolve) => {
        if (isRootPrompt(prompt)) {
          if (rootBehaviour === "hold") {
            held.push({ key: ".root", prompt, release: resolve });
            return;
          }
          if (rootBehaviour === "unavailable") resolve({ kind: "unavailable" });
          else if (rootBehaviour === "invalid") resolve({ kind: "answer", text: rootAnswer({ places: [{ placeId: "cockpit" }] }), model: MODEL });
          else resolve({ kind: "answer", text: rootAnswer(), model: MODEL });
          return;
        }
        const place = prompt.match(/=== PLACE (\S+) ===/)?.[1] ?? "?";
        if (placeBehaviour === "hold") {
          held.push({ key: place, prompt, release: resolve });
          return;
        }
        resolve({ kind: "answer", text: placeMapFor(place), model: MODEL });
      }),
  );
  return {
    held,
    release: (key: string, text?: string) => {
      const i = held.findIndex((h) => h.key === key);
      expect(i, `held ${key}`).toBeGreaterThanOrEqual(0);
      const h = held.splice(i, 1)[0];
      h.release({ kind: "answer", text: text ?? (key === ".root" ? rootAnswer() : placeMapFor(key)), model: MODEL });
      return h.prompt;
    },
  };
}

function ui(model: string | null = MODEL): UiState {
  return setLocalModel(setRoot(EMPTY_STATE, root.path), model);
}

const SAVED: RootMap = {
  version: 1,
  title: "alabs root",
  places: [
    { placeId: "cockpit", kind: "none", description: "old cockpit line", highlights: [] },
    { placeId: "defiance", kind: "none", description: "old defiance line", highlights: [{ id: "x", label: "Old" }] },
  ],
  knowledge: [
    { role: "context", label: "Context", folder: "context" },
    { role: "wiki", label: "Wiki", folder: "wiki" },
    { role: "definitions", label: "Definitions", folder: "definitions" },
  ],
};

function render(state: UiState = ui(), rootView: { exists: boolean; saved: RootMap | null } = { exists: false, saved: null }): AppActions {
  let actions!: AppActions;
  const initial: AppInitial = {
    ui: state,
    root,
    home: { listing: listing(), views: new Set(["defiance"]), git: new Map(), rootView },
    actions: (a) => {
      actions = a;
    },
  };
  renderToString(<App initial={initial} />);
  return actions;
}

const builds = (actions: AppActions) => Object.fromEntries([...actions.snapshot().builds].map(([k, v]) => [k, v.kind === "failed" ? `failed:${v.reason}` : v.kind]));
const rootWrites = () => vi.mocked(writeRootViewFiles).mock.calls.map((c) => ({ root: c[0], replace: c[3] }));
const rootPrompts = () => vi.mocked(generateLocalModelJson).mock.calls.filter((c) => isRootPrompt(String(c[2])));

/** The root map exists on disk (as an existence check and as its files). */
function rootMapOnDisk(saved: RootMap = SAVED) {
  disk[rootViewPath()] = '<svg xmlns="http://www.w3.org/2000/svg"><g data-landmark="cockpit" data-path="cockpit"></g></svg>';
  disk[rootViewJsonPath()] = serializeRootMap(saved);
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.models.clear();
  fixture.sidebar = [];
  fixture.body = [];
  disk = { ...BASE_FILES };
  vi.mocked(readFile).mockImplementation(async (path: string) => {
    const content = disk[path];
    if (content === undefined) throw `cannot read ${path}: No such file or directory (os error 2)`;
    return file(path, content);
  });
  vi.mocked(statFile).mockResolvedValue(null);
  vi.mocked(collectInventory).mockImplementation(async (place: string) => inventoryOf(place));
  vi.mocked(listDir).mockImplementation(async (rel: string) =>
    rel === ""
      ? ROOT_ENTRIES
      : Object.keys(disk)
          .filter((p) => p.startsWith(`${rel}/`) && !p.slice(rel.length + 1).includes("/"))
          .map((p) => ({ name: p.slice(rel.length + 1), rel_path: p, is_dir: false })),
  );
  // Existence follows the disk record: a place map, or the root map, exists once written.
  vi.mocked(entryKind).mockImplementation(async (rel: string) => (rel === visualViewPath("defiance") || disk[rel] !== undefined ? "file" : "none"));
  vi.mocked(writeViewFiles).mockImplementation(async (place: string, _root: string, viewJson: string, mapSvg: string) => {
    disk[placeViewJsonPath(place)] = viewJson;
    disk[visualViewPath(place)] = mapSvg;
  });
  vi.mocked(writeRootViewFiles).mockImplementation(async (_root: string, viewJson: string, mapSvg: string) => {
    disk[rootViewJsonPath()] = viewJson;
    disk[rootViewPath()] = mapSvg;
  });
});

describe("opening Home", () => {
  it("an existing root map opens with no model chosen and nothing on the local port: no model call, the saved facts on the canvas, Home usable", async () => {
    rootMapOnDisk();
    modelAnswers("unavailable");
    const actions = render(ui(null), { exists: true, saved: SAVED });
    expect(fixture.body[fixture.body.length - 1]?.rootBuild).toBeNull();
    await actions.refresh();
    await tick();
    expect(generateLocalModelJson).not.toHaveBeenCalled();
    expect(collectInventory).not.toHaveBeenCalled();
    expect(builds(actions)).toEqual({});
    expect(actions.snapshot().rootView).toEqual({ exists: true, saved: SAVED });
    await actions.enterPlace("cockpit");
    expect(actions.snapshot().activeKey).toBe("work:cockpit");
    await actions.openPath("cockpit/README.md", null, "editor");
    expect(fixture.models.has("/root/cockpit/README.md")).toBe(true);
    actions.goHome();
    expect(actions.snapshot().activeKey).toBe("home");
  });

  it("a missing root map queues nothing on Refresh, with or without a model chosen, and leaves Home usable", async () => {
    modelAnswers("answer");
    const actions = render(ui());
    await actions.refresh();
    await tick();
    expect(builds(actions)).toEqual({});
    expect(generateLocalModelJson).not.toHaveBeenCalled();
    render(ui(null));
    await actions.refresh();
    await tick();
    expect(builds(actions)).toEqual({});
    expect(generateLocalModelJson).not.toHaveBeenCalled();
    expect(writeRootViewFiles).not.toHaveBeenCalled();
    expect(actions.snapshot().rootView).toEqual({ exists: false, saved: null });
    await actions.enterPlace("defiance");
    expect(actions.snapshot().activeKey).toBe("work:defiance");
  });

  it("Refresh after removal of a saved map clears its existence without model or writes", async () => {
    rootMapOnDisk();
    const actions = render(ui(null), { exists: true, saved: SAVED });
    delete disk[rootViewPath()]; delete disk[rootViewJsonPath()];
    await actions.refresh(); await tick();
    expect(actions.snapshot().rootView).toEqual({ exists: false, saved: null });
    expect(generateLocalModelJson).not.toHaveBeenCalled();
    expect(writeRootViewFiles).not.toHaveBeenCalled();
    expect(writeViewFiles).not.toHaveBeenCalled();
  });

  it("Home reads the saved root facts once per Refresh and hands the column and the canvas the current listing", async () => {
    rootMapOnDisk();
    modelAnswers("answer");
    const actions = render(ui(null), { exists: false, saved: null });
    await actions.refresh();
    expect(readFile).toHaveBeenCalledWith(rootViewJsonPath());
    expect(actions.snapshot().rootView).toEqual({ exists: true, saved: SAVED });
    expect(actions.snapshot().rootReload).toBe(1);
    const sidebar = fixture.sidebar[fixture.sidebar.length - 1] as { home: { listing: ReturnType<typeof listing> } };
    expect(sidebar.home.listing.work.map((p) => p.name)).toEqual(["cockpit", "defiance"]);
  });
});

describe("Run Raven on the root", () => {
  it("runs after a place run queued before it, one model request at a time, and builds the root map from the view.json that run wrote", async () => {
    const model = modelAnswers("hold", "hold");
    const actions = render(ui(null));
    actions.runRaven("cockpit");
    actions.runRavenRoot();
    actions.runRavenRoot();
    await tick();
    expect(builds(actions)).toEqual({ cockpit: "building", ".root": "queued" });
    expect(generateLocalModelJson).toHaveBeenCalledTimes(1);
    expect(rootPrompts()).toHaveLength(0);
    expect(logged()).toContain("root view: queued");
    // Navigation never waits.
    await actions.enterPlace("defiance");
    expect(actions.snapshot().activeKey).toBe("work:defiance");
    actions.goHome();
    // The place finishes; only then does the root call go out, and it sees the new view.json.
    model.release("cockpit");
    await tick();
    expect(builds(actions)).toEqual({ cockpit: "built", ".root": "building" });
    expect(generateLocalModelJson).toHaveBeenCalledTimes(2);
    const prompt = model.release(".root");
    expect(prompt).toContain("=== WORK PLACE cockpit ===");
    expect(prompt).toContain("title: cockpit title");
    expect(prompt).toContain("- boot-script · landmark · Boot script");
    expect(prompt).toContain("=== WORK PLACE defiance ===");
    expect(prompt).toContain("title: Defiance");
    expect(prompt).toContain("- Definitions");
    expect(vi.mocked(generateLocalModelJson).mock.calls[1][1]).toBe(ROOT_INSTRUCTION);
    expect(vi.mocked(generateLocalModelJson).mock.calls.map((c) => c[0])).toEqual([RAVEN.model, RAVEN.model]);
    await tick();
    expect(builds(actions)).toEqual({ cockpit: "built", ".root": "built" });
    expect(rootWrites()).toEqual([{ root: "/root", replace: true }]);
    // Visible without a restart: Home's record and the canvas reload.
    const saved = actions.snapshot().rootView;
    expect(saved?.exists).toBe(true);
    expect(saved?.saved?.places.map((p) => [p.placeId, p.description, p.highlights.map((h) => h.label)])).toEqual([
      ["cockpit", "Cockpit summary.", ["Boot script"]],
      ["defiance", "A corpus for one season.", []],
    ]);
    expect(saved?.saved?.knowledge.map((k) => k.role)).toEqual(["context", "wiki", "definitions"]);
    expect(actions.snapshot().rootReload).toBe(1);
    expect(logged().some((l) => /^root view: built · \d+ s · 2 places$/.test(l))).toBe(true);
    // Only the place run read the repository; the root read the saved view and the README.
    expect(vi.mocked(collectInventory).mock.calls.map((c) => c[0])).toEqual(["cockpit"]);
  });

  it("a failed root run leaves Home usable, writes nothing, logs the category only, and a later run may try again; Refresh never does", async () => {
    modelAnswers("invalid");
    const actions = render();
    actions.runRavenRoot();
    await tick();
    expect(builds(actions)[".root"]).toBe("failed:invalid");
    expect(writeRootViewFiles).not.toHaveBeenCalled();
    expect(logged()).toContain("root view: failed · invalid (missing place)");
    expect(fixture.body[fixture.body.length - 1]?.rootBuild).toBeNull();
    await actions.enterPlace("cockpit");
    expect(actions.snapshot().activeKey).toBe("work:cockpit");
    modelAnswers("answer");
    await actions.refresh();
    await tick();
    expect(rootPrompts()).toHaveLength(1);
    actions.runRavenRoot();
    await tick();
    expect(builds(actions)[".root"]).toBe("built");
  });

  it("an unreachable local model marks the root view too, and Home stays usable", async () => {
    modelAnswers("unavailable");
    const actions = render();
    actions.runRavenRoot();
    await tick();
    expect(builds(actions)).toEqual({ ".root": "failed:unavailable" });
    await actions.enterPlace("defiance");
    expect(actions.snapshot().activeKey).toBe("work:defiance");
  });

  it("needs no model chosen in alabs: Raven's own model builds the root map, reading only views/ and the places", async () => {
    rootMapOnDisk();
    modelAnswers("answer");
    const actions = render(ui(null), { exists: true, saved: SAVED });
    actions.runRavenRoot();
    await tick();
    expect(builds(actions)[".root"]).toBe("built");
    expect(vi.mocked(generateLocalModelJson).mock.calls.map((c) => c[0])).toEqual([RAVEN.model]);
    expect(rootWrites()).toEqual([{ root: "/root", replace: true }]);
    for (const [path] of vi.mocked(readFile).mock.calls) expect(String(path)).toMatch(/^(views\/|cockpit\/|defiance\/)/);
    expect(actions.snapshot().localModel).toBeNull();
  });

  it("a failed rebuild keeps the previous root files and facts", async () => {
    rootMapOnDisk();
    modelAnswers("invalid");
    const actions = render(ui(), { exists: true, saved: SAVED });
    actions.runRavenRoot();
    await tick();
    expect(builds(actions)[".root"]).toBe("failed:invalid");
    expect(writeRootViewFiles).not.toHaveBeenCalled();
    expect(disk[rootViewJsonPath()]).toBe(serializeRootMap(SAVED));
    expect(actions.snapshot().rootView).toEqual({ exists: true, saved: SAVED });
    actions.goHome();
    expect(actions.snapshot().activeKey).toBe("home");
  });

  it("a successful rebuild replaces both files from the current place set and updates the canvas", async () => {
    rootMapOnDisk();
    modelAnswers("answer");
    const actions = render(ui(), { exists: true, saved: SAVED });
    actions.runRavenRoot();
    await tick();
    expect(builds(actions)[".root"]).toBe("built");
    expect(rootWrites()).toEqual([{ root: "/root", replace: true }]);
    expect(actions.snapshot().rootView?.saved?.places.map((p) => p.description)).toEqual(["Cockpit summary.", "A corpus for one season."]);
    expect(disk[rootViewJsonPath()]).not.toBe(serializeRootMap(SAVED));
    expect(actions.snapshot().rootReload).toBe(1);
  });

  it("a root change forgets the old root's queue; the new root, with no map of its own, queues nothing", async () => {
    modelAnswers("hold", "hold");
    const actions = render();
    actions.runRaven("cockpit");
    actions.runRavenRoot();
    await tick();
    expect(builds(actions)).toEqual({ cockpit: "building", ".root": "queued" });
    vi.mocked(pickFolder).mockResolvedValue("/other");
    vi.mocked(openRoot).mockResolvedValue({ path: "/other", name: "other" });
    vi.mocked(listDir).mockImplementation(async () => []);
    disk = {};
    await actions.changeRoot();
    await tick();
    expect(builds(actions)).toEqual({});
    expect(rootPrompts()).toHaveLength(0);
    expect(actions.snapshot().rootView).toEqual({ exists: false, saved: null });
  });
});

describe("the log", () => {
  it("names only the queue events and categories, never evidence, prompt, descriptions or highlights", async () => {
    modelAnswers("answer");
    const actions = render();
    actions.runRavenRoot();
    await tick();
    const lines = logged().filter((l) => l.startsWith("root view"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of logged()) {
      expect(line).not.toContain("=== ");
      expect(line).not.toContain("summary");
      expect(line).not.toContain("Boot script");
      expect(line).not.toContain("boot-script");
      expect(line).not.toContain("corpus");
      expect(line).not.toContain(MODEL);
      expect(line).not.toContain("/root");
    }
  });
});

describe("navigation from the canvas", () => {
  it("the canvas and the column get the same seams every other surface uses: enter place, open its Visual View, enter a role", async () => {
    rootMapOnDisk();
    modelAnswers("answer");
    const actions = render(ui(null), { exists: true, saved: SAVED });
    const body = fixture.body[fixture.body.length - 1] as { onOpenPlace: (n: string) => void; onOpenView: (n: string) => void; onOpenRole: (r: "wiki") => void };
    body.onOpenPlace("cockpit");
    await tick();
    expect(actions.snapshot().activeKey).toBe("work:cockpit");
    body.onOpenView("defiance");
    await tick();
    expect(actions.snapshot().activeKey).toBe("work:defiance");
    expect(actions.snapshot().scopes["work:defiance"].tabs.active).toBe(`view:${visualViewPath("defiance")}`);
    body.onOpenRole("wiki");
    expect(actions.snapshot().activeKey).toBe("know:wiki");
    // The root view folder itself is never a place and never opens as a tab.
    await actions.openPath(rootViewPath(), null, "view");
    expect(Object.keys(actions.snapshot().scopes)).not.toContain("work:.root");
  });
});
