import { describe, expect, it, vi } from "vitest";
import {
  callIdentifier,
  cleanMapPath,
  extractJson,
  hasIdentifier,
  namesFile,
  namesTarget,
  MAX_CONNECTIONS,
  MAX_GROUPS,
  MAX_LANDMARKS,
  MAX_MODEL_RESPONSE_CHARS,
  serializeMap,
  validateMap,
  type MapContext,
} from "./viewMap";

// The structured map contract: what a model answer must be to be rendered
// at all (structure, bounds, ids, no way out of the place, no markup), and
// what of it is dropped as unsupported (paths that do not exist, anchors
// that do not occur). Pure over an inventory and injected reads.

const FILES: Record<string, string | null> = {
  "README.md": "# Defiance\n\nBuild with `defiance build-corpus`; see src/a.py.\n",
  "src/a.py": "import b\nfrom b import validate\n\ndef run(x):\n    return validate(x)\n",
  "src/b.py": "def validate(x):\n    return x\n",
  "data/blob.bin": null,
};

function context(): MapContext & { readText: ReturnType<typeof vi.fn> } {
  const readText = vi.fn(async (path: string) => FILES[path] ?? null);
  return { place: "defiance", files: new Set(Object.keys(FILES)), readText };
}

/** A small map that is true of the fixture. */
function good() {
  return {
    version: 1,
    title: "Defiance",
    summary: "A corpus builder.",
    groups: [
      { id: "core", label: "Core", note: "the work" },
      { id: "docs", label: "Docs", note: "" },
    ],
    landmarks: [
      { id: "run", groupId: "core", label: "Runner", note: "runs validate", paths: ["src/a.py"] },
      { id: "validate", groupId: "core", label: "Validation", note: "", paths: ["src/b.py"] },
      { id: "readme", groupId: "docs", label: "README", note: "", paths: ["README.md"] },
    ],
    connections: [
      { from: "run", to: "validate", label: "calls", evidence: [{ path: "src/a.py", kind: "call", anchor: "validate(x)" }] },
      { from: "readme", to: "run", label: "documents", evidence: [{ path: "README.md", kind: "documented", anchor: "src/a.py" }] },
    ],
  };
}

const text = (v: unknown) => JSON.stringify(v);

async function ok(v: unknown) {
  const result = await validateMap(text(v), context());
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("rejected");
  return result;
}

async function rejected(v: unknown, reason: string) {
  const result = await validateMap(typeof v === "string" ? v : text(v), context());
  expect(result).toEqual({ kind: "rejected", reason });
}

describe("a true map is accepted as it is", () => {
  it("keeps every group, landmark and connection, names the place, and reads each evidence file once", async () => {
    const ctx = context();
    const result = await validateMap(text(good()), ctx);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.map.place).toBe("defiance");
    expect(result.map.title).toBe("Defiance");
    expect(result.map.groups.map((g) => g.id)).toEqual(["core", "docs"]);
    expect(result.map.landmarks.map((l) => [l.id, l.paths])).toEqual([
      ["run", ["src/a.py"]],
      ["validate", ["src/b.py"]],
      ["readme", ["README.md"]],
    ]);
    expect(result.map.connections.map((c) => [c.from, c.to, c.evidence.length])).toEqual([
      ["run", "validate", 1],
      ["readme", "run", 1],
    ]);
    expect(result.dropped).toEqual({ landmarks: 0, connections: 0, groups: 0, paths: 0, anchors: 0, reasons: {} });
    // The evidence files, and the target of the call for its identifier; each once.
    expect(ctx.readText.mock.calls.map((c) => c[0])).toEqual(["src/a.py", "src/b.py", "README.md"]);
  });

  it("finds the object inside a code fence or prose", async () => {
    const wrapped = "Here is the map:\n```json\n" + text(good()) + "\n```\nDone.";
    const result = await validateMap(wrapped, context());
    expect(result.kind).toBe("ok");
    expect(extractJson("no object here")).toBeNull();
    expect(extractJson("}{")).toBeNull();
  });

  it("folds ids, collapses whitespace, clips long text, and accepts ./ and place-prefixed paths", async () => {
    const m = good();
    m.groups[0].id = "Core Work";
    m.landmarks[0].groupId = "core_work";
    m.landmarks[1].groupId = "core-work";
    m.landmarks[0].label = "  A   very\n long " + "x".repeat(80);
    m.landmarks[0].paths = ["./src/a.py", "defiance/src/b.py", "src/a.py"];
    const result = await ok(m);
    expect(result.map.groups[0].id).toBe("core-work");
    expect(result.map.landmarks[0].groupId).toBe("core-work");
    expect(result.map.landmarks[0].label.length).toBe(60);
    expect(result.map.landmarks[0].label.endsWith("…")).toBe(true);
    expect(result.map.landmarks[0].label.startsWith("A very long")).toBe(true);
    expect(result.map.landmarks[0].paths).toEqual(["src/a.py", "src/b.py"]);
  });

  it("a map with no connections is valid: a folder of documents needs no arrows", async () => {
    const m = good();
    m.connections = [];
    const result = await ok(m);
    expect(result.map.connections).toEqual([]);
    const { connections: _c, ...rest } = m;
    void _c;
    expect((await ok(rest)).map.connections).toEqual([]);
  });

  it("serializes readably for a reader without alabs", async () => {
    const { map } = await ok(good());
    const saved = serializeMap(map);
    expect(saved.endsWith("\n")).toBe(true);
    expect(JSON.parse(saved)).toEqual(map);
    expect(saved.split("\n").length).toBeGreaterThan(20);
  });
});

describe("the whole answer is rejected", () => {
  it("for malformed, oversized, non-object or other-version JSON", async () => {
    await rejected("not json at all", "not JSON");
    await rejected("{\"version\": 1,", "not JSON");
    await rejected("x".repeat(MAX_MODEL_RESPONSE_CHARS + 1), "answer too large");
    await rejected("[1, 2]", "not JSON");
    await rejected({ ...good(), version: 2 }, "unsupported version");
    await rejected({ ...good(), version: "1" }, "unsupported version");
  });

  it("for missing or empty groups, landmarks or paths", async () => {
    await rejected({ ...good(), groups: undefined }, "missing groups");
    await rejected({ ...good(), groups: [] }, "missing groups");
    await rejected({ ...good(), landmarks: "none" }, "missing landmarks");
    await rejected({ ...good(), landmarks: [] }, "missing landmarks");
    const m = good();
    delete (m.landmarks[0] as { paths?: string[] }).paths;
    await rejected(m, "missing paths");
    const n = good();
    delete (n.landmarks[0] as { id?: string }).id;
    await rejected(n, "missing id");
    const o = good();
    o.groups[0].label = "";
    await rejected(o, "missing label");
  });

  it("over the count bounds", async () => {
    const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));
    await rejected({ ...good(), groups: many(MAX_GROUPS + 1, (i) => ({ id: `g${i}`, label: "G" })) }, "too many groups");
    await rejected({ ...good(), landmarks: many(MAX_LANDMARKS + 1, (i) => ({ id: `l${i}`, groupId: "core", label: "L", paths: ["src/a.py"] })) }, "too many landmarks");
    await rejected(
      { ...good(), connections: many(MAX_CONNECTIONS + 1, () => ({ from: "run", to: "validate", evidence: [{ path: "src/a.py", kind: "call", anchor: "validate(x)" }] })) },
      "too many connections",
    );
  });


  it("for any path that leaves the place: absolute, climbing, backslashed, a URL", async () => {
    for (const bad of ["/etc/passwd", "../context/me.md", "src/../../wiki/x.md", "src\\a.py", "https://example.com/a.py", "file:///x"]) {
      const m = good();
      m.landmarks[0].paths = [bad];
      await rejected(m, "path is not inside the place");
      const n = good();
      n.connections[0].evidence[0].path = bad;
      await rejected(n, "path is not inside the place");
    }
    expect(cleanMapPath("  ./src/./a.py ")).toEqual({ kind: "ok", path: "src/a.py" });
    expect(cleanMapPath("")).toEqual({ kind: "empty" });
    expect(cleanMapPath("..")).toEqual({ kind: "hostile" });
  });

  it("for markup, links or control characters in any text", async () => {
    const cases: Array<(m: ReturnType<typeof good>) => void> = [
      (m) => (m.title = "<svg onload=alert(1)>"),
      (m) => (m.summary = "see https://example.com"),
      (m) => (m.groups[0].label = "a <b> c"),
      (m) => (m.groups[0].note = "x\u0007y"),
      (m) => (m.landmarks[0].label = "<script>"),
      (m) => (m.landmarks[0].note = "<img src=x>"),
      (m) => (m.connections[0].label = "a > b"),
    ];
    for (const mutate of cases) {
      const m = good();
      mutate(m);
      await rejected(m, "markup or link in text");
    }
  });

  it("for an unknown evidence kind or malformed evidence", async () => {
    const m = good();
    m.connections[0].evidence[0].kind = "guess";
    await rejected(m, "unknown evidence kind");
    const n = good();
    (n.connections[0] as { evidence?: unknown }).evidence = "src/a.py";
    await rejected(n, "missing evidence");
    const o = good();
    (o.connections[0].evidence[0] as { anchor?: unknown }).anchor = 42;
    await rejected(o, "missing evidence");
  });

  it("an anchor too short or too long to be one line supports nothing; a multi-line anchor counts by its first line", async () => {
    const p = good();
    p.connections[0].evidence[0].anchor = "x";
    expect((await ok(p)).map.connections.map((c) => c.from)).toEqual(["readme"]);
    const q = good();
    q.connections[0].evidence[0].anchor = "y".repeat(201);
    const r = await ok(q);
    expect(r.map.connections.map((c) => c.from)).toEqual(["readme"]);
    expect(r.dropped.anchors).toBe(1);
    const m = good();
    m.connections[0].evidence[0] = { path: "src/a.py", kind: "import", anchor: "\n  from b import validate\n\ndef run(x):" };
    const kept = await ok(m);
    expect(kept.map.connections[0].evidence[0].anchor).toBe("from b import validate");
  });

  it("when no landmark has a real path", async () => {
    const m = good();
    for (const l of m.landmarks) l.paths = ["src/missing.py"];
    await rejected(m, "no landmark has a real path");
  });
});

describe("an unsupported claim is dropped and counted", () => {
  it("a repeated group id keeps the first; a repeated landmark id drops the later one and every connection naming it", async () => {
    const m = good();
    m.groups.push({ id: "core", label: "Again", note: "" });
    const r1 = await ok(m);
    expect(r1.map.groups.map((g) => g.label)).toEqual(["Core", "Docs"]);
    expect(r1.dropped.groups).toBe(1);
    const n = good();
    n.landmarks.push({ id: "run", groupId: "core", label: "Twice", note: "", paths: ["src/a.py"] });
    const r2 = await ok(n);
    expect(r2.map.landmarks.map((l) => l.label)).toEqual(["Runner", "Validation", "README"]);
    expect(r2.map.connections).toEqual([]);
    expect(r2.dropped).toMatchObject({ landmarks: 1, connections: 2 });
  });

  it("a landmark whose group id names no group goes, with its connections; a connection whose endpoint names no landmark goes", async () => {
    const o = good();
    o.landmarks[0].groupId = "nowhere";
    const r1 = await ok(o);
    expect(r1.map.landmarks.map((l) => l.id)).toEqual(["validate", "readme"]);
    expect(r1.map.connections).toEqual([]);
    expect(r1.dropped).toMatchObject({ landmarks: 1, connections: 2 });
    const p = good();
    p.connections[0].to = "ghost";
    const r2 = await ok(p);
    expect(r2.map.connections.map((c) => c.from)).toEqual(["readme"]);
    expect(r2.dropped.connections).toBe(1);
    const q = good();
    q.connections[0].from = "core";
    expect((await ok(q)).map.connections.map((c) => c.from)).toEqual(["readme"]);
    const t = good();
    (t.connections[0] as { from?: string }).from = undefined;
    expect((await ok(t)).map.connections.map((c) => c.from)).toEqual(["readme"]);
  });

  it("a landmark whose paths do not exist goes, with its connections and an emptied group; real paths beside a bad one stay", async () => {
    const m = good();
    m.landmarks[2].paths = ["README.txt", "docs/none.md"];
    m.landmarks[0].paths = ["src/none.py", "src/a.py"];
    const result = await ok(m);
    expect(result.map.landmarks.map((l) => l.id)).toEqual(["run", "validate"]);
    expect(result.map.landmarks[0].paths).toEqual(["src/a.py"]);
    expect(result.map.connections.map((c) => c.from)).toEqual(["run"]);
    expect(result.map.groups.map((g) => g.id)).toEqual(["core"]);
    expect(result.dropped).toMatchObject({ landmarks: 1, connections: 1, groups: 1, paths: 3, anchors: 0, reasons: { endpoint: 1 } });
  });

  it("a connection whose anchor is not in the file goes; one with a real anchor beside a missing one stays", async () => {
    const m = good();
    m.connections[0].evidence[0].anchor = "def validate(y)";
    m.connections[1].evidence.push({ path: "README.md", kind: "documented", anchor: "not in the readme" });
    const result = await ok(m);
    expect(result.map.connections.map((c) => c.from)).toEqual(["readme"]);
    expect(result.map.connections[0].evidence).toEqual([{ path: "README.md", kind: "documented", anchor: "src/a.py" }]);
    expect(result.dropped.connections).toBe(1);
    expect(result.dropped.anchors).toBe(2);
  });

  it("an evidence path that is missing, binary or unreadable cannot support anything", async () => {
    const m = good();
    m.connections[0].evidence[0].path = "src/none.py";
    m.connections[1].evidence[0].path = "data/blob.bin";
    const result = await ok(m);
    expect(result.map.connections).toEqual([]);
    expect(result.dropped).toMatchObject({ connections: 2, paths: 1, anchors: 1 });
  });

  it("a self-connection, a repeated pair, a connection with no evidence items, and a duplicate label go", async () => {
    const m = good();
    m.connections.push({ from: "run", to: "run", label: "loops", evidence: [{ path: "src/a.py", kind: "call", anchor: "validate(x)" }] });
    m.connections.push({ from: "run", to: "validate", label: "again", evidence: [{ path: "src/a.py", kind: "import", anchor: "import b" }] });
    m.connections.push({ from: "validate", to: "run", label: "nothing", evidence: [] });
    m.landmarks.push({ id: "run2", groupId: "docs", label: "runner", note: "", paths: ["src/a.py"] });
    const result = await ok(m);
    expect(result.map.connections.map((c) => [c.from, c.to])).toEqual([
      ["run", "validate"],
      ["readme", "run"],
    ]);
    expect(result.map.landmarks.map((l) => l.id)).not.toContain("run2");
    expect(result.dropped).toMatchObject({ connections: 3, landmarks: 1 });
  });

  it("an import line supports a connection only when it names the target's file", async () => {
    expect(namesTarget("from .parse import ParseError", ["src/corpus_parse.py"])).toBe(false);
    expect(namesTarget("from .corpus_parse import parse_all", ["src/parse.py"])).toBe(false);
    expect(namesTarget("from .corpus_parse import parse_all", ["src/corpus_parse.py"])).toBe(true);
    expect(namesTarget("import { scanInventory } from './lib/inventory.mjs';", ["lib/inventory.mjs"])).toBe(true);
    expect(namesTarget("from defiance import corpus", ["src/defiance/corpus.py"])).toBe(true);
    expect(namesTarget("import './styles.css'", ["public/styles.css"])).toBe(true);
    expect(namesTarget("from './lib'", ["lib/index.js"])).toBe(false);
    const m = good();
    // `run` imports b; the anchor names b, the target file of `validate`: kept.
    m.connections[0].evidence[0] = { path: "src/a.py", kind: "import", anchor: "from b import validate" };
    expect((await ok(m)).map.connections.map((c) => c.from)).toEqual(["run", "readme"]);
    const n = good();
    // The same line cited for a landmark whose file it does not name: dropped.
    n.connections[0].evidence[0] = { path: "src/a.py", kind: "import", anchor: "from b import validate" };
    n.connections[0].to = "readme";
    const r = await ok(n);
    expect(r.map.connections.map((c) => c.from)).toEqual(["readme"]);
    expect(r.dropped.reasons).toEqual({ "import-target": 1, "no-evidence": 1 });
    // A call does not have to name the file, but its identifier must occur in the target.
    const o = good();
    o.connections[0].evidence[0] = { path: "src/a.py", kind: "call", anchor: "validate(x)" };
    expect((await ok(o)).map.connections).toHaveLength(2);
  });

  it("anchors are matched exactly, after trimming and joining lines", async () => {
    const m = good();
    m.connections[0].evidence[0].anchor = "  validate(x)\n";
    const result = await ok(m);
    expect(result.map.connections[0].evidence[0].anchor).toBe("validate(x)");
    const n = good();
    n.connections[0].evidence[0].anchor = "VALIDATE(X)";
    expect((await ok(n)).map.connections.map((c) => c.from)).toEqual(["readme"]);
  });
});

describe("the semantic gate: evidence must tie the source landmark to the target landmark", () => {
  /** `run` (src/a.py) and `validate` (src/b.py) in one group, `readme` (README.md) in another; one connection to shape per case. */
  function withEvidence(from: string, to: string, evidence: { path: string; kind: string; anchor: string }) {
    const m = good();
    m.connections = [{ from, to, label: "relates", evidence: [evidence] }];
    return m;
  }

  it("anchor presence alone does not establish a connection", async () => {
    // `validate(x)` really is in src/a.py, but src/a.py is not one of readme's files.
    const r = await ok(withEvidence("readme", "validate", { path: "src/a.py", kind: "call", anchor: "validate(x)" }));
    expect(r.map.connections).toEqual([]);
    expect(r.dropped.reasons).toEqual({ "evidence-ownership": 1, "no-evidence": 1 });
    // `import b` is in src/a.py and names b.py, but cited from a file that is not the source's.
    const s = await ok(withEvidence("readme", "validate", { path: "src/a.py", kind: "import", anchor: "import b" }));
    expect(s.map.connections).toEqual([]);
    expect(s.dropped.reasons).toEqual({ "evidence-ownership": 1, "no-evidence": 1 });
  });

  it("a call whose identifier is absent from the target is dropped; one supported by source and target is kept", async () => {
    // `run(` occurs in src/a.py (the source's own file) but nowhere in src/b.py.
    const dropped = await ok(withEvidence("run", "validate", { path: "src/a.py", kind: "call", anchor: "def run(x):" }));
    expect(dropped.map.connections).toEqual([]);
    expect(dropped.dropped.reasons).toEqual({ "call-target": 1, "no-evidence": 1 });
    // No `identifier(` at all.
    const none = await ok(withEvidence("run", "validate", { path: "src/a.py", kind: "call", anchor: "import b" }));
    expect(none.dropped.reasons).toEqual({ "call-identifier": 1, "no-evidence": 1 });
    // `validate(` in the source's file, and `validate` defined in the target's file.
    const kept = await ok(withEvidence("run", "validate", { path: "src/a.py", kind: "call", anchor: "return validate(x)" }));
    expect(kept.map.connections).toEqual([{ from: "run", to: "validate", label: "relates", evidence: [{ path: "src/a.py", kind: "call", anchor: "return validate(x)" }] }]);
    expect(kept.dropped.reasons).toEqual({});
    expect(callIdentifier("corpus.assemble_corpus()")).toBe("assemble_corpus");
    expect(callIdentifier("self.db.query (sql)")).toBe("query");
    expect(callIdentifier("no call here")).toBeNull();
    expect(hasIdentifier("def validate(x):", "validate")).toBe(true);
    expect(hasIdentifier("def revalidate(x):", "validate")).toBe(false);
    expect(hasIdentifier("validated = 1", "validate")).toBe(false);
  });

  it("a read, write or config relation without a target file name is dropped; naming the target's path or basename keeps it", async () => {
    for (const kind of ["read", "write", "config"]) {
      const vague = await ok(withEvidence("run", "readme", { path: "src/a.py", kind, anchor: "import b" }));
      expect(vague.map.connections).toEqual([]);
      expect(vague.dropped.reasons).toEqual({ "target-name": 1, "no-evidence": 1 });
    }
    // The anchor must occur in the source's own file and name the target: `# Defiance` is in README.md, so read README.md from readme to run must name src/a.py.
    const named = await ok(withEvidence("readme", "run", { path: "README.md", kind: "read", anchor: "see src/a.py" }));
    expect(named.map.connections).toHaveLength(1);
    expect(namesFile("open('config/2017/corpus.json')", ["config/2017/corpus.json"])).toBe(true);
    expect(namesFile("load corpus.json now", ["config/2017/corpus.json"])).toBe(true);
    expect(namesFile("load_config()", ["config.json"])).toBe(false);
    expect(namesFile("run make", ["Makefile"])).toBe(false);
    expect(namesFile("see the Makefile", ["Makefile"])).toBe(true);
    expect(namesFile("data loads", ["data/rows.csv"])).toBe(false);
  });

  it("a vague documented relationship is dropped; explicit evidence naming both endpoints may survive", async () => {
    // README.md is readme's own file, but the line names no target file.
    const vague = await ok(withEvidence("readme", "run", { path: "README.md", kind: "documented", anchor: "Build with `defiance build-corpus`" }));
    expect(vague.map.connections).toEqual([]);
    expect(vague.dropped.reasons).toEqual({ "documented-endpoints": 1, "no-evidence": 1 });
    // Own file naming the target: kept.
    const own = await ok(withEvidence("readme", "run", { path: "README.md", kind: "documented", anchor: "see src/a.py" }));
    expect(own.map.connections).toHaveLength(1);
    // A third-party file (README.md is neither run's nor validate's) must name both endpoints.
    const oneSide = await ok(withEvidence("run", "validate", { path: "README.md", kind: "contains", anchor: "see src/a.py" }));
    expect(oneSide.map.connections).toEqual([]);
    expect(oneSide.dropped.reasons).toEqual({ "documented-endpoints": 1, "no-evidence": 1 });
    const m = good();
    m.connections = [{ from: "run", to: "validate", label: "documented", evidence: [{ path: "README.md", kind: "documented", anchor: "a.py calls b.py" }] }];
    // `a.py calls b.py` is not in README.md; put the exact line there.
    const ctx = context();
    const files: Record<string, string | null> = { ...FILES, "README.md": "# Defiance\n\na.py calls b.py\n" };
    ctx.readText.mockImplementation(async (p: string) => files[p] ?? null);
    const both = await validateMap(text(m), ctx);
    expect(both.kind).toBe("ok");
    if (both.kind !== "ok") return;
    expect(both.map.connections).toHaveLength(1);
  });

  it("a map stays valid with zero connections, and dropping every connection keeps every group and landmark", async () => {
    const m = good();
    m.connections = [
      { from: "run", to: "validate", label: "x", evidence: [{ path: "src/a.py", kind: "documented", anchor: "import b" }] },
      { from: "readme", to: "run", label: "y", evidence: [{ path: "README.md", kind: "call", anchor: "# Defiance" }] },
    ];
    const r = await ok(m);
    expect(r.map.connections).toEqual([]);
    expect(r.map.groups.map((g) => g.id)).toEqual(["core", "docs"]);
    expect(r.map.landmarks.map((l) => l.id)).toEqual(["run", "validate", "readme"]);
    expect(r.dropped).toMatchObject({ landmarks: 0, groups: 0, connections: 2 });
    expect(r.dropped.reasons).toEqual({ "documented-endpoints": 1, "call-identifier": 1, "no-evidence": 2 });
  });

  it("existing verified import behaviour still works", async () => {
    const r = await ok(withEvidence("run", "validate", { path: "src/a.py", kind: "import", anchor: "from b import validate" }));
    expect(r.map.connections.map((c) => [c.from, c.to, c.evidence[0].kind])).toEqual([["run", "validate", "import"]]);
    const wrongTarget = await ok(withEvidence("run", "readme", { path: "src/a.py", kind: "import", anchor: "from b import validate" }));
    expect(wrongTarget.map.connections).toEqual([]);
    expect(wrongTarget.dropped.reasons).toEqual({ "import-target": 1, "no-evidence": 1 });
  });
});
