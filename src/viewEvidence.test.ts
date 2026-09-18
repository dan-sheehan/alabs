import { describe, expect, it, vi } from "vitest";
import {
  alwaysFirst,
  candidates,
  fileExcerpt,
  inventoryText,
  isPrivateEnvFile,
  isTextFile,
  listText,
  MAP_INSTRUCTION,
  MAX_ACTIONS,
  MAX_EVIDENCE_CHARS,
  MAX_FILE_CHARS,
  MAX_INVENTORY_CHARS,
  MAX_LIST_LINES,
  MAX_QUERY_CHARS,
  MAX_READ_BYTES,
  MAX_SEARCH_HITS,
  MAX_STARTER_FILES,
  noteText,
  packetHead,
  parseAction,
  placePath,
  readPacket,
  searchText,
  stepPrompt,
  tierOf,
} from "./viewEvidence";
import type { Entry, Inventory, InventoryEntry, SearchResult } from "./subject";

// Raven's evidence: which files start a run and in what order, how the
// inventory, each excerpt, a listing and a search are shown, the fixed
// bounds, how a model answer is read as one action or the map, and that a
// path the model names can never leave the place.

const f = (path: string, size = 100): InventoryEntry => ({ path, is_dir: false, size });
const d = (path: string): InventoryEntry => ({ path, is_dir: true, size: 0 });

function inventory(entries: InventoryEntry[], truncated = false): Inventory {
  return { entries, truncated, files: entries.filter((e) => !e.is_dir).length, folders: entries.filter((e) => e.is_dir).length };
}

const SAMPLE = inventory([
  f("README.md"),
  f("package.json"),
  f("package-lock.json", 50_000),
  f("image.png"),
  f("empty.md", 0),
  d("src"),
  d("docs"),
  d("tests"),
  d(".github"),
  d("config"),
  d("data"),
  f("src/index.ts"),
  f("src/util.ts"),
  f("src/util.test.ts"),
  f("docs/guide.md"),
  f("tests/test_all.py"),
  f(".github/workflows/ci.yml"),
  f("config/app.toml"),
  f("data/big.csv", MAX_READ_BYTES + 1),
  f("data/rows.csv", 200),
]);

describe("what may be read", () => {
  it("only text files by name; never pictures, lock files, empty or oversized files, or folders", () => {
    expect(candidates(SAMPLE).map((c) => c.path)).toEqual([
      "README.md",
      "docs/guide.md",
      "package.json",
      "config/app.toml",
      ".github/workflows/ci.yml",
      "src/index.ts",
      "src/util.ts",
      "src/util.test.ts",
      "tests/test_all.py",
      "data/rows.csv",
    ]);
    expect(isTextFile("photo.JPG")).toBe(false);
    expect(isTextFile("corpus.sqlite")).toBe(false);
    expect(isTextFile("uv.lock")).toBe(false);
    expect(isTextFile("Makefile")).toBe(true);
    expect(isTextFile("LICENSE")).toBe(true);
    expect(isTextFile("src/x.py")).toBe(true);
    expect(isTextFile("archive.tar.gz")).toBe(false);
  });

  it("a private environment file is never readable, by name, at any depth; ordinary files stay eligible", () => {
    for (const p of [".env", ".env.local", ".env.production", ".env.example", ".ENV", "config/.env", "apps/web/.env.development.local", "production.env", "local.env", "PRODUCTION.ENV", "deploy/secrets.env"]) {
      expect(isPrivateEnvFile(p), p).toBe(true);
      expect(isTextFile(p), p).toBe(false);
    }
    for (const p of ["env.ts", "environment.md", "src/env.py", "env.json", "dotenv.rs", "config/app.toml", "settings.json", ".gitignore", ".editorconfig", "README.md"]) {
      expect(isPrivateEnvFile(p), p).toBe(false);
      expect(isTextFile(p), p).toBe(true);
    }
    const withEnv = inventory([f("README.md"), f(".env"), f(".env.local"), f("local.env"), f("config/.env"), f("config/app.toml"), f("src/env.ts")]);
    expect(candidates(withEnv).map((c) => c.path)).toEqual(["README.md", "config/app.toml", "src/env.ts"]);
    // The listing still names it: the model may know the file exists, never what it holds.
    expect(inventoryText(withEnv)).toContain(".env (100 bytes)");
    expect(inventoryText(withEnv)).toContain("local.env (100 bytes)");
  });

  it("tiers: docs, manifest, config, entry, source, test", () => {
    expect(tierOf("README.md")).toBe("docs");
    expect(tierOf("docs/deep/guide.md")).toBe("docs");
    expect(tierOf("src/notes.md")).toBe("docs");
    expect(tierOf("src/deep/notes.md")).toBe("other");
    expect(tierOf("pyproject.toml")).toBe("manifest");
    expect(tierOf("Cargo.toml")).toBe("manifest");
    expect(tierOf("railway.json")).toBe("config");
    expect(tierOf("tsconfig.json")).toBe("config");
    expect(tierOf("config/app.toml")).toBe("config");
    expect(tierOf("config/2017/corpus.json")).toBe("other");
    expect(tierOf("src/aliases.json")).toBe("other");
    expect(tierOf("src/deep/nested/x.json")).toBe("other");
    expect(tierOf("src/main.py")).toBe("entry");
    expect(tierOf("src/pkg/cli.py")).toBe("entry");
    expect(tierOf("src/pkg/corpus.py")).toBe("source");
    expect(tierOf("tests/test_corpus.py")).toBe("test");
    expect(tierOf("src/corpus_test.go")).toBe("test");
    expect(tierOf("src/index.test.ts")).toBe("test");
    expect(tierOf("tests/fixtures/x.html")).toBe("test");
  });

  it("README and manifests always come first: they are the starting evidence of every run", () => {
    const list = candidates(SAMPLE);
    expect(alwaysFirst(list)).toEqual(["README.md", "docs/guide.md", "package.json"]);
  });
});

describe("how evidence is shown", () => {
  it("the inventory is one line per entry with sizes, folders marked, bounded in lines and characters", () => {
    const text = inventoryText(SAMPLE);
    expect(text.split("\n")[0]).toBe("README.md (100 bytes)");
    expect(text).toContain("\nsrc/\n");
    expect(text).toContain("data/big.csv (524289 bytes)");
    expect(text).not.toContain("…");
    const huge = inventory(Array.from({ length: 400 }, (_, i) => f(`folder/file-number-${i}-with-a-long-name.txt`)), true);
    const bounded = inventoryText(huge);
    expect(bounded.length).toBeLessThanOrEqual(MAX_INVENTORY_CHARS + 200);
    expect(bounded.split("\n").length).toBeLessThanOrEqual(301);
    expect(bounded).toContain("… and more entries not listed (400 files and 0 folders were counted, listing stopped at a bound)");
  });

  it("an excerpt is the head of the file between markers, cut at the per-file bound with a note", () => {
    expect(fileExcerpt("a.py", "x = 1\n\n")).toBe("=== FILE a.py ===\nx = 1\n=== END a.py ===");
    const long = "y".repeat(MAX_FILE_CHARS + 500);
    const cut = fileExcerpt("b.py", long);
    expect(cut.startsWith(`=== FILE b.py (first ${MAX_FILE_CHARS.toLocaleString()} of ${(MAX_FILE_CHARS + 500).toLocaleString()} characters; continue with read from line 2) ===\n`)).toBe(true);
    expect(cut).toContain("y".repeat(MAX_FILE_CHARS));
    expect(cut).not.toContain("y".repeat(MAX_FILE_CHARS + 1));
    expect(cut.endsWith("=== END b.py ===")).toBe(true);
  });

  it("the packet reads in order, once each, skipping binary and unreadable files, within the file and character bounds", async () => {
    const texts: Record<string, string | null> = { "a.md": "A", "b.py": "B\0inary", "c.py": null, "d.py": "D", "e.py": "E" };
    const readText = vi.fn(async (p: string) => texts[p] ?? null);
    const packet = await readPacket(["a.md", "b.py", "a.md", "c.py", "d.py", "e.py"], readText, 0, 3);
    expect(packet.files).toEqual(["a.md", "d.py", "e.py"]);
    expect(readText.mock.calls.map((c) => c[0])).toEqual(["a.md", "b.py", "c.py", "d.py", "e.py"]);
    expect(packet.text).toBe(["=== FILE a.md ===\nA\n=== END a.md ===", "=== FILE d.py ===\nD\n=== END d.py ===", "=== FILE e.py ===\nE\n=== END e.py ==="].join("\n\n"));
    expect(packet.chars).toBe(packet.text.length + 2);
  });

  it("the character bound counts what is already spoken for, and a file that does not fit is skipped, not cut", async () => {
    const big = "z".repeat(MAX_FILE_CHARS);
    const readText = async () => big;
    const already = MAX_EVIDENCE_CHARS - MAX_FILE_CHARS - 100;
    const packet = await readPacket(["one.py", "two.py"], readText, already);
    expect(packet.files).toEqual(["one.py"]);
    const bounded = await readPacket(["one.py", "two.py", "three.py"], readText, 0, MAX_STARTER_FILES, MAX_FILE_CHARS * 2 + 200);
    expect(bounded.files).toEqual(["one.py", "two.py"]);
  });

  it("a read from a later line shows that part of the file and says where it started and where to continue", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(fileExcerpt("a.py", lines, 190)).toBe(`=== FILE a.py (from line 190 of 200) ===\n${Array.from({ length: 11 }, (_, i) => `line ${190 + i}`).join("\n")}\n=== END a.py ===`);
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n");
    const cut = fileExcerpt("b.py", long, 1000);
    expect(cut.startsWith("=== FILE b.py (from line 1,000 of 2,000, first 3,000 of ")).toBe(true);
    expect(cut).toContain("continue with read from line 1,3");
    expect(cut.split("\n")[1]).toBe("line 1000");
    // A line past the end shows the last line; a line before the start is the start.
    expect(fileExcerpt("c.py", "one\ntwo", 9)).toContain("=== FILE c.py (from line 2 of 2) ===\ntwo");
    expect(fileExcerpt("c.py", "one\ntwo", 0)).toBe("=== FILE c.py ===\none\ntwo\n=== END c.py ===");
  });

  it("a listing and a search are shown place-relative, bounded, and say when more was found", () => {
    const entry = (rel: string, is_dir = false): Entry => ({ name: rel.split("/").pop() ?? rel, rel_path: rel, is_dir });
    expect(listText("src", [entry("defiance/src/a.py"), entry("defiance/src/pkg", true)], "defiance")).toBe("=== LIST src (2 entries) ===\nsrc/a.py\nsrc/pkg/");
    expect(listText("", [], "defiance")).toBe("=== LIST . (0 entries) ===\n(empty)");
    const many = listText("big", Array.from({ length: MAX_LIST_LINES + 5 }, (_, i) => entry(`defiance/big/f${i}`)), "defiance");
    expect(many.split("\n")).toHaveLength(MAX_LIST_LINES + 2);
    expect(many.endsWith("… and 5 more entries not listed")).toBe(true);
    const hit = (rel: string, line: number | null, text: string | null): SearchResult => ({ name: rel.split("/").pop() ?? rel, rel_path: rel, line, text });
    const summary = { files: 12, results: 2, truncated: false, cancelled: false };
    expect(searchText("boot", [hit("defiance/src/a.py", 3, "boot()"), hit("defiance/boot.md", null, null)], summary, "defiance")).toBe('=== SEARCH "boot" (2 hits in 12 files) ===\nsrc/a.py:3: boot()\nboot.md (name)');
    expect(searchText("zzz", [], { ...summary, results: 0 }, "defiance")).toBe('=== SEARCH "zzz" (0 hits in 12 files) ===\n(no hits)');
    const hits = Array.from({ length: MAX_SEARCH_HITS + 1 }, (_, i) => hit(`defiance/f${i}`, 1, "x"));
    const bounded = searchText("x", hits, { ...summary, results: hits.length, truncated: true }, "defiance");
    expect(bounded.split("\n")).toHaveLength(MAX_SEARCH_HITS + 2);
    expect(bounded).toContain("… more hits not listed (41 found, search stopped at a bound); use a more specific query");
  });
});

describe("the model's answer is one action or the map", () => {
  it("list, search and read parse with their fields; a map answer is passed on whole", () => {
    expect(parseAction('{"action": "list", "path": "src/"}')).toEqual({ kind: "list", path: "src" });
    expect(parseAction('{"action": "list"}')).toEqual({ kind: "list", path: "" });
    expect(parseAction('{"action": "search", "query": "  assemble_corpus "}')).toEqual({ kind: "search", query: "assemble_corpus" });
    expect(parseAction('{"action": "read", "path": "./src/cli.py"}')).toEqual({ kind: "read", path: "src/cli.py", from: 1 });
    expect(parseAction('{"action": "read", "path": "src/cli.py", "from": 120.7}')).toEqual({ kind: "read", path: "src/cli.py", from: 120 });
    expect(parseAction('{"action": "read", "path": "src/cli.py", "from": -3}')).toEqual({ kind: "read", path: "src/cli.py", from: 1 });
    const map = 'Here: {"version": 1, "title": "x", "groups": [], "landmarks": []}';
    expect(parseAction(map)).toEqual({ kind: "map", text: map });
    expect(parseAction(`{"action": "search", "query": "${"q".repeat(MAX_QUERY_CHARS + 50)}"}`)).toMatchObject({ kind: "search", query: "q".repeat(MAX_QUERY_CHARS) });
  });

  it("a path outside the place, another place's file, or an absolute path can never be listed or read", () => {
    for (const bad of ["../context/me.md", "/etc/passwd", "defiance/../wiki/x.md", "src/../README.md", "a\\b", "src//x"]) {
      expect(placePath(bad), bad).toBeNull();
      expect(parseAction(JSON.stringify({ action: "read", path: bad }))).toMatchObject({ kind: "none" });
      expect(parseAction(JSON.stringify({ action: "list", path: bad }))).toMatchObject({ kind: "none" });
    }
    expect(placePath("context/me.md")).toBe("context/me.md"); // relative to the place: defiance/context/me.md, inside it
    expect(parseAction('{"action": "read", "path": ""}')).toMatchObject({ kind: "none" });
    expect(parseAction('{"action": "read"}')).toMatchObject({ kind: "none" });
    expect(parseAction('{"action": "search", "query": " "}')).toMatchObject({ kind: "none" });
  });

  it("a malformed, shapeless or unknown answer is neither, and the note says what is allowed", () => {
    expect(parseAction("no json")).toEqual({ kind: "none", reason: "not JSON" });
    expect(parseAction("[1]")).toEqual({ kind: "none", reason: "not JSON" });
    expect(parseAction('{"paths": ["a"]}')).toEqual({ kind: "none", reason: "neither an action nor a map" });
    expect(parseAction('{"action": "run", "command": "make"}')).toEqual({ kind: "none", reason: "unknown action run" });
    expect(parseAction('{"action": "write", "path": "x"}')).toEqual({ kind: "none", reason: "unknown action write" });
    expect(noteText("unknown action run")).toBe('=== ACTION REFUSED ===\nunknown action run. Allowed: {"action": "list", "path": ...}, {"action": "search", "query": ...}, {"action": "read", "path": ..., "from": 1}, or the map.');
  });
});

describe("the prompts", () => {
  it("carry the place, the inventory, the notes and the task, and tell the model to use only the evidence", () => {
    const head = packetHead("defiance", SAMPLE);
    expect(head.startsWith("=== PLACE defiance ===\n\n=== INVENTORY (14 files, 6 folders) ===\nREADME.md (100 bytes)")).toBe(true);
    const note = "=== FILE a.md ===\nA\n=== END a.md ===";
    const open = stepPrompt(head, [note, "=== LIST src (0 entries) ===\n(empty)"], { actions: MAX_ACTIONS, chars: 1234 });
    expect(open).toContain(head);
    expect(open).toContain(`${note}\n\n=== LIST src`);
    expect(open.endsWith(`=== TASK ===\nTake one action as {"action": ...} (${MAX_ACTIONS} actions and 1,234 note characters left), or produce the map as one JSON object of the required shape.`)).toBe(true);
    expect(stepPrompt(head, [note], { actions: 1, chars: 10 })).toContain("(1 action and 10 note characters left)");
    for (const spent of [{ actions: 0, chars: 500 }, { actions: 3, chars: 0 }]) {
      expect(stepPrompt(head, [note], spent).endsWith("=== TASK ===\nNo more actions. Produce the map now as one JSON object of the required shape.")).toBe(true);
    }
    expect(stepPrompt(head, [], { actions: 1, chars: 1 })).toContain("=== NO FILE CONTENTS WERE READABLE ===");
    expect(MAP_INSTRUCTION).toContain("Use only the supplied evidence.");
    expect(MAP_INSTRUCTION).toContain("Do not infer a connection because names look related.");
    expect(MAP_INSTRUCTION).toContain("anchor must be copied exactly");
    expect(MAP_INSTRUCTION).toContain("no connections at all; that is a valid answer");
    expect(MAP_INSTRUCTION).toContain('"version": 1');
    for (const action of ['"action": "list"', '"action": "search"', '"action": "read"']) expect(MAP_INSTRUCTION).toContain(action);
    expect(MAX_EVIDENCE_CHARS).toBe(32_000);
  });
});
