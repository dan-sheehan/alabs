import { describe, expect, it, vi } from "vitest";
import {
  collectRootEvidence,
  listingCandidates,
  MAX_GROUP_CANDIDATES,
  MAX_LANDMARK_CANDIDATES,
  MAX_PLACE_CHARS,
  MAX_ROOT_EVIDENCE_CHARS,
  MAX_TOP_LEVEL_CANDIDATES,
  placeBlock,
  readChildView,
  readmeTitle,
  ROOT_INSTRUCTION,
  rootPrompt,
  viewCandidates,
  type RootEvidenceIo,
} from "./rootEvidence";
import { MAX_ROOT_PLACES } from "./rootMap";
import { classifyRoot, placeViewJsonPath } from "./places";
import type { HomeData } from "./launch";
import type { Entry } from "./subject";

// The root evidence: a place's saved view is preferred, a place without one
// falls back to its Overview facts, a malformed view never removes the
// place, every place and present role enters, nothing inside a place is
// rescanned, and every bound holds.

const dir = (name: string, rel = name): Entry => ({ name, rel_path: rel, is_dir: true });
const file = (name: string, rel = name): Entry => ({ name, rel_path: rel, is_dir: false });

const CHILD_VIEW = JSON.stringify({
  version: 1,
  place: "defiance",
  title: "Defiance",
  summary: "A source-backed corpus for one season.",
  groups: [
    { id: "ingest", label: "Ingestion", note: "" },
    { id: "query", label: "Query path", note: "" },
  ],
  landmarks: [
    { id: "cli", groupId: "query", label: "CLI", note: "", paths: ["src/cli.py"] },
    { id: "web-ui", groupId: "query", label: "Web UI", note: "", paths: ["src/web.py"] },
    { id: "query", groupId: "query", label: "Query", note: "", paths: ["src/query.py"] },
  ],
  connections: [],
});

function fakeIo(files: Record<string, string>, listings: Record<string, Entry[]>) {
  const io: RootEvidenceIo = {
    readFile: vi.fn(async (rel: string) => {
      const content = files[rel];
      if (content === undefined) throw `cannot read ${rel}: No such file or directory (os error 2)`;
      return { content };
    }),
    listDir: vi.fn(async (rel: string) => {
      const entries = listings[rel];
      if (entries === undefined) throw `cannot open ${rel}: No such file or directory (os error 2)`;
      return entries;
    }),
  };
  return io;
}

function home(over: Partial<HomeData> = {}): HomeData {
  return {
    listing: classifyRoot([dir("defiance"), dir("notes"), dir("cockpit"), dir("context"), dir("wiki"), dir("views"), dir(".git")]),
    views: new Set(["defiance"]),
    git: new Map([["defiance", "repo"]]),
    rootView: { exists: false, saved: null },
    ...over,
  };
}

describe("per-place evidence", () => {
  it("prefers a valid saved view: its title, summary, landmarks and groups become the candidates, and the place is not listed", async () => {
    const io = fakeIo({ [placeViewJsonPath("defiance")]: CHILD_VIEW }, { notes: [], cockpit: [] });
    const evidence = await collectRootEvidence(io, home());
    const defiance = evidence.places[1];
    expect(evidence.places.map((p) => p.placeId)).toEqual(["cockpit", "defiance", "notes"]);
    expect(defiance.source).toBe("view");
    expect(defiance.kind).toBe("repo");
    expect(defiance.hasView).toBe(true);
    expect(defiance.title).toBe("Defiance");
    expect(defiance.summary).toBe("A source-backed corpus for one season.");
    expect(defiance.candidates).toEqual([
      { id: "cli", label: "CLI", kind: "landmark" },
      { id: "web-ui", label: "Web UI", kind: "landmark" },
      { id: "query", label: "Query", kind: "landmark" },
      { id: "group-ingest", label: "Ingestion", kind: "group" },
      { id: "group-query", label: "Query path", kind: "group" },
    ]);
    expect(defiance.text).toContain("=== WORK PLACE defiance ===");
    expect(defiance.text).toContain("kind: git repository");
    expect(defiance.text).toContain("- group-query · group · Query path");
    expect(vi.mocked(io.listDir).mock.calls.map((c) => c[0])).not.toContain("defiance");
  });

  it("falls back to the Overview facts when there is no saved view: README title and first paragraph, top-level names", async () => {
    const io = fakeIo(
      { "notes/README.md": "# My notes\n\nWhere I keep **things** worth\nkeeping.\n\nMore later." },
      { notes: [dir("drafts", "notes/drafts"), file("README.md", "notes/README.md"), file("todo.txt", "notes/todo.txt")], cockpit: [file("app.js", "cockpit/app.js")], defiance: [] },
    );
    const evidence = await collectRootEvidence(io, home({ views: new Set() }));
    const notes = evidence.places[2];
    expect(notes.source).toBe("readme");
    expect(notes.title).toBe("My notes");
    expect(notes.summary).toBe("Where I keep **things** worth keeping.");
    expect(notes.candidates).toEqual([
      { id: "drafts", label: "drafts/", kind: "folder" },
      { id: "readme-md", label: "README.md", kind: "file" },
      { id: "todo-txt", label: "todo.txt", kind: "file" },
    ]);
    const cockpit = evidence.places[0];
    expect(cockpit.source).toBe("listing");
    expect(cockpit.title).toBeNull();
    expect(cockpit.summary).toBeNull();
    expect(cockpit.candidates).toEqual([{ id: "app-js", label: "app.js", kind: "file" }]);
    // A place that cannot even be listed still enters, with its identity alone.
    expect(vi.mocked(io.readFile)).toHaveBeenCalledWith("notes/README.md");
  });

  it("keeps a place whose saved view is malformed, another place's, or another version, by falling back", async () => {
    const io = fakeIo(
      {
        [placeViewJsonPath("defiance")]: "{not json",
        [placeViewJsonPath("notes")]: CHILD_VIEW,
        [placeViewJsonPath("cockpit")]: JSON.stringify({ version: 2, place: "cockpit", groups: [], landmarks: [] }),
      },
      { defiance: [file("README.md", "defiance/README.md")], notes: [], cockpit: [] },
    );
    const evidence = await collectRootEvidence(io, home());
    expect(evidence.places.map((p) => [p.placeId, p.source])).toEqual([
      ["cockpit", "listing"],
      ["defiance", "listing"],
      ["notes", "listing"],
    ]);
  });

  it("enters every work place and every present knowledge role, and never a missing or conflicted role", async () => {
    const io = fakeIo({}, { defiance: [], notes: [], cockpit: [] });
    const evidence = await collectRootEvidence(io, home({ listing: classifyRoot([dir("defiance"), dir("notes"), dir("cockpit"), dir("context"), dir("wiki"), dir("Wiki")]) }));
    expect(evidence.places).toHaveLength(3);
    expect(evidence.roles).toEqual(["context"]);
    const listed = fakeIo({}, { defiance: [], notes: [], cockpit: [] });
    expect((await collectRootEvidence(listed, home())).roles).toEqual(["context", "wiki"]);
  });

  it("never rescans a repository: one listing of the place's top level and one README read at most, never a subfolder", async () => {
    const io = fakeIo(
      { "notes/README.md": "# n", [placeViewJsonPath("defiance")]: CHILD_VIEW },
      { notes: [dir("src", "notes/src"), file("README.md", "notes/README.md")], cockpit: [dir("lib", "cockpit/lib")] },
    );
    await collectRootEvidence(io, home());
    expect(vi.mocked(io.listDir).mock.calls.map((c) => c[0]).sort()).toEqual(["cockpit", "notes"]);
    expect(vi.mocked(io.readFile).mock.calls.map((c) => c[0]).sort()).toEqual([
      "notes/README.md",
      placeViewJsonPath("cockpit"),
      placeViewJsonPath("defiance"),
      placeViewJsonPath("notes"),
    ]);
  });

  it("an empty root gives empty evidence", async () => {
    const evidence = await collectRootEvidence(fakeIo({}, {}), home({ listing: classifyRoot([]), views: new Set(), git: new Map() }));
    expect(evidence.places).toEqual([]);
    expect(evidence.roles).toEqual([]);
    expect(rootPrompt(evidence)).toContain("work places: 0");
    expect(rootPrompt(evidence)).toContain("knowledge places: none");
  });
});

describe("bounds", () => {
  it("caps landmark, group and top-level candidates", () => {
    const view = readChildView(
      JSON.stringify({
        version: 1,
        place: "p",
        groups: Array.from({ length: 9 }, (_, i) => ({ id: `g${i}`, label: `Group ${i}` })),
        landmarks: Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, label: `Landmark ${i}` })),
      }),
      "p",
    );
    expect(view).not.toBeNull();
    const candidates = viewCandidates(view!);
    expect(candidates.filter((c) => c.kind === "landmark")).toHaveLength(MAX_LANDMARK_CANDIDATES);
    expect(candidates.filter((c) => c.kind === "group")).toHaveLength(MAX_GROUP_CANDIDATES);
    expect(listingCandidates(Array.from({ length: 30 }, (_, i) => file(`f${i}.txt`)))).toHaveLength(MAX_TOP_LEVEL_CANDIDATES);
  });

  it("gives every candidate a reachable id: a collision gets a suffix", () => {
    expect(listingCandidates([file("a b.txt"), file("a-b.txt"), dir("A_B")]).map((c) => c.id)).toEqual(["a-b-txt", "a-b-txt-2", "a-b"]);
    const view = readChildView(JSON.stringify({ version: 1, place: "p", groups: [{ id: "cli", label: "CLI group" }], landmarks: [{ id: "group-cli", label: "Odd" }, { id: "cli", label: "CLI" }] }), "p");
    expect(viewCandidates(view!).map((c) => c.id)).toEqual(["group-cli", "cli", "group-cli-2"]);
  });

  it("keeps one place's block under its bound by cutting candidate lines first", () => {
    const candidates = Array.from({ length: 12 }, (_, i) => ({ id: `id-${i}`, label: "x".repeat(60), kind: "landmark" as const }));
    const block = placeBlock({ placeId: "p", kind: "none", hasView: false, source: "view", title: "t".repeat(80), summary: "s".repeat(400), candidates });
    expect(block.text.length).toBeLessThanOrEqual(MAX_PLACE_CHARS);
    expect(block.candidates.length).toBeLessThan(12);
    expect(block.candidates.length).toBeGreaterThan(0);
    expect(block.text).toContain("title: " + "t".repeat(80));
  });

  it("keeps the whole packet under its bound: past it a place keeps its identity, title and summary and offers no candidates", async () => {
    const names = Array.from({ length: MAX_ROOT_PLACES }, (_, i) => `place-${String(i).padStart(2, "0")}`);
    const files: Record<string, string> = {};
    for (const name of names) {
      files[placeViewJsonPath(name)] = JSON.stringify({
        version: 1,
        place: name,
        title: `Title of ${name}`,
        summary: "s".repeat(400),
        groups: Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, label: "g".repeat(60) })),
        landmarks: Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, label: "l".repeat(60) })),
      });
    }
    const evidence = await collectRootEvidence(fakeIo(files, {}), home({ listing: classifyRoot(names.map((n) => dir(n))), views: new Set(), git: new Map() }));
    expect(evidence.places).toHaveLength(MAX_ROOT_PLACES);
    const withCandidates = evidence.places.filter((p) => p.candidates.length > 0);
    const without = evidence.places.filter((p) => p.candidates.length === 0);
    expect(withCandidates.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    expect(withCandidates.reduce((n, p) => n + p.text.length + 2, 0)).toBeLessThanOrEqual(MAX_ROOT_EVIDENCE_CHARS);
    for (const p of without) expect(p.text).toContain(`title: Title of ${p.placeId}`);
    // The later places are the ones cut, so the head of the listing keeps its detail.
    expect(evidence.places.findIndex((p) => p.candidates.length === 0)).toBeGreaterThan(evidence.places.findIndex((p) => p.candidates.length > 0));
  });

  it("refuses a root over the place bound instead of cutting a place", async () => {
    const names = Array.from({ length: MAX_ROOT_PLACES + 1 }, (_, i) => `p${i}`);
    await expect(collectRootEvidence(fakeIo({}, {}), home({ listing: classifyRoot(names.map((n) => dir(n))), views: new Set(), git: new Map() }))).rejects.toThrow(/too many places/);
  });
});

describe("the README title", () => {
  it("is the first heading without its marks, or null", () => {
    expect(readmeTitle("# Defiance\n\nText")).toBe("Defiance");
    expect(readmeTitle("intro\n\n## Second ##\n")).toBe("Second");
    expect(readmeTitle("no heading at all")).toBeNull();
    expect(readmeTitle("#no space")).toBeNull();
    expect(readmeTitle("# <b>markup</b>")).toBeNull();
  });
});

describe("the prompt", () => {
  it("states every rule the model must follow", () => {
    for (const phrase of [
      "Use only the supplied evidence",
      "exactly once",
      "do not create, rename, merge or omit places",
      "only from that place's own candidate ids",
      "prefer fewer highlights",
      "do not describe how places relate",
      "Do not use outside knowledge",
      "Do not output SVG, HTML",
      "JSON object and nothing else",
    ]) {
      expect(ROOT_INSTRUCTION).toContain(phrase);
    }
  });

  it("holds the head, one block per place, the knowledge places and the task, in that order", async () => {
    const io = fakeIo({ [placeViewJsonPath("defiance")]: CHILD_VIEW, "notes/README.md": "# Notes\n\nkept here" }, { notes: [file("README.md", "notes/README.md")], cockpit: [] });
    const evidence = await collectRootEvidence(io, home());
    const prompt = rootPrompt(evidence);
    const order = ["=== ALABS ROOT ===", "work places: 3 (cockpit, defiance, notes)", "knowledge places: Context, Wiki", "=== WORK PLACE cockpit ===", "=== WORK PLACE defiance ===", "- cli · landmark · CLI", "=== WORK PLACE notes ===", "title: Notes", "summary: kept here", "=== KNOWLEDGE ===", "- Context", "- Wiki", "=== TASK ==="];
    let at = -1;
    for (const part of order) {
      const next = prompt.indexOf(part, at + 1);
      expect(next, part).toBeGreaterThan(at);
      at = next;
    }
    expect(evidence.chars).toBeGreaterThan(0);
    expect(evidence.chars).toBeLessThan(MAX_ROOT_EVIDENCE_CHARS);
  });
});
