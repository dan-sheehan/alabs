import { describe, expect, it, vi } from "vitest";
import { buildView, ViewQueue, type BuildFailure, type BuildIo, type BuildOutcome, type BuildState } from "./viewBuild";
import { MAP_INSTRUCTION, MAX_ACTIONS, MAX_EVIDENCE_CHARS, MAX_FILE_CHARS } from "./viewEvidence";
import { MAX_MODEL_RESPONSE_CHARS } from "./viewMap";
import type { Entry, Inventory, InventoryEntry, LocalModelResult, SearchResult } from "./subject";

// Raven's workflow over a fake place and a fake model: what the model is
// shown to start with and what it can never be shown, how it reaches the
// rest of the place one action at a time, the bounds that end a run, every
// failure leaving nothing on disk, the write only after validation and
// rendering, and the in-memory queue: one at a time, in order, cleared with
// the root.

const f = (path: string, size = 100): InventoryEntry => ({ path, is_dir: false, size });
const d = (path: string): InventoryEntry => ({ path, is_dir: true, size: 0 });

interface FakePlace {
  entries: InventoryEntry[];
  /** Every file on disk, listed or not; the inventory may show fewer. */
  texts: Record<string, string>;
}

const SMALL: FakePlace = {
  entries: [f("README.md"), f("pyproject.toml"), d("src"), f("src/cli.py"), f("src/corpus.py"), f("data.bin"), f("photo.png")],
  texts: {
    "README.md": "# Defiance\n\nRun `defiance build-corpus` (src/cli.py).\n",
    "pyproject.toml": "[project]\nname = \"defiance\"\n",
    "src/cli.py": "from defiance import corpus\n\ndef main():\n    corpus.assemble_corpus()\n",
    "src/corpus.py": "def assemble_corpus():\n    return 1\n",
    "data.bin": "\0\0binary",
  },
};

/** A true map for SMALL, as a model would answer it. */
const SMALL_MAP = JSON.stringify({
  version: 1,
  title: "Defiance",
  summary: "A corpus builder.",
  groups: [
    { id: "cli", label: "Command line", note: "" },
    { id: "core", label: "Corpus", note: "" },
  ],
  landmarks: [
    { id: "main", groupId: "cli", label: "Entry", note: "", paths: ["src/cli.py"] },
    { id: "assemble", groupId: "core", label: "Assembly", note: "", paths: ["src/corpus.py"] },
  ],
  connections: [{ from: "main", to: "assemble", label: "calls", evidence: [{ path: "src/cli.py", kind: "call", anchor: "corpus.assemble_corpus()" }] }],
});

interface Fake {
  io: BuildIo;
  generate: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  listDir: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  writeViewFiles: ReturnType<typeof vi.fn>;
  checkSvg: ReturnType<typeof vi.fn>;
  written: Array<{ place: string; root: string; json: string; svg: string; replace: boolean }>;
  prompts: () => string[];
}

function fake(place: FakePlace, answers: LocalModelResult[] | ((system: string, prompt: string) => LocalModelResult)): Fake {
  const written: Fake["written"] = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  const generate = vi.fn(
    async (_model: string, system: string, prompt: string): Promise<LocalModelResult> =>
      queue ? (queue.shift() ?? { kind: "failed", reason: "no answer left" }) : (answers as (s: string, p: string) => LocalModelResult)(system, prompt),
  );
  const inside = (relPath: string): string => {
    const [head, ...rest] = relPath.split("/");
    if (head !== "defiance") throw `path is outside the scope defiance: ${relPath}`;
    return rest.join("/");
  };
  const readFile = vi.fn(async (relPath: string) => {
    const text = place.texts[inside(relPath)];
    if (text === undefined) throw `cannot read ${relPath}: No such file or directory (os error 2)`;
    if (text.includes("\0")) throw `not a UTF-8 text file: ${relPath}`;
    return { content: text };
  });
  const listDir = vi.fn(async (relPath: string): Promise<Entry[]> => {
    const sub = relPath === "defiance" ? "" : `${inside(relPath)}/`;
    const names = new Set<string>();
    const out: Entry[] = [];
    for (const path of Object.keys(place.texts)) {
      if (!path.startsWith(sub)) continue;
      const rest = path.slice(sub.length);
      const name = rest.split("/")[0];
      if (names.has(name)) continue;
      names.add(name);
      out.push({ name, rel_path: `defiance/${sub}${name}`, is_dir: rest.includes("/") });
    }
    if (out.length === 0) throw `cannot access ${relPath}: No such file or directory (os error 2)`;
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });
  const search = vi.fn(async (query: string, scope: string) => {
    if (scope !== "defiance") throw "scope is empty";
    const results: SearchResult[] = [];
    for (const [path, text] of Object.entries(place.texts)) {
      if (text.includes("\0")) continue;
      text.split("\n").forEach((line, i) => {
        if (line.toLowerCase().includes(query.toLowerCase())) results.push({ name: path.split("/").pop() ?? path, rel_path: `defiance/${path}`, line: i + 1, text: line.trim() });
      });
    }
    return { results, summary: { files: Object.keys(place.texts).length, results: results.length, truncated: false, cancelled: false } };
  });
  const writeViewFiles = vi.fn(async (p: string, root: string, json: string, svg: string, replace: boolean) => {
    written.push({ place: p, root, json, svg, replace });
  });
  const checkSvg = vi.fn((svg: string) => ({ kind: "ok" as const, landmarks: (svg.match(/data-landmark=/g) ?? []).length }));
  const io: BuildIo = {
    collectInventory: async (p: string) => {
      if (p !== "defiance") throw "not a work place";
      const inventory: Inventory = { entries: place.entries, truncated: false, files: place.entries.filter((e) => !e.is_dir).length, folders: place.entries.filter((e) => e.is_dir).length };
      return inventory;
    },
    listDir,
    readFile,
    search,
    generate,
    writeViewFiles,
    checkSvg,
  };
  return { io, generate, readFile, listDir, search, writeViewFiles, checkSvg, written, prompts: () => generate.mock.calls.map((c) => c[2] as string) };
}

const answer = (text: string): LocalModelResult => ({ kind: "answer", text, model: "chosen" });
const act = (action: Record<string, unknown>) => answer(JSON.stringify(action));
const job = (replace = true) => ({ place: "defiance", root: "/Users/me/alabs", model: "chosen", replace });

describe("the map on the first call", () => {
  it("shows the model the listing, README and manifests, never a binary or a picture, and writes view.json and map.svg only after every check", async () => {
    const fk = fake(SMALL, [answer(SMALL_MAP)]);
    const outcome = await buildView(fk.io, job());
    expect(outcome.kind).toBe("built");
    if (outcome.kind !== "built") return;
    expect(outcome.calls).toBe(1);
    expect(outcome.files).toBe(2);
    expect(outcome).toMatchObject({ landmarks: 2, connections: 1, dropped: { landmarks: 0, connections: 0 } });
    expect(fk.generate).toHaveBeenCalledTimes(1);
    const [model, system, prompt] = fk.generate.mock.calls[0];
    expect(model).toBe("chosen");
    expect(system).toBe(MAP_INSTRUCTION);
    expect(prompt).toContain("=== PLACE defiance ===");
    expect(prompt).toContain("src/corpus.py (100 bytes)");
    expect(prompt).toContain("=== FILE README.md ===\n# Defiance");
    expect(prompt).toContain("=== FILE pyproject.toml ===");
    // Source is not read until asked for; the whole place is never one prompt.
    expect(prompt).not.toContain("=== FILE src/cli.py");
    expect(prompt).not.toContain("binary");
    expect(prompt).not.toContain("=== FILE photo.png");
    expect(prompt).toContain(`(${MAX_ACTIONS} actions and`);
    // Reads: the starting files, then what validation needed for the anchor and the call target.
    expect(fk.readFile.mock.calls.map((c) => c[0])).toEqual(["defiance/README.md", "defiance/pyproject.toml", "defiance/src/cli.py", "defiance/src/corpus.py"]);
    expect(fk.listDir).not.toHaveBeenCalled();
    expect(fk.search).not.toHaveBeenCalled();
    expect(fk.written).toHaveLength(1);
    const { place, root, json, svg, replace } = fk.written[0];
    expect([place, root, replace]).toEqual(["defiance", "/Users/me/alabs", true]);
    const saved = JSON.parse(json);
    expect(saved.place).toBe("defiance");
    expect(saved.landmarks.map((l: { paths: string[] }) => l.paths)).toEqual([["src/cli.py"], ["src/corpus.py"]]);
    expect(svg).toContain('data-path="defiance/src/cli.py"');
    expect(fk.checkSvg).toHaveBeenCalledWith(svg);
    expect(outcome.timings.total).toBeGreaterThanOrEqual(0);
    expect(outcome.timings.model).not.toBeNull();
  });

  it("replace passes through to the write, and nothing else differs", async () => {
    const fk = fake(SMALL, [answer(SMALL_MAP)]);
    expect((await buildView(fk.io, job(false))).kind).toBe("built");
    expect(fk.written[0].replace).toBe(false);
  });
});

describe("the model reaches the whole place one action at a time", () => {
  /** A place whose inventory shows less than is on disk: `src/deep/` is beyond the listing, as a big place's would be. */
  const LARGE: FakePlace = {
    entries: [f("README.md", 2000), f("package.json", 500), d("src"), f("src/index.ts"), f("src/util.ts")],
    texts: {
      "README.md": "# Big\n" + "prose ".repeat(300),
      "package.json": "{\"name\": \"big\"}",
      "src/index.ts": "import { run } from './deep/runner';\nrun();\n",
      "src/util.ts": "export const x = 1;\n",
      "src/deep/runner.ts": "export function run() {}\n" + Array.from({ length: 400 }, (_, i) => `// line ${i + 2}`).join("\n"),
      "src/deep/other.ts": "export const y = 2;\n",
    },
  };
  const LARGE_MAP = JSON.stringify({
    version: 1,
    title: "Big",
    summary: "Modules.",
    groups: [{ id: "src", label: "Source", note: "" }],
    landmarks: [
      { id: "entry", groupId: "src", label: "Entry", note: "", paths: ["src/index.ts"] },
      { id: "runner", groupId: "src", label: "Runner", note: "", paths: ["src/deep/runner.ts"] },
    ],
    connections: [{ from: "entry", to: "runner", label: "imports", evidence: [{ path: "src/index.ts", kind: "import", anchor: "import { run } from './deep/runner';" }] }],
  });

  it("list, search and read each answer into the notes; the next call sees them; a file the listing did not show can be cited once seen", async () => {
    const fk = fake(LARGE, [act({ action: "list", path: "src/deep" }), act({ action: "search", query: "runner" }), act({ action: "read", path: "src/index.ts" }), act({ action: "read", path: "src/deep/runner.ts", from: 398 }), answer(LARGE_MAP)]);
    const outcome = await buildView(fk.io, job());
    expect(outcome).toMatchObject({ kind: "built", calls: 5, files: 4, landmarks: 2, connections: 1 });
    const prompts = fk.prompts();
    expect(prompts).toHaveLength(5);
    for (const p of prompts) expect(p.split("=== PLACE defiance ===")).toHaveLength(2);
    expect(prompts[1]).toContain("=== LIST src/deep (2 entries) ===\nsrc/deep/other.ts\nsrc/deep/runner.ts");
    expect(prompts[2]).toContain('=== SEARCH "runner" (1 hits in 6 files) ===\nsrc/index.ts:1: import { run } from \'./deep/runner\';');
    expect(prompts[3]).toContain("=== FILE src/index.ts ===\nimport { run } from './deep/runner';\nrun();\n=== END src/index.ts ===");
    expect(prompts[4]).toContain("=== FILE src/deep/runner.ts (from line 398 of 401) ===\n// line 398\n// line 399\n// line 400\n// line 401\n=== END src/deep/runner.ts ===");
    // Notes accumulate in order and nothing is dropped; each call is bounded by what was asked for so far.
    expect(prompts[4].indexOf("=== LIST src/deep")).toBeLessThan(prompts[4].indexOf('=== SEARCH "runner"'));
    expect(prompts[4].indexOf('=== SEARCH "runner"')).toBeLessThan(prompts[4].indexOf("=== FILE src/index.ts"));
    expect(prompts[4]).toContain(`(${MAX_ACTIONS - 4} actions and`);
    expect(prompts[0]).not.toContain("=== FILE src/");
    expect(fk.listDir).toHaveBeenCalledWith("defiance/src/deep");
    expect(fk.search).toHaveBeenCalledWith("runner", "defiance");
    for (const call of fk.readFile.mock.calls) expect(String(call[0]).startsWith("defiance/")).toBe(true);
    // A read of a file already in the notes is served from the cache: one read per file.
    expect(fk.readFile.mock.calls.filter((c) => c[0] === "defiance/src/deep/runner.ts")).toHaveLength(1);
  });

  it("a path never shown, even a real one, is dropped at validation; one seen only through a listing or a search counts", async () => {
    const cited = JSON.stringify({ ...JSON.parse(LARGE_MAP), connections: [] });
    const unseen = fake(LARGE, [answer(cited)]);
    // src/deep/runner.ts exists but was never listed, found or read: the landmark goes.
    expect(await buildView(unseen.io, job())).toMatchObject({ kind: "built", landmarks: 1, dropped: { landmarks: 1, paths: 1 } });
    const listed = fake(LARGE, [act({ action: "list", path: "src/deep" }), answer(cited)]);
    expect(await buildView(listed.io, job())).toMatchObject({ kind: "built", landmarks: 2 });
    const found = fake(LARGE, [act({ action: "search", query: "export function run" }), answer(cited)]);
    expect(await buildView(found.io, job())).toMatchObject({ kind: "built", landmarks: 2 });
  });

  it("a refused or unusable action is a note and the run goes on; nothing outside the place is ever asked of the bridge", async () => {
    const fk = fake(SMALL, [act({ action: "run", command: "make" }), act({ action: "read", path: "../context/me.md" }), act({ action: "list", path: "/etc" }), act({ action: "read", path: "src/ghost.py" }), act({ action: "read", path: "data.bin" }), act({ action: "list", path: "nowhere" }), answer("I cannot help with that."), answer(SMALL_MAP)]);
    const outcome = await buildView(fk.io, job());
    expect(outcome).toMatchObject({ kind: "built", calls: 8 });
    const last = fk.prompts()[7];
    expect(last).toContain("=== ACTION REFUSED ===\nunknown action run.");
    expect(last).toContain("=== ACTION REFUSED ===\nread needs a file path inside the folder.");
    expect(last).toContain("=== ACTION REFUSED ===\nlist needs a path inside the folder.");
    expect(last).toContain("=== ACTION REFUSED ===\ncannot read src/ghost.py: not a text file inside the folder, or too large.");
    expect(last).toContain("=== ACTION REFUSED ===\ncannot read data.bin: not a text file inside the folder, or too large.");
    expect(last).toContain("=== ACTION REFUSED ===\ncannot list nowhere.");
    expect(last).toContain("=== ACTION REFUSED ===\nnot JSON.");
    expect(last).toContain(`(${MAX_ACTIONS - 7} actions and`);
    for (const call of [...fk.readFile.mock.calls, ...fk.listDir.mock.calls]) expect(String(call[0]).startsWith("defiance/")).toBe(true);
    expect(fk.readFile.mock.calls.map((c) => c[0])).not.toContain("defiance/../context/me.md");
    expect(fk.written).toHaveLength(1);
  });

  it("a private environment file is listed but never read, never a search hit, never an anchor: its contents reach no prompt", async () => {
    const SECRET: FakePlace = {
      entries: [...SMALL.entries, f(".env", 40), f(".env.local", 40), f("production.env", 40), f("src/settings.py")],
      texts: {
        ...SMALL.texts,
        ".env": "API_TOKEN=hunter2-top-secret\n",
        ".env.local": "DB_PASSWORD=swordfish-local\n",
        "production.env": "API_TOKEN=xyzzy-production\n",
        "src/settings.py": 'import os\n\nAPI_TOKEN = os.environ["API_TOKEN"]\n',
      },
    };
    const withEnvAnchor = JSON.stringify({
      ...JSON.parse(SMALL_MAP),
      landmarks: [...JSON.parse(SMALL_MAP).landmarks, { id: "settings", groupId: "core", label: "Settings", note: "", paths: ["src/settings.py"] }],
      connections: [
        ...JSON.parse(SMALL_MAP).connections,
        // An anchor in the private file can never be checked, so the connection goes.
        { from: "settings", to: "main", label: "configures", evidence: [{ path: ".env", kind: "config", anchor: "API_TOKEN=hunter2-top-secret" }] },
      ],
    });
    const fk = fake(SECRET, [act({ action: "read", path: ".env" }), act({ action: "read", path: ".env.local", from: 1 }), act({ action: "read", path: "production.env" }), act({ action: "search", query: "API_TOKEN" }), act({ action: "read", path: "src/settings.py" }), answer(withEnvAnchor)]);
    const outcome = await buildView(fk.io, job());
    expect(outcome).toMatchObject({ kind: "built", calls: 6, landmarks: 3, connections: 1, dropped: { connections: 1, anchors: 1 } });
    const prompts = fk.prompts();
    // Named in the listing, so the model can know it exists.
    expect(prompts[0]).toContain(".env (40 bytes)");
    expect(prompts[0]).toContain(".env.local (40 bytes)");
    expect(prompts[0]).toContain("production.env (40 bytes)");
    // Refused by name, with a reason that says not to try again.
    expect(prompts[1]).toContain("=== ACTION REFUSED ===\ncannot read .env: a private environment file is never shown.");
    expect(prompts[2]).toContain("=== ACTION REFUSED ===\ncannot read .env.local: a private environment file is never shown.");
    expect(prompts[3]).toContain("=== ACTION REFUSED ===\ncannot read production.env: a private environment file is never shown.");
    // The search still finds the ordinary file's line; the private files' lines are dropped and not counted.
    expect(prompts[4]).toContain('=== SEARCH "API_TOKEN" (1 hits in 9 files) ===\nsrc/settings.py:3: API_TOKEN = os.environ["API_TOKEN"]');
    expect(prompts[5]).toContain("=== FILE src/settings.py ===");
    for (const p of prompts) {
      expect(p).not.toContain("hunter2");
      expect(p).not.toContain("swordfish");
      expect(p).not.toContain("xyzzy");
      expect(p).not.toContain("=== FILE .env");
      expect(p).not.toContain("=== FILE production.env");
    }
    // The bridge was never asked for any of them: not for the read, not for the anchor check.
    for (const call of fk.readFile.mock.calls) expect(String(call[0]), String(call[0])).not.toMatch(/\/(\.env|production\.env)/);
    expect(fk.readFile.mock.calls.map((c) => c[0])).toContain("defiance/src/settings.py");
    expect(fk.written).toHaveLength(1);
    expect(fk.written[0].json).not.toContain("hunter2");
  });

  it("after the last action the model must map: an action then is an invalid answer, and nothing is written", async () => {
    const fk = fake(SMALL, Array.from({ length: MAX_ACTIONS + 1 }, () => act({ action: "search", query: "corpus" })));
    const outcome = await buildView(fk.io, job());
    expect(outcome).toMatchObject({ kind: "failed", reason: "invalid" });
    expect(fk.generate).toHaveBeenCalledTimes(MAX_ACTIONS + 1);
    expect(fk.search).toHaveBeenCalledTimes(MAX_ACTIONS);
    const prompts = fk.prompts();
    expect(prompts[MAX_ACTIONS - 1]).toContain("(1 action and");
    expect(prompts[MAX_ACTIONS]).toContain("=== TASK ===\nNo more actions. Produce the map now");
    expect(fk.writeViewFiles).not.toHaveBeenCalled();
    // The same run, mapping when told to, is written.
    const ok = fake(SMALL, [...Array.from({ length: MAX_ACTIONS }, () => act({ action: "search", query: "corpus" })), answer(SMALL_MAP)]);
    expect(await buildView(ok.io, job())).toMatchObject({ kind: "built", calls: MAX_ACTIONS + 1 });
  });

  it("the notes are bounded: a result that does not fit is cut, and the next call must map", async () => {
    const big: FakePlace = { entries: [f("README.md"), ...Array.from({ length: 20 }, (_, i) => f(`src/m${i}.py`, 5000))], texts: { "README.md": "# Big\n", ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/m${i}.py`, `# m${i}\n` + "x".repeat(MAX_FILE_CHARS * 2)])) } };
    const map = JSON.stringify({ version: 1, title: "Big", summary: "Modules.", groups: [{ id: "src", label: "Source", note: "" }], landmarks: [{ id: "m0", groupId: "src", label: "M0", note: "", paths: ["src/m0.py"] }], connections: [] });
    let next = 0;
    // The model reads one module per call until told to map.
    const fk = fake(big, (_system, prompt) => (prompt.includes("No more actions.") ? answer(map) : act({ action: "read", path: `src/m${next++}.py` })));
    const outcome = await buildView(fk.io, job());
    expect(outcome.kind).toBe("built");
    const prompts = fk.prompts();
    // Reads of 3,000 characters each pass 32,000 well before the twelve actions run out.
    const full = prompts.findIndex((p) => p.includes("No more actions."));
    expect(full).toBeGreaterThan(0);
    expect(full).toBeLessThan(MAX_ACTIONS);
    expect(prompts[full]).toContain("=== CUT: the notes are full ===");
    for (const p of prompts) expect(p.length).toBeLessThan(MAX_EVIDENCE_CHARS + 1_000);
    expect(prompts).toHaveLength(full + 1);
  });
});

describe("every failure leaves nothing on disk", () => {
  const cases: Array<[string, LocalModelResult, string]> = [
    ["unavailable", { kind: "unavailable" }, "unavailable"],
    ["timeout", { kind: "timeout" }, "timeout"],
    ["not installed", { kind: "not_installed", model: "chosen" }, "not_installed"],
    ["refused", { kind: "failed", reason: "HTTP 500" }, "model"],
    ["malformed JSON", answer("{not json"), "invalid"],
    ["a rejected map carries its category", answer("[1]"), "invalid"],
    ["oversized", answer("{" + "x".repeat(MAX_MODEL_RESPONSE_CHARS) + "}"), "invalid"],
    ["invented paths", answer(SMALL_MAP.split("src/cli.py").join("src/ghost.py").split("src/corpus.py").join("src/ghost2.py")), "invalid"],
    ["a path out of the place", answer(SMALL_MAP.replace("src/cli.py", "../context/me.md")), "invalid"],
    ["markup", answer(SMALL_MAP.replace("Defiance", "<svg onload=x>")), "invalid"],
  ];
  for (const [name, result, reason] of cases) {
    it(`${name} → ${reason}, and nothing is written`, async () => {
      // An answer that is neither an action nor a map spends one action as a note; a model that never recovers ends at the bound.
      const fk = fake(SMALL, Array.from({ length: MAX_ACTIONS + 1 }, () => result));
      const outcome = await buildView(fk.io, job());
      expect(outcome).toMatchObject({ kind: "failed", reason });
      if (reason === "invalid") expect(outcome).toHaveProperty("detail", expect.any(String));
      expect(fk.writeViewFiles).not.toHaveBeenCalled();
    });
  }

  it("a stopped model on a later call fails the run the same way", async () => {
    const fk = fake(SMALL, [act({ action: "read", path: "src/cli.py" }), { kind: "unavailable" }]);
    expect(await buildView(fk.io, job())).toMatchObject({ kind: "failed", reason: "unavailable" });
    expect(fk.writeViewFiles).not.toHaveBeenCalled();
  });

  it("a place that cannot be listed, a drawing the sanitizer refuses, and a refused write", async () => {
    const fk = fake(SMALL, [answer(SMALL_MAP)]);
    expect(await buildView(fk.io, { ...job(), place: "elsewhere" })).toMatchObject({ kind: "failed", reason: "evidence" });
    expect(fk.generate).not.toHaveBeenCalled();

    const bad = fake(SMALL, [answer(SMALL_MAP)]);
    bad.checkSvg.mockReturnValue({ kind: "invalid", reason: "no SVG drawing was found in it" });
    expect(await buildView(bad.io, job())).toMatchObject({ kind: "failed", reason: "render" });
    expect(bad.writeViewFiles).not.toHaveBeenCalled();

    const fewer = fake(SMALL, [answer(SMALL_MAP)]);
    fewer.checkSvg.mockReturnValue({ kind: "ok", landmarks: 1 });
    expect(await buildView(fewer.io, job())).toMatchObject({ kind: "failed", reason: "render" });

    const refused = fake(SMALL, [answer(SMALL_MAP)]);
    refused.writeViewFiles.mockRejectedValue("already exists: views/defiance/map.svg");
    expect(await buildView(refused.io, job())).toMatchObject({ kind: "failed", reason: "write" });

    const moved = fake(SMALL, [answer(SMALL_MAP)]);
    moved.writeViewFiles.mockRejectedValue("the alabs root changed while the view was being built");
    expect(await buildView(moved.io, job())).toMatchObject({ kind: "failed", reason: "root_changed" });
  });

  it("a map that drops unsupported claims is still written, with what survived", async () => {
    const partial = SMALL_MAP.replace("corpus.assemble_corpus()", "corpus.never_called()");
    expect(partial).not.toBe(SMALL_MAP);
    const fk = fake(SMALL, [answer(partial)]);
    const outcome = await buildView(fk.io, job());
    expect(outcome).toMatchObject({ kind: "built", connections: 0, dropped: { connections: 1, anchors: 1 } });
    expect(JSON.parse(fk.written[0].json).connections).toEqual([]);
  });

  it("the io has no member that saves, creates, moves or trashes a file: the only write is the staged Visual View write", () => {
    const fk = fake(SMALL, [answer(SMALL_MAP)]);
    expect(Object.keys(fk.io).sort()).toEqual(["checkSvg", "collectInventory", "generate", "listDir", "readFile", "search", "writeViewFiles"]);
  });

  it("timings are measured per phase", async () => {
    let t = 0;
    const now = () => (t += 10);
    const fk = fake(SMALL, [act({ action: "read", path: "src/cli.py" }), answer(SMALL_MAP)]);
    const outcome = await buildView(fk.io, job(), now);
    expect(outcome.kind).toBe("built");
    if (outcome.kind !== "built") return;
    expect(outcome.timings.evidence).toBeGreaterThan(0);
    expect(outcome.timings.model).toBe(20);
    expect(outcome.timings.validate).toBe(10);
    expect(outcome.timings.render).toBe(10);
    expect(outcome.timings.total).toBeGreaterThan(outcome.timings.model ?? 0);
  });
});

describe("the queue", () => {
  interface Deferred {
    place: string;
    resolve: (o: BuildOutcome) => void;
  }
  const built: BuildOutcome = { kind: "built", calls: 1, files: 1, landmarks: 1, connections: 0, dropped: { landmarks: 0, connections: 0, groups: 0, paths: 0, anchors: 0, reasons: {} }, timings: { evidence: 1, model: 1, validate: 1, render: 1, total: 4 } };
  const failed = (reason: BuildFailure): BuildOutcome => ({ kind: "failed", reason, timings: { evidence: null, model: null, validate: null, render: null, total: 0 } });

  function harness() {
    const runs: Deferred[] = [];
    const changes: Array<[string, BuildState, BuildOutcome | null]> = [];
    const queue = new ViewQueue(
      (place) => new Promise<BuildOutcome>((resolve) => runs.push({ place, resolve })),
      (place, state, outcome) => changes.push([place, state, outcome]),
    );
    return { runs, changes, queue };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("runs one place at a time, in order, and never queues a place twice", async () => {
    const h = harness();
    expect(h.queue.enqueue("a")).toBe(true);
    expect(h.queue.enqueue("b")).toBe(true);
    expect(h.queue.enqueue("a")).toBe(false);
    expect(h.queue.enqueue("b")).toBe(false);
    await tick();
    expect(h.runs.map((r) => r.place)).toEqual(["a"]);
    expect(h.queue.busy).toBe(true);
    expect(h.queue.queued()).toEqual(["b"]);
    expect(h.queue.stateOf("a")).toEqual({ kind: "building" });
    expect(h.queue.stateOf("b")).toEqual({ kind: "queued" });
    h.runs[0].resolve(built);
    await tick();
    expect(h.queue.stateOf("a")).toEqual({ kind: "built" });
    expect(h.runs.map((r) => r.place)).toEqual(["a", "b"]);
    h.runs[1].resolve(failed("invalid"));
    await tick();
    expect(h.queue.stateOf("b")).toEqual({ kind: "failed", reason: "invalid" });
    expect(h.queue.busy).toBe(false);
    // The first place starts at once, before the second is even queued.
    expect(h.changes.map(([p, s, o]) => `${p}:${s.kind}:${o?.kind ?? "-"}`)).toEqual(["a:queued:-", "a:building:-", "b:queued:-", "a:built:built", "b:building:-", "b:failed:failed"]);
    // A finished place can be queued again (another Run Raven).
    expect(h.queue.enqueue("b")).toBe(true);
    await tick();
    expect(h.runs[2]).toMatchObject({ place: "b" });
  });

  it("an unreachable local model marks every waiting place the same way and dials no more", async () => {
    const h = harness();
    h.queue.enqueue("a");
    h.queue.enqueue("b");
    h.queue.enqueue("c");
    await tick();
    h.runs[0].resolve(failed("unavailable"));
    await tick();
    expect(h.runs).toHaveLength(1);
    expect(h.queue.queued()).toEqual([]);
    expect(h.queue.stateOf("b")).toEqual({ kind: "failed", reason: "unavailable" });
    expect(h.queue.stateOf("c")).toEqual({ kind: "failed", reason: "unavailable" });
  });

  it("clear forgets what waits and ignores the running build's outcome", async () => {
    const h = harness();
    h.queue.enqueue("a");
    h.queue.enqueue("b");
    await tick();
    h.queue.clear();
    expect(h.queue.snapshot().size).toBe(0);
    expect(h.queue.queued()).toEqual([]);
    h.queue.enqueue("c");
    await tick();
    // c waits for the stale build to end.
    expect(h.runs.map((r) => r.place)).toEqual(["a"]);
    h.runs[0].resolve(built);
    await tick();
    expect(h.queue.stateOf("a")).toBeNull();
    expect(h.runs.map((r) => r.place)).toEqual(["a", "c"]);
    expect(h.changes.filter(([p]) => p === "a").map(([, s]) => s.kind)).toEqual(["queued", "building"]);
  });

  it("a build that throws is a model failure, and the queue goes on", async () => {
    const changes: Array<[string, BuildState]> = [];
    const queue = new ViewQueue(
      async (place) => {
        if (place === "a") throw new Error("boom");
        return built;
      },
      (place, state) => changes.push([place, state]),
    );
    queue.enqueue("a");
    queue.enqueue("b");
    await tick();
    await tick();
    expect(queue.stateOf("a")).toEqual({ kind: "failed", reason: "model" });
    expect(queue.stateOf("b")).toEqual({ kind: "built" });
  });
});
