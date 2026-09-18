// @ts-expect-error type error without @types/node package, as in vite.config.ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { askFailureText, buildAsk, INPUT_BUDGET_CHARS, isAskFile, QUESTION_MAX_CHARS, SYSTEM_INSTRUCTION, type AskIo } from "./localModel";
import type { Entry } from "./subject";

// The one input built for the local model, pure over injected reads: what
// enters (top-level text and Markdown files of the two folders, in order),
// what never can (work places, subfolders, other kinds, anything outside
// the root), the budget, the empty states and the exact prompt shape.

const dir = (relPath: string): Entry => ({ name: relPath.split("/").pop() ?? relPath, rel_path: relPath, is_dir: true });
const file = (relPath: string): Entry => ({ name: relPath.split("/").pop() ?? relPath, rel_path: relPath, is_dir: false });

/** A root with a work place, Context, Wiki and a stray root file; every read is recorded. */
function root(overrides: Partial<Record<string, Entry[]>> = {}, texts: Record<string, string> = {}) {
  const listings: Record<string, Entry[]> = {
    "": [dir("context"), dir("defiance"), dir("wiki"), file("README.md")],
    context: [file("context/current.md"), file("context/me.md"), file("context/photo.png"), file("context/.hidden.md"), dir("context/old")],
    wiki: [dir("wiki/archive"), file("wiki/notes.md"), file("wiki/todo.txt"), file("wiki/data.json")],
    defiance: [file("defiance/README.md"), file("defiance/secret.md")],
    "context/old": [file("context/old/past.md")],
    "wiki/archive": [file("wiki/archive/2020.md")],
    ...overrides,
  };
  const contents: Record<string, string> = {
    "context/current.md": "# Current\n\nBuilding alabs.\n\n",
    "context/me.md": "I am Danny. I live in Sydney.",
    "wiki/notes.md": "Ollama runs on port 11434.",
    "wiki/todo.txt": "buy milk",
    ...texts,
  };
  const io: AskIo = {
    listDir: vi.fn(async (relPath: string) => {
      const entries = listings[relPath];
      if (!entries) throw `path is outside the subject: ${relPath}`;
      return entries;
    }),
    readFile: vi.fn(async (relPath: string) => {
      const content = contents[relPath];
      if (content === undefined) throw `cannot read ${relPath}: No such file or directory (os error 2)`;
      return { content };
    }),
  };
  return { io, listDir: io.listDir as ReturnType<typeof vi.fn>, readFile: io.readFile as ReturnType<typeof vi.fn> };
}

const folders = { context: "context", wiki: "wiki" };

describe("what may enter the input", () => {
  it("only the top-level text and Markdown files of Context then Wiki, in listing order, and nothing else is listed or read", async () => {
    const r = root();
    const input = await buildAsk(r.io, folders, "Where do I live?");
    expect(input.kind).toBe("ready");
    if (input.kind !== "ready") return;
    expect(input.files.map((f) => f.relPath)).toEqual(["context/current.md", "context/me.md", "wiki/notes.md", "wiki/todo.txt"]);
    expect(r.listDir.mock.calls.map((c) => c[0])).toEqual(["context", "wiki"]);
    expect(r.readFile.mock.calls.map((c) => c[0])).toEqual(["context/current.md", "context/me.md", "wiki/notes.md", "wiki/todo.txt"]);
    // Neither the work place, the root, a subfolder, a picture, a JSON file nor a hidden file was touched.
    expect(input.prompt).not.toContain("defiance");
    expect(input.prompt).not.toContain("README");
    expect(input.prompt).not.toContain("old/");
    expect(input.prompt).not.toContain("archive");
    expect(input.prompt).not.toContain("photo.png");
    expect(input.prompt).not.toContain("data.json");
    expect(input.prompt).not.toContain(".hidden");
  });

  it("a folder name the listing resolved is what is listed, so a differently spelled Wiki folder still reads only itself", async () => {
    const r = root({ Wiki: [file("Wiki/a.md")] }, { "Wiki/a.md": "spelled" });
    const input = await buildAsk(r.io, { context: null, wiki: "Wiki" }, "q");
    expect(input.kind).toBe("ready");
    expect(r.listDir.mock.calls.map((c) => c[0])).toEqual(["Wiki"]);
    if (input.kind === "ready") expect(input.prompt).toContain("=== FILE Wiki/a.md ===\nspelled\n=== END Wiki/a.md ===");
  });

  it("a path that leaves the root or a work place cannot enter: the folders are the only paths asked for and a refused read fails the ask", async () => {
    const r = root({ wiki: [file("../outside.md"), file("wiki/notes.md")] });
    const input = await buildAsk(r.io, folders, "q");
    // The bridge refuses the escaping path by name; nothing is sent.
    expect(input).toEqual({ kind: "unreadable", relPath: "../outside.md", reason: "cannot read ../outside.md: No such file or directory (os error 2)" });
    expect(r.readFile).toHaveBeenCalledTimes(3);
    expect(r.listDir).not.toHaveBeenCalledWith("defiance");
    expect(r.listDir).not.toHaveBeenCalledWith("");
  });

  it("isAskFile: plain text and Markdown files only, never folders or hidden files, any letter case", () => {
    expect(isAskFile(file("wiki/a.md"))).toBe(true);
    expect(isAskFile(file("wiki/A.MD"))).toBe(true);
    expect(isAskFile(file("wiki/a.markdown"))).toBe(true);
    expect(isAskFile(file("wiki/a.txt"))).toBe(true);
    expect(isAskFile(file("wiki/a.json"))).toBe(false);
    expect(isAskFile(file("wiki/a.png"))).toBe(false);
    expect(isAskFile(file("wiki/a"))).toBe(false);
    expect(isAskFile(file("wiki/.a.md"))).toBe(false);
    expect(isAskFile(dir("wiki/a.md"))).toBe(false);
  });
});

describe("the prompt shape", () => {
  it("is the fixed instruction plus FILE and END markers with root-relative names, then the question, trailing whitespace trimmed", async () => {
    const input = await buildAsk(root().io, folders, "  Where do I live?  ");
    expect(input.kind).toBe("ready");
    if (input.kind !== "ready") return;
    expect(input.system).toBe(SYSTEM_INSTRUCTION);
    expect(input.prompt).toBe(
      [
        "=== FILE context/current.md ===\n# Current\n\nBuilding alabs.\n=== END context/current.md ===",
        "=== FILE context/me.md ===\nI am Danny. I live in Sydney.\n=== END context/me.md ===",
        "=== FILE wiki/notes.md ===\nOllama runs on port 11434.\n=== END wiki/notes.md ===",
        "=== FILE wiki/todo.txt ===\nbuy milk\n=== END wiki/todo.txt ===",
        "=== QUESTION ===\nWhere do I live?",
      ].join("\n\n"),
    );
    expect(input.chars).toBe("# Current\n\nBuilding alabs.\n\n".length + "I am Danny. I live in Sydney.".length + "Ollama runs on port 11434.".length + "buy milk".length);
  });

  it("the instruction says: answer from the material, say when it does not support an answer, invent nothing, stay concise", () => {
    expect(SYSTEM_INSTRUCTION).toContain("answer only from that material");
    expect(SYSTEM_INSTRUCTION).toContain("does not support an answer");
    expect(SYSTEM_INSTRUCTION).toContain("Never invent files, paths, names or facts");
    expect(SYSTEM_INSTRUCTION).toContain("concise");
  });
});

describe("the budget", () => {
  it("material exactly at the budget goes through; one character over fails before anything else is read", async () => {
    const big = "x".repeat(INPUT_BUDGET_CHARS - 8);
    const at = root({ wiki: [file("wiki/big.md"), file("wiki/todo.txt")] }, { "wiki/big.md": big });
    const ok = await buildAsk(at.io, { context: null, wiki: "wiki" }, "q");
    expect(ok.kind).toBe("ready");
    if (ok.kind === "ready") expect(ok.chars).toBe(INPUT_BUDGET_CHARS);

    const over = root({ wiki: [file("wiki/big.md"), file("wiki/todo.txt"), file("wiki/notes.md")] }, { "wiki/big.md": big + "y" });
    const result = await buildAsk(over.io, { context: null, wiki: "wiki" }, "q");
    expect(result).toEqual({ kind: "too_large", chars: INPUT_BUDGET_CHARS + 1, budget: INPUT_BUDGET_CHARS });
    expect(over.readFile.mock.calls.map((c) => c[0])).toEqual(["wiki/big.md", "wiki/todo.txt"]);
    expect(askFailureText(result as Exclude<typeof result, { kind: "ready" }>)).toBe(
      "Context and Wiki hold 24,001 characters, over the 24,000 the local model is given. Trim them, then ask again.",
    );
  });

  it("the question is bounded too and an empty one reads nothing", async () => {
    const r = root();
    expect(await buildAsk(r.io, folders, "   ")).toEqual({ kind: "bad_question", reason: "Type a question first." });
    expect(await buildAsk(r.io, folders, "q".repeat(QUESTION_MAX_CHARS + 1))).toEqual({ kind: "bad_question", reason: "Keep the question under 2,000 characters." });
    expect(r.listDir).not.toHaveBeenCalled();
    expect(r.readFile).not.toHaveBeenCalled();
    expect((await buildAsk(r.io, folders, "q".repeat(QUESTION_MAX_CHARS))).kind).toBe("ready");
  });
});

describe("the empty states", () => {
  it("empty Context (no folder, or no text files) still asks with the Wiki and says so in the prompt", async () => {
    const none = await buildAsk(root().io, { context: null, wiki: "wiki" }, "q");
    expect(none.kind).toBe("ready");
    if (none.kind === "ready") {
      expect(none.prompt.startsWith("=== NO CONTEXT FOLDER ===\n\n=== FILE wiki/notes.md ===")).toBe(true);
      expect(none.files.map((f) => f.relPath)).toEqual(["wiki/notes.md", "wiki/todo.txt"]);
    }
    const bare = await buildAsk(root({ context: [file("context/photo.png")] }).io, folders, "q");
    expect(bare.kind).toBe("ready");
    if (bare.kind === "ready") expect(bare.prompt.startsWith("=== context/ HAS NO TEXT FILES ===\n\n=== FILE wiki/notes.md ===")).toBe(true);
  });

  it("empty Wiki still asks with the Context", async () => {
    const input = await buildAsk(root({ wiki: [] }).io, folders, "q");
    expect(input.kind).toBe("ready");
    if (input.kind === "ready") {
      expect(input.files.map((f) => f.relPath)).toEqual(["context/current.md", "context/me.md"]);
      expect(input.prompt).toContain("=== END context/me.md ===\n\n=== wiki/ HAS NO TEXT FILES ===\n\n=== QUESTION ===");
    }
  });

  it("both empty asks with no material at all and zero characters", async () => {
    const input = await buildAsk(root().io, { context: null, wiki: null }, "Who am I?");
    expect(input).toEqual({
      kind: "ready",
      system: SYSTEM_INSTRUCTION,
      prompt: "=== NO CONTEXT FOLDER ===\n\n=== NO WIKI FOLDER ===\n\n=== QUESTION ===\nWho am I?",
      files: [],
      chars: 0,
    });
  });
});

describe("the sentences", () => {
  it("name each outcome without implementation words", () => {
    expect(askFailureText({ kind: "unavailable" })).toBe("Local model unavailable.");
    expect(askFailureText({ kind: "timeout" })).toBe("Local model took too long.");
    expect(askFailureText({ kind: "failed", reason: "model 'small:1b' not found" })).toBe("Local model request failed: model 'small:1b' not found.");
    expect(askFailureText({ kind: "unreadable", relPath: "wiki/a.md", reason: "cannot read wiki/a.md: Permission denied (os error 13)" })).toBe(
      "Could not read wiki/a.md: cannot read wiki/a.md: Permission denied.",
    );
    expect(askFailureText({ kind: "not_installed", model: "small:1b" })).toBe("small:1b is no longer installed. Choose a local model.");
    expect(askFailureText({ kind: "not_installed", model: "" })).toBe("Choose a local model.");
  });
});

describe("no model name is written into alabs application source", () => {
  it("the local-model implementation names no model: the installed list, and a creature's own file, are the only sources", () => {
    for (const file of [
      "src/localModel.ts",
      "src/creatures.ts",
      "src/AskLocalModel.tsx",
      "src/subject.ts",
      "src/App.tsx",
      "src/uiState.ts",
      "src/viewBuild.ts",
      "src/viewEvidence.ts",
      "src/viewMap.ts",
      "src/viewRender.ts",
      "src/VisualView.tsx",
      "src/Home.tsx",
      "src/RootView.tsx",
      "src/rootBuild.ts",
      "src/rootEvidence.ts",
      "src/rootMap.ts",
      "src/rootRender.ts",
      "src/launch.ts",
      "src-tauri/src/local_model.rs",
      "src-tauri/src/view_files.rs",
      "src-tauri/src/lib.rs",
    ]) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").toLowerCase();
      expect(source, file).not.toMatch(/\b(llama|gemma|qwen|mistral|deepseek)/);
      expect(source, file).not.toContain("local_model =");
      // No Ollama-style `name:tag` literal such as a `:3b` model tag.
      expect(source, file).not.toMatch(/["'`][a-z0-9._-]+:[0-9.]+b["'`]/);
    }
  });
});
