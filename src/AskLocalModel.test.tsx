// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { AskLocalModel, type AskBridge } from "./AskLocalModel";
import { OverviewSheetView, type OverviewSheetProps } from "./Overview";
import { appendLog, askLocalModel, createFile, listDir, listLocalModels, readFile, saveFile, saveUiState, viewSession } from "./subject";
import type { Entry, LocalModelResult, ModelListResult } from "./subject";
import type { AskFolders } from "./localModel";

// The ASK LOCAL MODEL section rendered for real in jsdom: nothing runs
// until the user acts, the model choice (listed only on request, never
// picked for the user, cleared when Ollama no longer lists it), the
// Thinking state, the answer, every named failure, what is never persisted
// and what is never logged, and the sheet around it staying usable. The
// input itself is tested in localModel.test.ts and the call in Rust
// (local_model_tests.rs).

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./subject", () => ({
  viewSession: vi.fn(async () => 17),
  listDir: vi.fn(async () => []),
  readFile: vi.fn(),
  askLocalModel: vi.fn(),
  listLocalModels: vi.fn(),
  appendLog: vi.fn(async () => {}),
  saveFile: vi.fn(),
  createFile: vi.fn(),
  saveUiState: vi.fn(),
  gitFacts: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;
const folders = { context: "context", wiki: "wiki" };
const file = (relPath: string): Entry => ({ name: relPath.split("/").pop() ?? relPath, rel_path: relPath, is_dir: false });
const material: Record<string, Entry[]> = { context: [file("context/me.md")], wiki: [file("wiki/notes.md")] };
const texts: Record<string, string> = { "context/me.md": "I live in Sydney.", "wiki/notes.md": "Ollama listens on 11434." };

type Bridge = {
  session: Mock<AskBridge["session"]>;
  listDir: Mock<AskBridge["listDir"]>;
  readFile: Mock<AskBridge["readFile"]>;
  listModels: Mock<AskBridge["listModels"]>;
  ask: Mock<AskBridge["ask"]>;
};

const installed = (...names: string[]): ModelListResult => ({ kind: "models", names });

/** A bridge over the fixture whose listing and ask are whatever the test decides. */
function bridge(ask: AskBridge["ask"], listModels: AskBridge["listModels"] = async () => installed("small:1b", "big:7b")): Bridge {
  return {
    session: vi.fn(async () => 17),
    listDir: vi.fn(async (relPath: string) => material[relPath] ?? []),
    readFile: vi.fn(async (relPath: string) => ({ content: texts[relPath] ?? "" })),
    listModels: vi.fn(listModels),
    ask: vi.fn(ask),
  };
}

const answer = (text: string, model = "small:1b"): LocalModelResult => ({ kind: "answer", text, model });
const never = () => new Promise<LocalModelResult>(() => {});
const onSelectModel = vi.fn<(name: string | null) => void>();

function render(b: AskBridge, model: string | null = "small:1b", locked = false, f: AskFolders = folders) {
  act(() => {
    root.render(<AskLocalModel rootPath="/root" folders={f} model={model} onSelectModel={onSelectModel} locked={locked} bridge={b} />);
  });
}

const text = () => container.textContent ?? "";
const box = () => container.querySelector("textarea") as HTMLTextAreaElement;
const select = () => container.querySelector("select") as HTMLSelectElement | null;
const button = (label: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLButtonElement;
const askChip = () => button("Ask");
const settle = () => act(async () => {});

function type(value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(box(), value);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function askNow(question: string) {
  type(question);
  await act(async () => {
    askChip().click();
  });
  await settle();
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
  await settle();
}

function choose(name: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select()!, name);
    select()!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const logged = () => vi.mocked(appendLog).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("leaving the root during material collection stops subsequent reads and inference", async () => {
  let release!: (entries: Entry[]) => void;
  const b = bridge(async () => answer("unused"));
  b.listDir.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  render(b);
  await askNow("Explain this synthetic material.");
  expect(b.listDir).toHaveBeenCalledTimes(1);
  act(() => root.render(null));
  await act(async () => release(material.context));
  expect(b.readFile).not.toHaveBeenCalled();
  expect(b.listDir).toHaveBeenCalledTimes(1);
  expect(b.ask).not.toHaveBeenCalled();
});

it("a late model failure from an abandoned root cannot clear the current model choice", async () => {
  let release!: (result: LocalModelResult) => void;
  const b = bridge(() => new Promise((resolve) => { release = resolve; }));
  render(b);
  await askNow("Explain this synthetic material.");
  expect(b.ask).toHaveBeenCalledTimes(1);
  act(() => root.render(null));
  await act(async () => release({ kind: "not_installed", model: "small:1b" }));
  expect(onSelectModel).not.toHaveBeenCalled();
});

it("a refused root session reads and sends no material", async () => {
  const b = bridge(async () => answer("unused"));
  b.session.mockRejectedValueOnce(new Error("the alabs root changed"));
  render(b);
  await askNow("Explain this synthetic material.");
  expect(text()).toContain("the alabs root changed");
  expect(b.listDir).not.toHaveBeenCalled();
  expect(b.readFile).not.toHaveBeenCalled();
  expect(b.ask).not.toHaveBeenCalled();
});

it("a late model discovery cannot clear a newer root's selection", async () => {
  let release!: (result: ModelListResult) => void;
  const b = bridge(never, () => new Promise((resolve) => { release = resolve; }));
  render(b);
  await click("change");
  act(() => root.render(null));
  await act(async () => release(installed("different:1b")));
  expect(onSelectModel).not.toHaveBeenCalled();
});

describe("choosing the local model", () => {
  it("with nothing chosen: a `Choose a local model…` link, Ask disabled even with a question, and nothing listed or called until the link is clicked", () => {
    const b = bridge(async () => answer("x"));
    render(b, null);
    expect(text()).toContain("Choose a local model…");
    expect(select()).toBeNull();
    type("Where do I live?");
    expect(askChip().disabled).toBe(true);
    expect(b.listModels).not.toHaveBeenCalled();
    expect(b.listDir).not.toHaveBeenCalled();
    expect(b.ask).not.toHaveBeenCalled();
  });

  it("the link lists what Ollama reports as installed, in its order, and shows `Choose a local model.` with nothing selected for the user", async () => {
    const b = bridge(async () => answer("x"));
    render(b, null);
    await click("Choose a local model…");
    expect(b.listModels).toHaveBeenCalledTimes(1);
    expect(select()).not.toBeNull();
    expect(Array.from(select()!.options).map((o) => [o.value, o.textContent, o.disabled])).toEqual([
      ["", "Choose a local model…", true],
      ["small:1b", "small:1b", false],
      ["big:7b", "big:7b", false],
    ]);
    expect(select()!.value).toBe("");
    expect(text()).toContain("Choose a local model.");
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(askChip().disabled).toBe(true);
  });

  it("a choice is handed up by name; with it remembered, Ask is enabled and uses exactly that model", async () => {
    const b = bridge(async () => answer("You live in Sydney.", "big:7b"));
    render(b, null);
    await click("Choose a local model…");
    choose("big:7b");
    expect(onSelectModel).toHaveBeenCalledWith("big:7b");
    // The parent remembers it and renders again with the choice.
    render(b, "big:7b");
    expect(select()!.value).toBe("big:7b");
    expect(text()).not.toContain("Choose a local model.");
    await askNow("Where do I live?");
    expect(b.ask).toHaveBeenCalledTimes(1);
    expect(b.ask.mock.calls[0][0]).toBe("big:7b");
    expect(text()).toContain("big:7b · 2 files read · not saved");
  });

  it("a remembered model shows by name with `change`, which lists again; a remembered name Ollama no longer lists is cleared", async () => {
    const b = bridge(async () => answer("x"), async () => installed("big:7b"));
    render(b, "small:1b");
    expect(text()).toContain("small:1b");
    expect(select()).toBeNull();
    expect(askChip().disabled).toBe(true);
    type("q");
    expect(askChip().disabled).toBe(false);
    await click("change");
    expect(b.listModels).toHaveBeenCalledTimes(1);
    expect(onSelectModel).toHaveBeenCalledWith(null);
    expect(Array.from(select()!.options).map((o) => o.value)).toEqual(["", "big:7b"]);
  });

  it("Ollama unavailable: `Local model unavailable.` with a retry link; no installed models: `No local models available.`; a broken list is named", async () => {
    const b = bridge(async () => answer("x"), async () => ({ kind: "unavailable" }));
    render(b, null);
    await click("Choose a local model…");
    expect(text()).toContain("Local model unavailable.");
    expect(select()).toBeNull();
    expect(askChip().disabled).toBe(true);
    b.listModels.mockResolvedValueOnce(installed());
    await click("retry");
    expect(text()).toContain("No local models available.");
    expect(select()).toBeNull();
    b.listModels.mockResolvedValueOnce({ kind: "failed", reason: "HTTP 500" });
    await click("retry");
    expect(text()).toContain("Local model request failed: HTTP 500.");
    b.listModels.mockResolvedValueOnce({ kind: "timeout" });
    await click("retry");
    expect(text()).toContain("Local model took too long.");
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(b.ask).not.toHaveBeenCalled();
  });

  it("Rust refusing the remembered model as not installed clears the selection and asks for another choice", async () => {
    const b = bridge(async () => ({ kind: "not_installed", model: "small:1b" }));
    render(b, "small:1b");
    await askNow("q");
    expect(onSelectModel).toHaveBeenCalledWith(null);
    expect(text()).toContain("small:1b is no longer installed. Choose a local model.");
    render(b, null);
    expect(text()).toContain("Choose a local model…");
    expect(askChip().disabled).toBe(true);
  });
});

describe("the ASK LOCAL MODEL section", () => {
  it("shows the box and a disabled Ask, and reads and calls nothing until Ask is pressed", () => {
    const b = bridge(async () => answer("x"));
    render(b);
    expect(text()).toContain("ASK LOCAL MODEL");
    expect(box().placeholder).toBe("What do I want to know?");
    expect(askChip().disabled).toBe(true);
    type("Where do I live?");
    expect(askChip().disabled).toBe(false);
    expect(b.listDir).not.toHaveBeenCalled();
    expect(b.readFile).not.toHaveBeenCalled();
    expect(b.listModels).not.toHaveBeenCalled();
    expect(b.ask).not.toHaveBeenCalled();
    expect(text()).not.toContain("Thinking");
  });

  it("Ask reads the two folders, sends the one input with the chosen model and shows the answer with the model, the file count and `not saved`", async () => {
    const b = bridge(async () => answer("You live in Sydney."));
    render(b);
    await askNow("Where do I live?");
    expect(b.ask).toHaveBeenCalledTimes(1);
    const [model, system, prompt] = b.ask.mock.calls[0];
    expect(model).toBe("small:1b");
    expect(system).toContain("answer only from that material");
    expect(prompt).toContain("=== FILE context/me.md ===\nI live in Sydney.");
    expect(prompt).toContain("=== FILE wiki/notes.md ===\nOllama listens on 11434.");
    expect(prompt.endsWith("=== QUESTION ===\nWhere do I live?")).toBe(true);
    expect(text()).toContain("ANSWER");
    expect(text()).toContain("You live in Sydney.");
    expect(text()).toContain("small:1b · 2 files read · not saved");
    expect(text()).not.toContain("Thinking");
    expect(askChip().disabled).toBe(false);
  });

  it("shows Thinking… with Ask disabled while the request runs, and the box stays editable", async () => {
    const b = bridge(never);
    render(b);
    await askNow("q");
    expect(text()).toContain("Thinking…");
    expect(askChip().disabled).toBe(true);
    expect(box().disabled).toBe(false);
    expect(b.ask).toHaveBeenCalledTimes(1);
  });

  it("unavailable, timeout, a refused request and an unreadable file each show their sentence and keep the section usable", async () => {
    const b = bridge(async () => ({ kind: "unavailable" }));
    render(b);
    await askNow("q");
    expect(text()).toContain("Local model unavailable.");
    expect(askChip().disabled).toBe(false);

    b.ask.mockResolvedValueOnce({ kind: "timeout" });
    await askNow("q");
    expect(text()).toContain("Local model took too long.");

    b.ask.mockResolvedValueOnce({ kind: "failed", reason: "HTTP 500" });
    await askNow("q");
    expect(text()).toContain("Local model request failed: HTTP 500.");
    expect(text()).not.toContain("ANSWER");

    b.readFile.mockRejectedValueOnce("cannot read wiki/notes.md: Permission denied (os error 13)");
    b.listDir.mockImplementation(async (relPath: string) => (relPath === "wiki" ? material.wiki : []));
    await askNow("q");
    expect(text()).toContain("Could not read wiki/notes.md: cannot read wiki/notes.md: Permission denied.");
    expect(b.ask).toHaveBeenCalledTimes(3);
  });

  it("a listing failure is a sentence, not a crash, and nothing is sent", async () => {
    const b = bridge(async () => answer("x"));
    b.listDir.mockRejectedValue("path is outside the subject: wiki (os error 2)");
    render(b);
    await askNow("q");
    expect(text()).toContain("Could not list the Context and Wiki files: path is outside the subject: wiki.");
    expect(b.ask).not.toHaveBeenCalled();
  });

  it("empty Context and Wiki still ask", async () => {
    const b = bridge(async () => answer("The local material does not cover that."));
    render(b, "small:1b", false, { context: null, wiki: "wiki" });
    b.listDir.mockResolvedValue([]);
    await askNow("What is my name?");
    const prompt = b.ask.mock.calls[0][2];
    expect(prompt).toBe("=== NO CONTEXT FOLDER ===\n\n=== wiki/ HAS NO TEXT FILES ===\n\n=== QUESTION ===\nWhat is my name?");
    expect(text()).toContain("small:1b · 0 files read · not saved");
  });

  it("a locked window disables the box, the chip and the choice", () => {
    render(bridge(async () => answer("x")), null, true);
    expect(box().disabled).toBe(true);
    expect(askChip().disabled).toBe(true);
    expect(button("Choose a local model…").disabled).toBe(true);
  });
});

describe("what never happens", () => {
  it("no prompt, question, answer or model list is written anywhere: no file, no layout state from here, no browser storage", async () => {
    const b = bridge(async () => answer("You live in Sydney."));
    render(b, null);
    await click("Choose a local model…");
    choose("small:1b");
    render(b, "small:1b");
    await askNow("Where do I live?");
    expect(text()).toContain("You live in Sydney.");
    expect(saveFile).not.toHaveBeenCalled();
    expect(createFile).not.toHaveBeenCalled();
    expect(saveUiState).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    // Only the name went up, for the parent to remember.
    expect(onSelectModel.mock.calls).toEqual([["small:1b"]]);
    // Unmounting drops the answer; nothing brings it back.
    act(() => root.unmount());
    root = createRoot(container);
    render(b, "small:1b");
    expect(text()).not.toContain("You live in Sydney.");
    expect(box().value).toBe("");
  });

  it("only the failure kind is logged, never the question, the material, the reason, the model list or the answer", async () => {
    const b = bridge(async () => answer("You live in Sydney."), async () => ({ kind: "unavailable" }));
    render(b);
    await askNow("Where do I live?");
    expect(logged()).toEqual([]);
    b.ask.mockResolvedValueOnce({ kind: "unavailable" });
    await askNow("Where do I live?");
    b.ask.mockResolvedValueOnce({ kind: "failed", reason: "model 'small:1b' not found" });
    await askNow("Where do I live?");
    b.ask.mockResolvedValueOnce({ kind: "timeout" });
    await askNow("Where do I live?");
    b.ask.mockResolvedValueOnce({ kind: "not_installed", model: "small:1b" });
    await askNow("Where do I live?");
    render(b, null);
    await click("Choose a local model…");
    b.listModels.mockResolvedValueOnce({ kind: "failed", reason: "HTTP 500" });
    await click("retry");
    expect(logged().map((l) => l.replace(/^\S+ /, ""))).toEqual([
      "warn local model: unavailable",
      "warn local model: failed",
      "warn local model: timeout",
      "warn local model: not_installed",
      "warn local model: unavailable",
      "warn local model list: failed",
    ]);
    for (const line of logged()) {
      expect(line).not.toContain("Where do I live");
      expect(line).not.toContain("Sydney");
      expect(line).not.toContain("11434");
      expect(line).not.toContain("not found");
      expect(line).not.toContain("small:1b");
      expect(line).not.toContain("HTTP 500");
    }
  });
});

describe("the Wiki Overview around it", () => {
  const dir = (name: string): Entry => ({ name, rel_path: `wiki/${name}`, is_dir: true });
  function renderSheet(ask: OverviewSheetProps["ask"], onOpenPath = vi.fn()) {
    const props: OverviewSheetProps = {
      sheet: { entries: [dir("archive"), file("wiki/notes.md")], readme: null, readAt: new Date(2026, 8, 15, 9, 0) },
      prefix: "wiki",
      isWork: false,
      locked: false,
      gitKind: "none",
      git: null,
      hasView: false,
      readmeDirty: false,
      onOpenPath,
      onOpenView: vi.fn(),
      onOpenTask: vi.fn(),
      onOpenChanges: vi.fn(),
      onOpenTerminal: vi.fn(),
      onRevealDir: vi.fn(),
      onRefresh: vi.fn(),
      onOpenTab: vi.fn(),
      ask,
    };
    act(() => {
      root.render(<OverviewSheetView {...props} />);
    });
    return onOpenPath;
  }

  it("shows the section only when the sheet is given the folders, under README and TOP LEVEL", () => {
    renderSheet(undefined);
    expect(text()).not.toContain("ASK LOCAL MODEL");
    renderSheet({ rootPath: "/root", folders, model: null, onSelectModel });
    expect(text().indexOf("TOP LEVEL")).toBeLessThan(text().indexOf("ASK LOCAL MODEL"));
  });

  it("the production bridge is the root-bounded one and the listing command, and the sheet's own rows still open files while the model is thinking", async () => {
    vi.mocked(listDir).mockImplementation(async (relPath: string) => material[relPath] ?? []);
    vi.mocked(readFile).mockImplementation(async (relPath: string) => ({ name: "", content: texts[relPath] ?? "", stamp: { identity: "1:2", mtime_secs: 0, mtime_nanos: 0, len: 1 } }));
    vi.mocked(listLocalModels).mockResolvedValue(installed("small:1b"));
    vi.mocked(askLocalModel).mockImplementation(never);
    const onOpenPath = renderSheet({ rootPath: "/root", folders, model: null, onSelectModel });
    await click("Choose a local model…");
    expect(listLocalModels).toHaveBeenCalledTimes(1);
    choose("small:1b");
    expect(onSelectModel).toHaveBeenCalledWith("small:1b");
    renderSheet({ rootPath: "/root", folders, model: "small:1b", onSelectModel }, onOpenPath);
    await askNow("q");
    expect(text()).toContain("Thinking…");
    expect(askLocalModel).toHaveBeenCalledTimes(1);
    expect(viewSession).toHaveBeenCalledWith("/root");
    expect(listDir).toHaveBeenCalledWith("context", 17);
    expect(readFile).toHaveBeenCalledWith("context/me.md", 17);
    expect(vi.mocked(askLocalModel).mock.calls[0][3]).toBe(17);
    expect(vi.mocked(askLocalModel).mock.calls[0][0]).toBe("small:1b");
    expect(vi.mocked(listDir).mock.calls.map((c) => c[0])).toEqual(["context", "wiki"]);
    const row = Array.from(container.querySelectorAll("tr.table-row")).find((r) => r.textContent?.includes("notes.md")) as HTMLElement;
    act(() => row.click());
    expect(onOpenPath).toHaveBeenCalledWith("wiki/notes.md");
  });
});
