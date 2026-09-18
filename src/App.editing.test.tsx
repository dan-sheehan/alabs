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
import { failed } from "./callFailure";
import { appendLog, entryKind, readFile, recreateFile, saveFile, statFile } from "./subject";
import type { Entry, FileContent, FileStamp } from "./subject";
import { classifyRoot, workKey } from "./places";
import { editorId } from "./tabs";
import type { Draft, DraftListing, DraftStore } from "./recovery";
import type { Editing, Writer } from "./runtime";
import { EMPTY_STATE, setRoot, type UiState } from "./uiState";

/**
 * Checkpoint 3 at the App level: one window edits and the others do not, every
 * edit becomes a kept draft, a save forgets exactly the revision it wrote, a
 * save that is never answered is reconciled against the disk rather than
 * retried, and unsaved work from before is offered for review without a single
 * byte being written to a file.
 *
 * Driven like the Step 3 to 6 tests: one server render with seeded state, then
 * the actions the shell hands out.
 */
interface Model {
  content: string;
  version: number;
  dispose: ReturnType<typeof vi.fn>;
  getAlternativeVersionId: () => number;
  getValue: () => string;
  setValue: (text: string) => void;
  getFullModelRange: () => string;
  pushEditOperations: (before: unknown[], edits: Array<{ text: string }>) => null;
}

const fixture = vi.hoisted(() => ({
  models: new Map<string, Model>(),
  foreign: [] as Array<{ uri: { scheme: string; path: string } }>,
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
        getFullModelRange: () => "whole",
        pushEditOperations: (_before, edits) => {
          model.content = edits[0].text;
          model.version += 1;
          return null;
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
      editing: null,
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
  moveItem: vi.fn(),
  quit: vi.fn(),
  recreateFile: vi.fn(),
  saveFile: vi.fn(),
  saveUiState: vi.fn(async () => {}),
  appendLog: vi.fn(async () => {}),
  trashItem: vi.fn(),
}));

const root = { path: "/root", name: "root" };
const FILE = "defiance/first.txt";
const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });
const stamp = (mtime = 0, ino = 2): FileStamp => ({ identity: `1:${ino}`, mtime_secs: mtime, mtime_nanos: 0, len: 9 });
const file = (relPath: string): FileContent => ({ name: relPath.split("/").pop() ?? relPath, content: "from disk", stamp: stamp() });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A draft store in memory, with the same refusals the real ones make. */
function memStore(kept = new Map<string, Draft>()) {
  const store: DraftStore = {
    async put(draft) {
      const had = kept.get(draft.relPath);
      if (had && had.revision > draft.revision) throw new Error(`a newer draft of ${draft.relPath} is already kept`);
      kept.set(draft.relPath, draft);
    },
    async list(): Promise<DraftListing> {
      return { drafts: [...kept.values()], unreadable: [] };
    },
    async drop(_root, relPath, revision) {
      const had = kept.get(relPath);
      if (had && had.revision > revision) throw new Error("newer draft kept");
      kept.delete(relPath);
    },
  };
  return { store, kept };
}

function draftOf(relPath: string, contents: string, revision = 1, stampOf: FileStamp | null = stamp()): Draft {
  return {
    root: root.path,
    relPath,
    stamp: stampOf,
    contents,
    revision,
    serverId: "server-one",
    sessionId: "an-earlier-window",
    updatedAt: 1_700_000_000_000,
  };
}

interface Seam {
  editing: Editing;
  browser: Map<string, Draft>;
  disk: Map<string, Draft>;
  claim: ReturnType<typeof vi.fn>;
}

function seam(answer: Writer = { writing: true, holder: "this-window" }, stores?: { browser?: Map<string, Draft>; disk?: Map<string, Draft> }): Seam {
  const browser = memStore(stores?.browser);
  const disk = memStore(stores?.disk);
  const claim = vi.fn(async (takeOver: boolean) => (takeOver ? { writing: true, holder: "this-window" } : answer));
  return {
    browser: browser.kept,
    disk: disk.kept,
    claim,
    editing: {
      sessionId: "this-window",
      browserDrafts: browser.store,
      diskDrafts: disk.store,
      claim,
      release: async () => ({ writing: false, holder: null }),
    },
  };
}

function render(editing: Editing | null, ui: UiState = setRoot(EMPTY_STATE, root.path)): AppActions {
  let actions!: AppActions;
  const initial: AppInitial = {
    ui,
    root,
    serverId: "server-one",
    editing,
    home: {
      listing: classifyRoot([dir("defiance"), dir("views"), dir("wiki")]),
      views: new Set(),
      git: new Map(),
      rootView: { exists: false, saved: null },
    },
    actions: (a) => {
      actions = a;
    },
  };
  renderToString(<App initial={initial} />);
  return actions;
}

/** Open the file and type into it, then let the draft be written. */
async function typeInto(actions: AppActions, text: string) {
  await actions.enterPlace("defiance");
  await actions.openPath(FILE, null, "editor");
  const model = fixture.models.get(`/root/${FILE}`)!;
  model.setValue(text);
  actions.modelChanged();
  await tick();
  actions.keepDraftNow(FILE);
  await tick();
  return model;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.models.clear();
  fixture.foreign = [];
  vi.mocked(readFile).mockImplementation(async (path) => file(path));
  vi.mocked(entryKind).mockResolvedValue("file");
  vi.mocked(statFile).mockResolvedValue(stamp());
  vi.mocked(saveFile).mockResolvedValue(stamp(5, 3));
  vi.mocked(recreateFile).mockResolvedValue(stamp(6, 4));
});

describe("one window edits", () => {
  it("asks for editing without ever disturbing a window that already has it", async () => {
    const s = seam({ writing: false, holder: "the-other-window" });
    const actions = render(s.editing);
    await actions.beginEditing();
    await tick();
    // The ask is never a takeover: a second tab must not quietly stop the
    // first one from saving.
    expect(s.claim).toHaveBeenCalledWith(false);
    expect(actions.snapshot().writing).toBe(false);
  });

  it("does not queue place or Home generation while another window holds editing", async () => {
    const s = seam({ writing: false, holder: "the-other-window" });
    const actions = render(s.editing);
    await actions.beginEditing();
    actions.runRaven("defiance");
    actions.runRavenRoot();
    await tick();
    expect(actions.snapshot().builds.size).toBe(0);
    expect(appendLog).toHaveBeenCalledWith(expect.stringContaining("refused: another window is editing"));
  });

  it("takes over only when the user says so", async () => {
    const s = seam({ writing: false, holder: "the-other-window" });
    const actions = render(s.editing);
    await actions.beginEditing();
    await tick();
    expect(actions.snapshot().writing).toBe(false);

    await actions.takeOverEditing(true);
    expect(s.claim).toHaveBeenLastCalledWith(true);
    expect(actions.snapshot().writing).toBe(true);
  });

  it("a window that has lost editing finds out when it tries to write, and stops claiming it can", async () => {
    const s = seam();
    const actions = render(s.editing);
    await actions.beginEditing();
    await tick();
    expect(actions.snapshot().writing).toBe(true);

    // The other window took over. This one only learns when the change is
    // refused where it runs, not when the button was clicked.
    vi.mocked(saveFile).mockRejectedValueOnce(failed("not-writing", "another alabs window is editing this root"));
    await typeInto(actions, "edited here");
    actions.saveActive();
    await tick();
    await tick();

    expect(actions.snapshot().writing).toBe(false);
    // And the unsaved text is still kept: losing the role never loses work.
    expect(s.disk.get(FILE)?.contents).toBe("edited here");
  });

  it("a runtime with no such rule is always the window that writes", async () => {
    const actions = render(null);
    await actions.beginEditing();
    expect(actions.snapshot().writing).toBe(true);
    expect(actions.snapshot().drafts.size).toBe(0);
  });
});

describe("what is typed is kept", () => {
  it("goes into both stores, and is acknowledged only once they have it", async () => {
    const s = seam();
    const actions = render(s.editing);
    await actions.beginEditing();
    await typeInto(actions, "unsaved work");

    const kept = actions.snapshot().drafts.get(FILE);
    expect(kept?.kept).toBe("disk");
    expect(kept?.trouble).toBeNull();
    expect(s.browser.get(FILE)?.contents).toBe("unsaved work");
    expect(s.disk.get(FILE)).toMatchObject({
      root: root.path,
      relPath: FILE,
      contents: "unsaved work",
      serverId: "server-one",
      sessionId: "this-window",
    });
  });

  it("is forgotten once the file holds it, and not a moment before", async () => {
    const s = seam();
    const actions = render(s.editing);
    await actions.beginEditing();
    await typeInto(actions, "about to be saved");
    expect(s.disk.has(FILE)).toBe(true);

    actions.saveActive();
    await tick();
    await tick();
    expect(vi.mocked(saveFile)).toHaveBeenCalledWith(FILE, "about to be saved", stamp());
    expect(s.disk.has(FILE)).toBe(false);
    expect(s.browser.has(FILE)).toBe(false);
    expect(actions.snapshot().drafts.size).toBe(0);
  });

  it("keeps the draft when the file was typed in again while the save ran", async () => {
    const s = seam();
    const actions = render(s.editing);
    await actions.beginEditing();
    const model = await typeInto(actions, "what gets saved");

    let release!: (stamp: FileStamp) => void;
    vi.mocked(saveFile).mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    actions.saveActive();
    await tick();
    // Typed while the save was on the disk.
    model.setValue("typed during the save");
    actions.modelChanged();
    await tick();
    actions.keepDraftNow(FILE);
    await tick();
    release(stamp(5, 3));
    await tick();
    await tick();

    // The save wrote the older text, so only that revision was dealt with.
    expect(s.disk.get(FILE)?.contents).toBe("typed during the save");
    expect(actions.snapshot().drafts.get(FILE)?.revision).toBeGreaterThan(1);
  });

  it("says so, and holds on to the text, when nowhere will keep it", async () => {
    const s = seam();
    const broken = (): DraftStore => ({
      put: () => Promise.reject(new Error("this browser will not keep drafts")),
      list: async () => ({ drafts: [], unreadable: [] }),
      drop: async () => {},
    });
    const actions = render({ ...s.editing, browserDrafts: broken(), diskDrafts: broken() });
    await actions.beginEditing();
    await typeInto(actions, "the only copy");

    const kept = actions.snapshot().drafts.get(FILE);
    expect(kept?.kept).toBe("pending");
    expect(kept?.trouble?.reason).toContain("will not keep drafts");
  });
});

describe("a save that is never answered", () => {
  /** Type something, then let the save disappear into silence. */
  async function silentSave(actions: AppActions) {
    await typeInto(actions, "edited here");
    vi.mocked(saveFile).mockRejectedValueOnce(failed("uncertain", "alabs is not answering"));
    actions.saveActive();
    await tick();
    await tick();
    await tick();
  }

  it("reads the disk back and, when the file is untouched, says the save never happened", async () => {
    const s = seam();
    const actions = render(s.editing);
    await actions.beginEditing();
    // The file is byte for byte what it was, and a save replaces it with a
    // new one, so it cannot have been written.
    vi.mocked(statFile).mockResolvedValue(stamp());
    await silentSave(actions);

    const tab = actions.snapshot().scopes[workKey("defiance")].tabs.tabs.find((t) => t.relPath === FILE);
    expect(tab?.kind === "loaded" && tab.disk).toBe("ok");
    // Not tried again, and the unsaved text is still unsaved and still kept.
    expect(vi.mocked(saveFile)).toHaveBeenCalledTimes(1);
    expect(s.disk.get(FILE)?.contents).toBe("edited here");
  });

  it("marks the tab uncertain, and writes nothing more, when the file has changed since", async () => {
    const s = seam();
    const actions = render(s.editing);
    await actions.beginEditing();
    // A different file is at that path now. It may be this save, it may not.
    vi.mocked(statFile).mockResolvedValue(stamp(9, 99));
    await silentSave(actions);

    const tab = actions.snapshot().scopes[workKey("defiance")].tabs.tabs.find((t) => t.relPath === FILE);
    expect(tab?.kind === "loaded" && tab.disk).toBe("uncertain");
    expect(vi.mocked(saveFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recreateFile)).not.toHaveBeenCalled();
    expect(s.disk.get(FILE)?.contents).toBe("edited here");
  });

  it("does not offer to recreate a file it cannot say it did not write", async () => {
    const s = seam();
    const actions = render(s.editing);
    await actions.beginEditing();
    vi.mocked(statFile).mockResolvedValue(null);
    await silentSave(actions);

    const tab = actions.snapshot().scopes[workKey("defiance")].tabs.tabs.find((t) => t.relPath === FILE);
    expect(tab?.kind === "loaded" && tab.disk).toBe("missing");
    expect(vi.mocked(recreateFile)).not.toHaveBeenCalled();
    expect(s.disk.get(FILE)?.contents).toBe("edited here");
  });

  it("stays uncertain when it cannot even read the disk back", async () => {
    const actions = render(seam().editing);
    await actions.beginEditing();
    vi.mocked(statFile).mockRejectedValue(failed("uncertain", "alabs is not answering"));
    await silentSave(actions);

    const tab = actions.snapshot().scopes[workKey("defiance")].tabs.tabs.find((t) => t.relPath === FILE);
    expect(tab?.kind === "loaded" && tab.disk).toBe("uncertain");
    expect(vi.mocked(saveFile)).toHaveBeenCalledTimes(1);
  });
});

describe("unsaved work from before", () => {
  it("is found, numbered above what was kept, and written nowhere until asked", async () => {
    const before = new Map([[FILE, draftOf(FILE, "kept from before", 12)]]);
    const s = seam(undefined, { disk: before });
    const actions = render(s.editing);
    await actions.beginEditing();
    await tick();

    expect(actions.snapshot().drafts.get(FILE)).toEqual({ revision: 12, kept: "disk", trouble: null });
    // Nothing was written to a file by finding it.
    expect(vi.mocked(saveFile)).not.toHaveBeenCalled();
    expect(vi.mocked(recreateFile)).not.toHaveBeenCalled();

    // The next edit continues above the restored revision, so it is not
    // refused as older than the draft it came from.
    await typeInto(actions, "edited after the restore");
    expect(s.disk.get(FILE)?.revision).toBe(13);
  });

  it("opens for review beside the file on disk, and still writes nothing", async () => {
    const before = new Map([[FILE, draftOf(FILE, "kept from before", 4)]]);
    const s = seam(undefined, { disk: before });
    const actions = render(s.editing);
    await actions.beginEditing();
    await tick();

    await actions.reviewDraft(draftOf(FILE, "kept from before", 4));
    await tick();

    const model = fixture.models.get(`/root/${FILE}`);
    expect(model?.getValue()).toBe("kept from before");
    const tab = actions.snapshot().scopes[workKey("defiance")].tabs.tabs.find((t) => t.relPath === FILE);
    expect(tab?.kind === "loaded" && tab.dirty).toBe(true);
    expect(vi.mocked(saveFile)).not.toHaveBeenCalled();
    // Still kept: reviewing is not saving.
    expect(s.disk.has(FILE)).toBe(true);
  });

  it("opens a draft whose file is gone as a missing tab, so saving asks before recreating", async () => {
    const gone = new Map([[FILE, draftOf(FILE, "the file went away", 2, null)]]);
    const s = seam(undefined, { disk: gone });
    const actions = render(s.editing);
    await actions.beginEditing();
    await tick();
    vi.mocked(entryKind).mockResolvedValue("none");

    await actions.reviewDraft(draftOf(FILE, "the file went away", 2, null));
    await tick();

    const tab = actions.snapshot().scopes[workKey("defiance")].tabs.tabs.find((t) => t.relPath === FILE);
    expect(tab?.kind === "loaded" && tab.disk).toBe("missing");
    expect(tab?.kind === "loaded" && tab.dirty).toBe(true);
    expect(fixture.models.get(`/root/${FILE}`)?.getValue()).toBe("the file went away");
    // Nothing was read and nothing was written to bring it back.
    expect(vi.mocked(readFile)).not.toHaveBeenCalledWith(FILE, expect.anything());
    expect(vi.mocked(recreateFile)).not.toHaveBeenCalled();
    expect(s.disk.has(FILE)).toBe(true);
  });

  it("goes only when the user throws it away", async () => {
    const before = new Map([[FILE, draftOf(FILE, "kept from before", 4)]]);
    const s = seam(undefined, { disk: before });
    const actions = render(s.editing);
    await actions.beginEditing();
    await tick();
    expect(s.disk.has(FILE)).toBe(true);

    actions.discardDraft(draftOf(FILE, "kept from before", 4));
    await tick();
    expect(s.disk.has(FILE)).toBe(false);
    expect(actions.snapshot().drafts.size).toBe(0);
  });

  it("takes the newer of the two stores, whichever it is", async () => {
    const s = seam(undefined, {
      browser: new Map([[FILE, draftOf(FILE, "the browser is ahead", 9)]]),
      disk: new Map([[FILE, draftOf(FILE, "the disk is behind", 4)]]),
    });
    const actions = render(s.editing);
    await actions.beginEditing();
    await tick();
    expect(actions.snapshot().drafts.get(FILE)?.revision).toBe(9);
    expect(actions.snapshot().drafts.get(FILE)?.kept).toBe("browser");

    await actions.reviewDraft(draftOf(FILE, "the browser is ahead", 9));
    await tick();
    expect(fixture.models.get(`/root/${FILE}`)?.getValue()).toBe("the browser is ahead");
  });
});

describe("editing is off while another window has it", () => {
  it("a change made anyway is refused where it runs, not merely hidden in the interface", async () => {
    const s = seam({ writing: false, holder: "the-other-window" });
    const actions = render(s.editing);
    await actions.beginEditing();
    await tick();
    expect(actions.snapshot().writing).toBe(false);

    vi.mocked(saveFile).mockRejectedValueOnce(failed("not-writing", "another alabs window is editing this root"));
    await typeInto(actions, "typed in a read-only window");
    actions.saveActive();
    await tick();
    await tick();

    // Refused, nothing written, and the text is still kept for this window.
    expect(actions.snapshot().writing).toBe(false);
    expect(s.disk.get(FILE)?.contents).toBe("typed in a read-only window");
  });
});

describe("the editor tab identity", () => {
  it("keeps drafts by path, so the same file is one draft wherever it is open", async () => {
    const s = seam();
    const actions = render(s.editing);
    await actions.beginEditing();
    await typeInto(actions, "one draft");
    expect([...s.disk.keys()]).toEqual([FILE]);
    expect(editorId(FILE)).toBe(`editor:${FILE}`);
  });
});
