// @ts-expect-error Node is available in the Vitest runtime; no new dependency is needed.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
// @ts-expect-error Node is available in the Vitest runtime.
import { tmpdir } from "node:os";
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
import { appendLog, collectInventory, createFile, createDir, entryKind, generateLocalModelJson, listDir, moveItem, openRoot, pickFolder, readFile, recreateFile, saveFile, searchPlace, statFile, trashItem, writeViewFiles } from "./subject";
import { RAVEN } from "./creatures";
import { ViewQueue } from "./viewBuild";
import type { Entry, FileContent, FileStamp, Inventory, LocalModelResult } from "./subject";
import { classifyRoot, rootViewPath, visualViewPath } from "./places";
import { EMPTY_STATE, setLocalModel, setRoot, type UiState } from "./uiState";

// Raven at the App level: Refresh never builds and never calls a model;
// `Run Raven` is the only trigger, with Raven's own model; the queue (one
// at a time, never twice); Raven's actions reach the whole place through
// the app's own listing, search and read; navigation never waits; the
// smallest state update on success; a root change; the write boundary;
// and the log that never holds content. The workflow itself is tested in
// viewBuild.test.ts; here the model and the bridge are fakes.

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
// The sanitizer needs a DOM; here the count of landmarks is what the pipeline checks.
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
const fileEntry = (name: string): Entry => ({ name, rel_path: name, is_dir: false });
const stamp = (): FileStamp => ({ identity: "1:2", mtime_secs: 0, mtime_nanos: 0, len: 9 });
const file = (relPath: string, content: string): FileContent => ({ name: relPath.split("/").pop() ?? relPath, content, stamp: stamp() });
/** Logged lines without their time and level. */
const logged = () => vi.mocked(appendLog).mock.calls.map((c) => String(c[0]).replace(/^\S+ (info|warn|error) /, ""));
const tick = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** The root: two places without a map (cockpit, zed), one with (defiance), and everything that is never a place. */
const ROOT_ENTRIES = [dir("cockpit"), dir("context"), dir("defiance"), dir("views"), dir("zed"), dir(".hidden"), fileEntry("linked"), fileEntry("notes.txt")];
const listing = () => classifyRoot(ROOT_ENTRIES);

const PLACE_FILES: Record<string, string> = {
  "cockpit/README.md": "# Cockpit\n\nStart with src/app.js.\n",
  "cockpit/src/app.js": "import { boot } from './boot.js';\nboot();\n",
  "cockpit/src/boot.js": "export function boot() {}\n",
  "zed/README.md": "# Zed\n",
  "zed/main.py": "print('zed')\n",
  "defiance/first.txt": "from disk",
  "cockpit/notes.txt": "notes",
};

function inventoryOf(place: string): Inventory {
  const entries = Object.keys(PLACE_FILES)
    .filter((p) => p.startsWith(`${place}/`))
    .map((p) => ({ path: p.slice(place.length + 1), is_dir: false, size: PLACE_FILES[p].length }));
  return { entries, truncated: false, files: entries.length, folders: 0 };
}

/** A true map for each place. */
function mapFor(place: string): string {
  const paths = Object.keys(PLACE_FILES)
    .filter((p) => p.startsWith(`${place}/`))
    .map((p) => p.slice(place.length + 1));
  return JSON.stringify({
    version: 1,
    title: place,
    summary: "A place.",
    groups: [{ id: "all", label: "All", note: "" }],
    landmarks: [{ id: "first", groupId: "all", label: "First file", note: "", paths: [paths[0]] }],
    connections: [],
  });
}

/** Model answers by the place named in the prompt: immediate, or held until released. */
function modelAnswers(behaviour: "answer" | "unavailable" | "hold") {
  const held: Array<{ place: string; release: (r: LocalModelResult) => void }> = [];
  vi.mocked(generateLocalModelJson).mockImplementation(
    (_model: string, _system: string, prompt: string) =>
      new Promise<LocalModelResult>((resolve) => {
        const place = prompt.match(/=== PLACE (\S+) ===/)?.[1] ?? "?";
        if (behaviour === "hold") {
          held.push({ place, release: resolve });
          return;
        }
        resolve(behaviour === "answer" ? { kind: "answer", text: mapFor(place), model: MODEL } : { kind: "unavailable" });
      }),
  );
  return {
    held,
    release: (place: string) => {
      const i = held.findIndex((h) => h.place === place);
      expect(i).toBeGreaterThanOrEqual(0);
      held.splice(i, 1)[0].release({ kind: "answer", text: mapFor(place), model: MODEL });
    },
  };
}

function ui(model: string | null = MODEL): UiState {
  return setLocalModel(setRoot(EMPTY_STATE, root.path), model);
}

function render(state: UiState = ui(), startRoot = root): AppActions {
  let actions!: AppActions;
  const initial: AppInitial = {
    ui: setRoot(state, startRoot.path),
    root: startRoot,
    home: { listing: listing(), views: new Set(["defiance"]), git: new Map(), rootView: { exists: true, saved: null } },
    actions: (a) => {
      actions = a;
    },
  };
  renderToString(<App initial={initial} />);
  return actions;
}

const builds = (actions: AppActions) => Object.fromEntries([...actions.snapshot().builds].map(([k, v]) => [k, v.kind === "failed" ? `failed:${v.reason}` : v.kind]));
const collected = () => vi.mocked(collectInventory).mock.calls.map((c) => String(c[0]));
const written = () => vi.mocked(writeViewFiles).mock.calls.map((c) => ({ place: c[0], root: c[1], replace: c[4] }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.models.clear();
  vi.mocked(readFile).mockImplementation(async (path: string) => {
    const content = PLACE_FILES[path];
    if (content === undefined) throw `cannot read ${path}: No such file or directory (os error 2)`;
    return file(path, content);
  });
  vi.mocked(statFile).mockResolvedValue(null);
  vi.mocked(collectInventory).mockImplementation(async (place: string) => inventoryOf(place));
  // Home reads: the root listing, `views/<place>/map.svg` for each place, `.git` for each, and the root map,
  // which exists here so that only the place builds are queued (the root view has its own tests in App.root.test.tsx).
  vi.mocked(listDir).mockImplementation(async (rel: string) => (rel === "" ? ROOT_ENTRIES : []));
  vi.mocked(entryKind).mockImplementation(async (rel: string) => (rel === visualViewPath("defiance") || rel === rootViewPath() ? "file" : "none"));
});

describe("Refresh never builds", () => {
  it("with a model chosen in alabs, Refresh queues nothing, lists nothing, calls no model and writes nothing; the places open as usual", async () => {
    modelAnswers("answer");
    const actions = render();
    await actions.refresh();
    await tick();
    expect(builds(actions)).toEqual({});
    expect(collectInventory).not.toHaveBeenCalled();
    expect(generateLocalModelJson).not.toHaveBeenCalled();
    expect(writeViewFiles).not.toHaveBeenCalled();
    expect(actions.snapshot().views).toEqual(new Set(["defiance"]));
    await actions.enterPlace("cockpit");
    expect(actions.snapshot().activeKey).toBe("work:cockpit");
    await actions.openPath("cockpit/notes.txt");
    expect(fixture.models.has("/root/cockpit/notes.txt")).toBe(true);
  });

  it("with no model chosen the same holds, and a second Refresh changes nothing", async () => {
    modelAnswers("answer");
    const actions = render(ui(null));
    await actions.refresh();
    await tick();
    await actions.refresh();
    await tick();
    expect(builds(actions)).toEqual({});
    expect(generateLocalModelJson).not.toHaveBeenCalled();
    expect(collectInventory).not.toHaveBeenCalled();
  });
});

describe("Run Raven", () => {
  it("queues one place with Raven's model, one at a time, never twice; a place that has a map is replaced only after every check", async () => {
    const model = modelAnswers("hold");
    const actions = render(ui(null));
    actions.runRaven("cockpit");
    actions.runRaven("zed");
    actions.runRaven("cockpit");
    await tick();
    expect(builds(actions)).toEqual({ cockpit: "building", zed: "queued" });
    expect(collected()).toEqual(["cockpit"]);
    expect(vi.mocked(generateLocalModelJson)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateLocalModelJson).mock.calls[0][0]).toBe(RAVEN.model);
    model.release("cockpit");
    await tick();
    expect(builds(actions)).toEqual({ cockpit: "built", zed: "building" });
    model.release("zed");
    await tick();
    expect(builds(actions)).toEqual({ cockpit: "built", zed: "built" });
    expect(written()).toEqual([
      { place: "cockpit", root: "/root", replace: true },
      { place: "zed", root: "/root", replace: true },
    ]);
    expect(actions.snapshot().views).toEqual(new Set(["defiance", "cockpit", "zed"]));
    // The model chosen in alabs is not needed and not touched by a Raven run.
    expect(actions.snapshot().localModel).toBeNull();
    expect(logged()).toContain("view build: queued cockpit");
    expect(logged().some((l) => /^view build: done cockpit · \d+ s · 1 model call · 1 landmarks · 0 connections$/.test(l))).toBe(true);
    // A finished place may be run again: an explicit replace of the map it now has.
    modelAnswers("answer");
    actions.runRaven("defiance");
    await tick();
    expect(written()[2]).toEqual({ place: "defiance", root: "/root", replace: true });
    expect(builds(actions).defiance).toBe("built");
  });

  it("reaches the whole place through the app's own listing, search and read, one action per call, and cites what it saw", async () => {
    // The inventory of cockpit lists four files; the model lists src/, searches for boot, and reads a file the search found before mapping it.
    const answers = [
      '{"action": "list", "path": "src"}',
      '{"action": "search", "query": "boot"}',
      '{"action": "read", "path": "src/boot.js"}',
      JSON.stringify({
        version: 1,
        title: "Cockpit",
        summary: "An app.",
        groups: [{ id: "src", label: "Source", note: "" }],
        landmarks: [
          { id: "app", groupId: "src", label: "App", note: "", paths: ["src/app.js"] },
          { id: "boot", groupId: "src", label: "Boot", note: "", paths: ["src/boot.js"] },
        ],
        connections: [{ from: "app", to: "boot", label: "imports", evidence: [{ path: "src/app.js", kind: "import", anchor: "import { boot } from './boot.js';" }] }],
      }),
    ];
    const prompts: string[] = [];
    vi.mocked(generateLocalModelJson).mockImplementation(async (_model: string, _system: string, prompt: string) => {
      prompts.push(prompt);
      return { kind: "answer", text: answers.shift() ?? "{}", model: RAVEN.model };
    });
    vi.mocked(listDir).mockImplementation(async (rel: string) =>
      rel === "" ? ROOT_ENTRIES : Object.keys(PLACE_FILES).filter((p) => p.startsWith(`${rel}/`)).map((p) => ({ name: p.slice(rel.length + 1), rel_path: p, is_dir: false })),
    );
    vi.mocked(searchPlace).mockImplementation(async (query: string, scope: string) => ({
      results: Object.entries(PLACE_FILES)
        .filter(([p, text]) => p.startsWith(`${scope}/`) && text.includes(query))
        .map(([p, text]) => ({ name: p.split("/").pop() ?? p, rel_path: p, line: 1, text: text.split("\n")[0] })),
      summary: { files: 4, results: 2, truncated: false, cancelled: false },
    }));
    const actions = render(ui(null));
    actions.runRaven("cockpit");
    await tick(12);
    expect(builds(actions).cockpit).toBe("built");
    expect(prompts).toHaveLength(4);
    expect(vi.mocked(listDir).mock.calls.map((c) => c[0])).toContain("cockpit/src");
    expect(vi.mocked(searchPlace).mock.calls).toEqual([["boot", "cockpit", 1]]);
    expect(prompts[1]).toContain("=== LIST src (2 entries) ===\nsrc/app.js\nsrc/boot.js");
    expect(prompts[2]).toContain('=== SEARCH "boot" (2 hits in 4 files) ===\nsrc/app.js:1: import { boot } from \'./boot.js\';\nsrc/boot.js:1: export function boot() {}');
    expect(prompts[3]).toContain("=== FILE src/boot.js ===\nexport function boot() {}\n=== END src/boot.js ===");
    // Each call sees the notes so far, never the whole place at once: the last prompt holds exactly the files Raven was started with (README, notes) and asked for.
    expect(prompts[3].match(/=== FILE /g)).toHaveLength(3);
    expect(prompts[0]).not.toContain("=== FILE src/boot.js");
    // Every read stayed inside the place, and the map cites the file the search found.
    for (const [path] of vi.mocked(readFile).mock.calls) expect(String(path)).toMatch(/^cockpit\//);
    expect(JSON.parse(vi.mocked(writeViewFiles).mock.calls[0][2]).connections).toHaveLength(1);
    // Raven has no way to touch project files: the editor's writes, creates, moves and Trash were never called.
    for (const fn of [saveFile, recreateFile, createFile, createDir, moveItem, trashItem]) expect(fn).not.toHaveBeenCalled();
  });

  it("a run against a stopped local model fails by name, marks every waiting place, dials once, writes nothing, and every place stays usable", async () => {
    modelAnswers("unavailable");
    const actions = render(ui(null));
    actions.runRaven("cockpit");
    actions.runRaven("zed");
    await tick();
    expect(builds(actions)).toEqual({ cockpit: "failed:unavailable", zed: "failed:unavailable" });
    expect(generateLocalModelJson).toHaveBeenCalledTimes(1);
    expect(writeViewFiles).not.toHaveBeenCalled();
    expect(logged()).toContain("view build: failed cockpit · unavailable");
    expect(logged().join("\n")).not.toContain(RAVEN.model);
    await actions.enterPlace("zed");
    await actions.openPath("zed/README.md");
    expect(actions.snapshot().scopes["work:zed"].tabs.tabs.map((t) => t.relPath)).toEqual(["zed/README.md"]);
    await actions.enterPlace("defiance");
    expect(actions.snapshot().views.has("defiance")).toBe(true);
    // Refresh does not try again; another Run Raven may.
    await actions.refresh();
    await tick();
    expect(generateLocalModelJson).toHaveBeenCalledTimes(1);
    modelAnswers("answer");
    actions.runRaven("cockpit");
    await tick();
    expect(builds(actions).cockpit).toBe("built");
  });

  it("navigation never waits for a run", async () => {
    modelAnswers("hold");
    const actions = render();
    actions.runRaven("cockpit");
    await tick();
    expect(builds(actions).cockpit).toBe("building");
    await actions.enterPlace("cockpit");
    expect(actions.snapshot().activeKey).toBe("work:cockpit");
    await actions.openPath("cockpit/notes.txt");
    expect(fixture.models.has("/root/cockpit/notes.txt")).toBe(true);
    actions.goHome();
    expect(actions.snapshot().activeKey).toBe("home");
    await actions.enterPlace("defiance");
    await actions.openPath(visualViewPath("defiance"), null, "view");
    expect(actions.snapshot().scopes["work:defiance"].tabs.active).toBe(`view:${visualViewPath("defiance")}`);
    expect(builds(actions).cockpit).toBe("building");
  });

  it("success makes the view available with the smallest update: Home's view set and a reread of the place's open Visual View tab", async () => {
    const model = modelAnswers("hold");
    const actions = render();
    await actions.enterPlace("cockpit");
    await actions.openPath(visualViewPath("cockpit"), null, "view");
    actions.runRaven("cockpit");
    await tick();
    const before = actions.snapshot().scopes["work:cockpit"].surfaceReload;
    expect(actions.snapshot().views.has("cockpit")).toBe(false);
    model.release("cockpit");
    await tick();
    expect(actions.snapshot().views.has("cockpit")).toBe(true);
    expect(actions.snapshot().scopes["work:cockpit"].surfaceReload).toBe(before + 1);
    expect(actions.snapshot().scopes["work:cockpit"].tabs.active).toBe(`view:${visualViewPath("cockpit")}`);
  });

  it("the log names only the place, the category and the counts, never a prompt, a file, an answer or the model", async () => {
    modelAnswers("answer");
    const actions = render();
    actions.runRaven("cockpit");
    await tick();
    const lines = logged().filter((l) => l.startsWith("view build"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of logged()) {
      expect(line).not.toContain("=== ");
      expect(line).not.toContain("boot");
      expect(line).not.toContain("Cockpit");
      expect(line).not.toContain("version");
      expect(line).not.toContain(MODEL);
      expect(line).not.toContain(RAVEN.model);
    }
  });

  it("a root change forgets the queue and its states", async () => {
    modelAnswers("hold");
    const actions = render();
    actions.runRaven("cockpit");
    actions.runRaven("zed");
    await tick();
    expect(builds(actions)).toEqual({ cockpit: "building", zed: "queued" });
    vi.mocked(pickFolder).mockResolvedValue("/other");
    vi.mocked(openRoot).mockResolvedValue({ path: "/other", name: "other" });
    vi.mocked(listDir).mockImplementation(async () => []);
    await actions.changeRoot();
    await tick();
    expect(builds(actions)).toEqual({});
    expect(collected()).toEqual(["cockpit"]);
  });
});


describe("Raven root session regression with disposable real files", () => {
  it.each([false, true])("abandons delayed work on root change (return to A: %s)", async (backToA) => {
    const temp = mkdtempSync(`${tmpdir()}/alabs-raven-root-`);
    const a = `${temp}/a`, b = `${temp}/b`;
    for (const path of [a, b]) {
      mkdirSync(`${path}/cockpit`, { recursive: true });
      mkdirSync(`${path}/views/cockpit`, { recursive: true });
      writeFileSync(`${path}/cockpit/README.md`, `# Fixture ${path === a ? "A" : "B"}`);
      writeFileSync(`${path}/cockpit/later.txt`, `fixture ${path === a ? "A" : "B"} evidence`);
      writeFileSync(`${path}/views/cockpit/map.svg`, "old map");
      writeFileSync(`${path}/views/cockpit/view.json`, "old facts");
    }
    let selected = a;
    let release!: (value: LocalModelResult) => void;
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => { started = resolve; });
    const answer = new Promise<LocalModelResult>((resolve) => { release = resolve; });
    const reads: string[] = [];
    vi.mocked(readFile).mockImplementation(async (path) => {
      reads.push(`${selected}/${path}`);
      return file(path, readFileSync(`${selected}/${path}`, "utf8"));
    });
    vi.mocked(generateLocalModelJson).mockImplementationOnce(() => { started(); return answer; })
      .mockResolvedValue({ kind: "answer", model: MODEL, text: mapFor("cockpit") });
    vi.mocked(openRoot).mockImplementation(async (path) => { selected = path; return { path, name: "fixture" }; });
    vi.mocked(writeViewFiles).mockImplementation(async (place, expected, facts, svg) => {
      if (selected !== expected) throw "the alabs root changed";
      writeFileSync(`${selected}/views/${place}/view.json`, facts);
      writeFileSync(`${selected}/views/${place}/map.svg`, svg);
    });
    // Observe the real queue promise without replacing its implementation.
    const pump = vi.spyOn(ViewQueue.prototype as unknown as { pump(): Promise<void> }, "pump");
    try {
      const actions = render(undefined, { path: a, name: "fixture" });
      actions.runRaven("cockpit");
      const completed = pump.mock.results[0].value;
      await modelStarted;
      vi.mocked(pickFolder).mockResolvedValue(b);
      await actions.changeRoot();
      if (backToA) { vi.mocked(pickFolder).mockResolvedValue(a); await actions.changeRoot(); }
      const before = reads.length;
      release({ kind: "answer", model: MODEL, text: JSON.stringify({ action: "read", path: "later.txt" }) });
      await completed;
      expect.soft(reads.slice(before)).toEqual([]);
      expect.soft(generateLocalModelJson).toHaveBeenCalledTimes(1);
      expect.soft(writeViewFiles).not.toHaveBeenCalled();
      for (const path of [a, b]) {
        expect.soft(readFileSync(`${path}/views/cockpit/map.svg`, "utf8")).toBe("old map");
        expect.soft(readFileSync(`${path}/views/cockpit/view.json`, "utf8")).toBe("old facts");
      }
      expect(builds(actions)).toEqual({});
    } finally { pump.mockRestore(); rmSync(temp, { recursive: true, force: true }); }
  });
});

it.each(["unavailable", "not_installed", "timeout", "invalid"] as const)(
  "a %s Raven result preserves a dirty editor, saved view and explicit retry boundary",
  async (kind) => {
    const held = modelAnswers("hold");
    const actions = render(ui(null));
    await actions.enterPlace("defiance");
    await actions.openPath("defiance/first.txt", null, "editor");
    const model = fixture.models.get("/root/defiance/first.txt")!;
    model.setValue("unsaved work during Raven");
    actions.modelChanged();
    actions.runRaven("defiance");
    await vi.waitFor(() => expect(held.held).toHaveLength(1));
    actions.goHome();
    await actions.enterPlace("cockpit");
    await actions.openPath("cockpit/notes.txt");
    vi.mocked(generateLocalModelJson).mockResolvedValue({ kind: "answer", text: "not valid JSON", model: MODEL });
    held.held[0].release(kind === "invalid"
      ? { kind: "answer", text: "not valid JSON", model: MODEL }
      : kind === "not_installed" ? { kind, model: MODEL } : { kind });
    await vi.waitFor(() => expect(actions.snapshot().builds.get("defiance")?.kind).toBe("failed"));
    await actions.openVisualView("defiance");
    expect(actions.snapshot().views.has("defiance")).toBe(true);
    expect(model.content).toBe("unsaved work during Raven");
    expect(model.dispose).not.toHaveBeenCalled();
    expect(writeViewFiles).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    const calls = vi.mocked(generateLocalModelJson).mock.calls.length;
    await actions.refresh();
    expect(generateLocalModelJson).toHaveBeenCalledTimes(calls);
    expect(model.content).toBe("unsaved work during Raven");
    expect(logged().join("\n")).not.toContain("unsaved work during Raven");
    for (const [, system, prompt] of vi.mocked(generateLocalModelJson).mock.calls) {
      expect(system + prompt).not.toContain("unsaved work during Raven");
    }
  },
);
