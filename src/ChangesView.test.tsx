// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangesView, DIFF_SCHEME } from "./ChangesView";
import { appendLog, gitQuery, readFile } from "./subject";
import type { FileContent, GitQuery, GitQueryResult } from "./subject";
import type { Baseline } from "./uiState";

// The Changes tab surface (DESIGN.md 6.9) rendered for real in jsdom over a
// fake Git bridge and a fake Monaco: every mode enumerates from its own
// endpoints, the named states, the comparison sides, and the throwaway
// `alabs-git:` models that are created for a selection and disposed on the
// next selection, on the mode change and on unmount. `openPath` is App's;
// here the surface must call `onOpenPath` with the root-relative path.

interface FakeModel {
  uri: { scheme: string; path: string };
  text: string;
  language: string;
  disposed: boolean;
  dispose: () => void;
}

const fake = vi.hoisted(() => ({
  models: [] as FakeModel[],
  editors: [] as Array<{ setModel: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
  theme: "",
}));

vi.mock("monaco-editor", () => ({
  Uri: { from: (parts: { scheme: string; path: string }) => ({ scheme: parts.scheme, path: parts.path }) },
  editor: {
    setTheme: (name: string) => {
      fake.theme = name;
    },
    createModel: (text: string, language: string, uri: { scheme: string; path: string }) => {
      const model: FakeModel = {
        uri,
        text,
        language,
        disposed: false,
        dispose: () => {
          model.disposed = true;
        },
      };
      fake.models.push(model);
      return model;
    },
    createDiffEditor: () => {
      const editor = { setModel: vi.fn(), dispose: vi.fn() };
      fake.editors.push(editor);
      return editor;
    },
  },
}));
vi.mock("./subject", () => ({ gitQuery: vi.fn(), readFile: vi.fn(), appendLog: vi.fn(async () => {}) }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NUL = "\0";
const COMMIT = "a".repeat(40);
const clean: Baseline = { commit: COMMIT, at: 1_700_000_000_000, clean: true };
const dirty: Baseline = { ...clean, clean: false };
const handlers = { onOpenPath: vi.fn(), onOpenTab: vi.fn(), onRefresh: vi.fn() };
const disk = (content: string): FileContent => ({ name: "x", content, stamp: { identity: "1:1", mtime_secs: 0, mtime_nanos: 0, len: content.length } });

let container: HTMLDivElement;
let root: Root;

/** A fake repository: answers per query kind, blobs by `rev:path`. */
function repo(answers: Partial<Record<GitQuery["kind"], GitQueryResult>>, blobs: Record<string, GitQueryResult> = {}) {
  vi.mocked(gitQuery).mockImplementation(async (_place, query) => {
    if (query.kind === "blob") return blobs[`${query.rev}:${query.path}`] ?? { kind: "missing" };
    return answers[query.kind] ?? { kind: "failed", reason: `no answer for ${query.kind}` };
  });
}

interface Props {
  gitKind: "repo" | "linked" | "none";
  baseline: Baseline | null;
  taskStartedAt: number | null;
  reload: number;
  locked: boolean;
  dirtyPaths: Set<string>;
}

function render(props: Partial<Props> = {}) {
  const full: Props = { gitKind: "repo", baseline: null, taskStartedAt: null, reload: 0, locked: false, dirtyPaths: new Set(), ...props };
  act(() => {
    root.render(<ChangesView prefix="defiance" placeName="defiance" {...full} {...handlers} />);
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const text = () => container.textContent ?? "";
const rows = () => Array.from(container.querySelectorAll(".changes-file")) as HTMLElement[];
const rowTexts = () => rows().map((r) => (r.querySelector(".changes-row-text") as HTMLElement).textContent);
const chips = () => Array.from(container.querySelectorAll(".changes-header .chip")) as HTMLButtonElement[];
const chip = (label: string) => chips().find((c) => c.textContent === label) as HTMLButtonElement;
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const queries = () => vi.mocked(gitQuery).mock.calls.map((c) => c[1]);
const live = () => fake.models.filter((m) => !m.disposed);
const logged = () => vi.mocked(appendLog).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  fake.models = [];
  fake.editors = [];
  fake.theme = "";
  vi.mocked(readFile).mockImplementation(async (path) => disk(`disk ${path}\n`));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("modes and listings", () => {
  it("without a baseline: Not yet committed only, from the status listing, with changed, added, deleted, conflict, untracked and nested rows; Reading… first; as of after", async () => {
    repo({ status: { kind: "files", text: [` M src/ingest.py`, `A  src/new.py`, ` D old.py`, `UU x.py`, `?? sp ace/ünï "q".txt`, `?? sub/`].join(NUL) + NUL } });
    render();
    expect(text()).toContain("Reading changes…");
    await settle();
    expect(chips().map((c) => c.textContent)).toEqual(["Not yet committed"]);
    expect(queries()).toEqual([{ kind: "status" }]);
    expect(rowTexts()).toEqual([
      "changed · src/ingest.py",
      "added · src/new.py",
      "deleted · old.py",
      "conflict · x.py",
      'added · sp ace/ünï "q".txt',
      "nested repository · sub/",
    ]);
    expect(text()).toMatch(/as of \d+:\d\d [ap]m · Refresh/);
    expect(text()).toContain("Select a file to see what changed.");
    expect(text()).toContain("Last commit");
    expect(text()).toContain("On disk");
    expect(text()).not.toContain("Task started");
  });

  it("a clean baseline offers Since task started first, from the baseline diff plus untracked files, then Not yet committed from status", async () => {
    repo({
      since: { kind: "since", diff: `M${NUL}a.txt${NUL}D${NUL}old.txt${NUL}`, untracked: `b.txt${NUL}` },
      status: { kind: "files", text: ` M a.txt${NUL}` },
    });
    render({ baseline: clean });
    await settle();
    expect(chips().map((c) => c.textContent)).toEqual(["Since task started", "Not yet committed"]);
    expect(chip("Since task started").getAttribute("aria-pressed")).toBe("true");
    expect(queries()).toEqual([{ kind: "since", baseline: COMMIT }]);
    expect(rowTexts()).toEqual(["changed · a.txt", "added · b.txt", "deleted · old.txt"]);
    expect(text()).toContain("Task start");
    expect(text()).not.toContain("Task started with existing changes");
    click(chip("Not yet committed"));
    await settle();
    expect(rowTexts()).toEqual(["changed · a.txt"]);
    expect(queries()[queries().length - 1]).toEqual({ kind: "status" });
    expect(text()).toContain("Last commit");
  });

  it("a dirty baseline offers Commits since task started and Not yet committed separately with the sentence, never Since task started", async () => {
    repo({
      committed: { kind: "files", text: `M${NUL}a.txt${NUL}` },
      status: { kind: "files", text: ` M a.txt${NUL}?? b.txt${NUL}` },
    });
    render({ baseline: dirty });
    await settle();
    expect(chips().map((c) => c.textContent)).toEqual(["Commits since task started", "Not yet committed"]);
    expect(text()).toContain("Task started with existing changes. alabs cannot separate earlier edits from changes made after the handoff.");
    expect(chip("Not yet committed").getAttribute("aria-pressed")).toBe("true");
    expect(rowTexts()).toEqual(["changed · a.txt", "added · b.txt"]);
    click(chip("Commits since task started"));
    await settle();
    expect(queries()[queries().length - 1]).toEqual({ kind: "committed", baseline: COMMIT });
    expect(rowTexts()).toEqual(["changed · a.txt"]);
    expect(text()).toContain("Task start");
    expect(text()).toContain("Last commit");
    expect(text()).not.toContain("On disk");
  });

  it("a baseline that no longer exists is named and Not yet committed takes over", async () => {
    repo({ since: { kind: "baseline_missing" }, status: { kind: "files", text: "" } });
    render({ baseline: clean });
    await settle();
    expect(text()).toContain("Task start is no longer available.");
    expect(chips().map((c) => c.textContent)).toEqual(["Not yet committed"]);
    expect(queries()).toEqual([{ kind: "since", baseline: COMMIT }, { kind: "status" }]);
    expect(text()).toContain("No changed files.");
    expect(logged().some((l) => l.includes("no longer exists"))).toBe(true);
  });

  it("empty listings read per mode; the task-started cue replaces the readout; Refresh re-reads", async () => {
    repo({ since: { kind: "since", diff: "", untracked: "" }, status: { kind: "files", text: "" } });
    render({ baseline: clean, taskStartedAt: new Date(2026, 8, 15, 15, 42).getTime() });
    await settle();
    expect(text()).toContain("Nothing has changed since the task started.");
    expect(text()).toContain("Task started 3:42 pm · press Refresh when the tool is done");
    expect(text()).not.toContain("as of");
    render({ baseline: clean, taskStartedAt: null, reload: 1 });
    await settle();
    expect(queries()).toHaveLength(2);
    expect(text()).toContain("as of");
    click(container.querySelector(".changes-header .navlink") as Element);
    expect(handlers.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("a plain folder, a linked .git and every Git failure show their sentence and run nothing further", async () => {
    render({ gitKind: "none" });
    expect(text()).toContain("This folder is not a Git repository. Open tabs still show a mark when a file changed on disk.");
    expect(gitQuery).not.toHaveBeenCalled();
    render({ gitKind: "linked" });
    expect(text()).toContain("Linked Git directory · not supported yet");
    expect(gitQuery).not.toHaveBeenCalled();
    for (const [answer, sentence] of [
      [{ kind: "unavailable" }, "Git is unavailable on this Mac."],
      [{ kind: "timeout" }, "Git took too long."],
      [{ kind: "too_large" }, "Git returned too much to show."],
      [{ kind: "refused", reason: ".git/info/attributes is present" }, "Git could not read this folder: .git/info/attributes is present"],
      [{ kind: "error", reason: "cannot access defiance: No such file or directory (os error 2)" }, "Git could not read this folder: cannot access defiance: No such file or directory"],
    ] as Array<[GitQueryResult, string]>) {
      repo({ status: answer });
      render({ gitKind: "repo", reload: Math.random() });
      await settle();
      expect(text()).toContain(sentence);
      expect(rows()).toHaveLength(0);
    }
  });
});

describe("the comparison", () => {
  it("selecting a changed file compares the last commit with the disk in throwaway alabs-git models, never a file model; a new selection disposes the old pair", async () => {
    repo({ status: { kind: "files", text: ` M a.py${NUL} M b.py${NUL}` } }, { "HEAD:a.py": { kind: "blob", text: "old a\n" }, "HEAD:b.py": { kind: "blob", text: "old b\n" } });
    render();
    await settle();
    click(rows()[0]);
    expect(text()).toContain("Reading changes…");
    await settle();
    expect(readFile).toHaveBeenCalledWith("defiance/a.py");
    expect(live().map((m) => [m.uri.scheme, m.text, m.language])).toEqual([
      [DIFF_SCHEME, "old a\n", "python"],
      [DIFF_SCHEME, "disk defiance/a.py\n", "python"],
    ]);
    expect(live().every((m) => m.uri.scheme !== "file")).toBe(true);
    expect(fake.editors).toHaveLength(1);
    expect(fake.editors[0].setModel).toHaveBeenLastCalledWith({ original: live()[0], modified: live()[1] });
    expect(fake.theme).toBe("vs-dark");
    expect(rows()[0].className).toContain("changes-selected");
    click(rows()[1]);
    await settle();
    expect(fake.models.filter((m) => m.disposed)).toHaveLength(2);
    expect(live().map((m) => m.text)).toEqual(["old b\n", "disk defiance/b.py\n"]);
    // Every model this surface made lives under the throwaway scheme.
    expect(fake.models.every((m) => m.uri.scheme === DIFF_SCHEME)).toBe(true);
  });

  it("added is empty against the disk; deleted says the file no longer exists; binary says no comparison; nested has no comparison", async () => {
    repo(
      { status: { kind: "files", text: `A  n.py${NUL} D gone.py${NUL} M bin.dat${NUL}?? sub/${NUL}` } },
      { "HEAD:gone.py": { kind: "blob", text: "was here\n" }, "HEAD:bin.dat": { kind: "binary" } },
    );
    render();
    await settle();
    click(rows()[0]);
    await settle();
    expect(queries().some((q) => q.kind === "blob" && q.path === "n.py")).toBe(false);
    expect(live().map((m) => m.text)).toEqual(["", "disk defiance/n.py\n"]);
    click(rows()[1]);
    await settle();
    expect(text()).toContain("File no longer exists.");
    expect(readFile).not.toHaveBeenCalledWith("defiance/gone.py");
    expect(live().map((m) => m.text)).toEqual(["was here\n", ""]);
    click(rows()[2]);
    await settle();
    expect(text()).toContain("Not a text file, so no comparison.");
    expect(live()).toHaveLength(0);
    click(rows()[3]);
    await settle();
    expect(text()).toContain("nested repository · sub/");
    expect(live()).toHaveLength(0);
    expect(rows()[3].querySelector(".changes-open")).toBeNull();
  });

  it("a binary or missing disk file, a missing revision side, and the committed mode's HEAD side", async () => {
    repo(
      { status: { kind: "files", text: ` M pic.png${NUL} M a.py${NUL}` }, committed: { kind: "files", text: `M${NUL}a.py${NUL}` } },
      { "HEAD:pic.png": { kind: "blob", text: "" }, "HEAD:a.py": { kind: "blob", text: "now\n" }, [`${COMMIT}:a.py`]: { kind: "blob", text: "then\n" } },
    );
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (path.endsWith("pic.png")) throw new Error("not a UTF-8 text file: defiance/pic.png");
      return disk(`disk ${path}\n`);
    });
    render();
    await settle();
    click(rows()[0]);
    await settle();
    expect(text()).toContain("Not a text file, so no comparison.");
    // A disk file that reads as UTF-8 but holds a NUL byte is binary too.
    vi.mocked(readFile).mockImplementation(async (path) => disk(`\0\x01 ${path}`));
    click(rows()[1]);
    await settle();
    expect(text()).toContain("Not a text file, so no comparison.");
    expect(live()).toHaveLength(0);
    vi.mocked(readFile).mockImplementation(async (path) => disk(`disk ${path}\n`));
    render({ baseline: dirty });
    await settle();
    // The baseline change re-read the still-selected row once before the selection cleared; from here on nothing may read the disk.
    vi.mocked(readFile).mockClear();
    click(chip("Commits since task started"));
    await settle();
    click(rows()[0]);
    await settle();
    // The committed mode never reads the disk: both sides come from the repository.
    expect(readFile).not.toHaveBeenCalledWith("defiance/a.py");
    expect(live().map((m) => m.text)).toEqual(["then\n", "now\n"]);
    expect(queries().filter((q) => q.kind === "blob")).toEqual(
      expect.arrayContaining([
        { kind: "blob", rev: COMMIT, path: "a.py" },
        { kind: "blob", rev: "HEAD", path: "a.py" },
      ]),
    );
  });

  it("a dirty Editor tab for the selected path is noted with Open tab; the comparison still reads the disk, never the buffer", async () => {
    repo({ status: { kind: "files", text: ` M a.py${NUL}` } }, { "HEAD:a.py": { kind: "blob", text: "old\n" } });
    render({ dirtyPaths: new Set(["defiance/a.py"]) });
    await settle();
    expect(text()).not.toContain("Unsaved edits exist");
    click(rows()[0]);
    await settle();
    expect(text()).toContain("Unsaved edits exist in the editor. This comparison shows the saved file on disk.");
    expect(readFile).toHaveBeenCalledWith("defiance/a.py");
    expect(live()[1].text).toBe("disk defiance/a.py\n");
    click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Open tab") as Element);
    expect(handlers.onOpenTab).toHaveBeenCalledWith("defiance/a.py");
  });

  it("open → hands the root-relative path to the shared open-path handler without selecting; deleted rows have no open action", async () => {
    repo({ status: { kind: "files", text: ` M src/a.py${NUL} D gone.py${NUL}` } });
    render();
    await settle();
    click(rows()[0].querySelector(".changes-open") as Element);
    expect(handlers.onOpenPath).toHaveBeenCalledWith("defiance/src/a.py");
    expect(rows()[0].className).not.toContain("changes-selected");
    expect(rows()[1].querySelector(".changes-open")).toBeNull();
  });

  it("unmounting disposes the diff editor and every model; a listing change that drops the selected row clears the comparison", async () => {
    repo({ status: { kind: "files", text: ` M a.py${NUL}` } }, { "HEAD:a.py": { kind: "blob", text: "old\n" } });
    render();
    await settle();
    click(rows()[0]);
    await settle();
    expect(live()).toHaveLength(2);
    repo({ status: { kind: "files", text: "" } });
    render({ reload: 1 });
    await settle();
    expect(text()).toContain("No changed files.");
    expect(text()).toContain("Select a file to see what changed.");
    expect(live()).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(container);
    expect(fake.editors[0].dispose).toHaveBeenCalledTimes(1);
    expect(fake.models.every((m) => m.disposed)).toBe(true);
  });
});

describe("stale comparisons and keyboard ownership", () => {
  it.each(["Enter", " "])("%s on open activates only the file action, not its comparison row", async (key) => {
    repo({ status: { kind: "files", text: ` M a.py${NUL}` } });
    render();
    await settle();
    const open = rows()[0].querySelector("button")!;
    open.focus();
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => open.dispatchEvent(event));
    // jsdom does not synthesize a native button click from a key.
    expect(event.defaultPrevented).toBe(false);
    click(open);
    await settle();
    expect(handlers.onOpenPath).toHaveBeenCalledExactlyOnceWith("defiance/a.py");
    expect(rows()[0].getAttribute("aria-selected")).toBe("false");
    expect(readFile).not.toHaveBeenCalled();
    expect(live()).toHaveLength(0);
    act(() => rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    await settle();
    expect(rows()[0].getAttribute("aria-selected")).toBe("true");
    expect(readFile).toHaveBeenCalledExactlyOnceWith("defiance/a.py");
  });

  it("late disk content from a previous selection cannot replace the current comparison", async () => {
    repo({ status: { kind: "files", text: ` M a.py${NUL} M b.py${NUL}` } }, {
      "HEAD:a.py": { kind: "blob", text: "old a" }, "HEAD:b.py": { kind: "blob", text: "old b" },
    });
    let finish!: (value: FileContent) => void;
    vi.mocked(readFile).mockImplementation((path) => path.endsWith("a.py")
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(disk("current b")));
    render();
    await settle();
    click(rows()[0]);
    await settle();
    click(rows()[1]);
    await settle();
    expect(live().map((m) => m.text)).toEqual(["old b", "current b"]);
    await act(async () => finish(disk("stale a")));
    expect(live().map((m) => m.text)).toEqual(["old b", "current b"]);
    expect(rows()[1].getAttribute("aria-selected")).toBe("true");
  });

  it("an older status reply cannot resurrect rows removed by Refresh", async () => {
    let finish!: (value: GitQueryResult) => void;
    vi.mocked(gitQuery).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render();
    repo({ status: { kind: "files", text: "" } });
    render({ reload: 1 });
    await settle();
    await act(async () => finish({ kind: "files", text: ` M stale.py${NUL}` }));
    expect(rows()).toHaveLength(0);
    expect(text()).toContain("No changed files.");
  });
});
