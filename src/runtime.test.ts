import { beforeEach, describe, expect, it, vi } from "vitest";
import * as subject from "./subject";
import { bridge, host } from "./runtime";

// The wire contract. `subject.ts` is the only caller of the bridge, and
// every operation below names one Rust command and one argument shape. A
// second runtime (the browser transport) has to answer exactly these names
// with exactly these arguments, so they are pinned here rather than being
// re-read from whichever runtime a build happened to select.
vi.mock("./runtime", () => ({
  bridge: { invoke: vi.fn(async () => undefined), listen: vi.fn(async () => () => {}) },
  host: {
    pickFolder: vi.fn(async () => "/picked"),
    quit: vi.fn(async () => {}),
    onWindowClose: vi.fn(),
    onQuitRequested: vi.fn(),
    onCloseTabRequested: vi.fn(),
  },
}));

const invoke = vi.mocked(bridge.invoke);
const listen = vi.mocked(bridge.listen);

const stamp = { identity: "1:2", mtime_secs: 3, mtime_nanos: 4, len: 5 };

/** Every bridge operation: what it is called, and what it sends. */
const calls: Array<[string, () => unknown, string, Record<string, unknown>]> = [
  ["openRoot", () => subject.openRoot("/root"), "open_subject", { path: "/root" }],
  ["loadUiState", () => subject.loadUiState(), "load_ui_state", {}],
  ["saveUiState", () => subject.saveUiState("{}"), "save_ui_state", { text: "{}" }],
  ["appendLog", () => subject.appendLog("line"), "append_log", { text: "line" }],
  ["listDir", () => subject.listDir("a", 7), "list_dir", { relPath: "a", expectedSession: 7 }],
  ["entryKind", () => subject.entryKind("a"), "entry_kind", { relPath: "a" }],
  ["gitFacts", () => subject.gitFacts("p"), "git_facts", { place: "p" }],
  [
    "gitQuery",
    () => subject.gitQuery("p", { kind: "head" }),
    "git_query",
    { place: "p", query: { kind: "head" } },
  ],
  ["openTerminal", () => subject.openTerminal("p"), "open_terminal", { place: "p" }],
  ["listLocalModels", () => subject.listLocalModels(), "list_local_models", {}],
  [
    "askLocalModel",
    () => subject.askLocalModel("m", "s", "p", 7),
    "ask_local_model",
    { model: "m", system: "s", prompt: "p", expectedSession: 7 },
  ],
  [
    "generateLocalModelJson",
    () => subject.generateLocalModelJson("m", "s", "p", 7),
    "generate_local_model_json",
    { model: "m", system: "s", prompt: "p", expectedSession: 7 },
  ],
  [
    "collectInventory",
    () => subject.collectInventory("p", 7),
    "collect_inventory",
    { place: "p", expectedSession: 7 },
  ],
  [
    "writeViewFiles",
    () => subject.writeViewFiles("p", "/root", "{}", "<svg/>", true, 7),
    "write_view_files",
    { place: "p", expectedRoot: "/root", viewJson: "{}", mapSvg: "<svg/>", replace: true, expectedSession: 7 },
  ],
  [
    "writeRootViewFiles",
    () => subject.writeRootViewFiles("/root", "{}", "<svg/>", false, 7),
    "write_root_view_files",
    { expectedRoot: "/root", viewJson: "{}", mapSvg: "<svg/>", replace: false, expectedSession: 7 },
  ],
  ["readFile", () => subject.readFile("a", 7), "read_file", { relPath: "a", expectedSession: 7 }],
  ["statFile", () => subject.statFile("a"), "stat_file", { relPath: "a" }],
  [
    "saveFile",
    () => subject.saveFile("a", "text", stamp),
    "save_file",
    { relPath: "a", content: "text", expected: stamp },
  ],
  [
    "recreateFile",
    () => subject.recreateFile("a", "text"),
    "recreate_file",
    { relPath: "a", content: "text" },
  ],
  ["createFile", () => subject.createFile("p", "n"), "create_file", { parentRel: "p", name: "n" }],
  ["createDir", () => subject.createDir("p", "n"), "create_dir", { parentRel: "p", name: "n" }],
  [
    "moveItem",
    () => subject.moveItem("a", "b", "n", "s"),
    "move_item",
    { fromRel: "a", toParentRel: "b", newName: "n", scope: "s" },
  ],
  ["trashItem", () => subject.trashItem("a"), "trash_item", { relPath: "a" }],
  [
    "searchScope",
    () => subject.searchScope("q", 3, "s", 7),
    "search_subject",
    { query: "q", searchId: 3, scope: "s", expectedSession: 7 },
  ],
  ["cancelSearch", () => subject.cancelSearch(3), "cancel_search", { searchId: 3 }],
  ["viewSession", () => subject.viewSession("/root"), "view_session", { expectedRoot: "/root" }],
];

describe("the runtime bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue(undefined as never);
  });

  it.each(calls)("%s sends %s", (_name, run, command, args) => {
    void run();
    expect(invoke).toHaveBeenCalledTimes(1);
    const [sent, sentArgs] = invoke.mock.calls[0];
    expect(sent).toBe(command);
    expect(sentArgs ?? {}).toEqual(args);
  });

  it("covers every bridge operation exactly once", () => {
    const names = new Set(calls.map(([, , command]) => command));
    expect(names.size).toBe(calls.length);
  });

  it("streams search hits through one named event", async () => {
    const handler = vi.fn();
    await subject.onSearchResults(handler);
    expect(listen).toHaveBeenCalledWith("search-results", handler);
  });
});

describe("the host", () => {
  beforeEach(() => vi.clearAllMocks());

  // Picking a folder and exiting belong to the surrounding application, not
  // to the alabs root, so they must not reach the bridge at all.
  it("owns the folder picker", async () => {
    expect(await subject.pickFolder()).toBe("/picked");
    expect(host.pickFolder).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("owns exiting", async () => {
    await subject.quit();
    expect(host.quit).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("operations that never reject", () => {
  beforeEach(() => vi.clearAllMocks());

  // A bridge failure has to arrive as a value these callers already handle,
  // whatever the transport was. A rejection here would reach a caller that
  // has no branch for it.
  it.each([
    ["gitFacts", () => subject.gitFacts("p"), { kind: "error" }],
    ["gitQuery", () => subject.gitQuery("p", { kind: "head" }), { kind: "error" }],
    ["listLocalModels", () => subject.listLocalModels(), { kind: "failed" }],
    ["askLocalModel", () => subject.askLocalModel("m", "s", "p", 1), { kind: "failed" }],
    ["generateLocalModelJson", () => subject.generateLocalModelJson("m", "s", "p", 7), { kind: "failed" }],
  ])("%s turns a refusal into a value", async (_name, run, expected) => {
    invoke.mockRejectedValue(new Error("the bridge is gone"));
    await expect(run()).resolves.toMatchObject(expected);
  });
});
