import { describe, expect, it } from "vitest";
import {
  MAX_HIGHLIGHTS,
  MAX_ROOT_RESPONSE_CHARS,
  MAX_SAVED_ROOT_CHARS,
  readSavedRootMap,
  rootViewCurrent,
  serializeRootMap,
  supportedBy,
  validateRootMap,
  type RootEvidence,
  type RootMap,
} from "./rootMap";
import { classifyRoot } from "./places";
import type { Entry } from "./subject";

// The root map contract: a true answer accepted with its places in the
// evidence's order, every structural fault rejected whole, every
// unsupported extra dropped and counted, the saved file read back
// leniently, and the structural stale check that compares place sets only.

const EVIDENCE: RootEvidence = {
  places: [
    {
      placeId: "defiance",
      kind: "repo",
      hasView: true,
      source: "view",
      title: "Defiance",
      summary: "A source-backed corpus for one baseball season.",
      candidates: [
        { id: "cli", label: "CLI", kind: "landmark" },
        { id: "query", label: "Query path", kind: "landmark" },
        { id: "web-ui", label: "Web UI", kind: "landmark" },
        { id: "group-data", label: "Data", kind: "group" },
      ],
      text: [
        "=== WORK PLACE defiance ===",
        "kind: git repository",
        "title: Defiance",
        "summary: A source-backed corpus for one baseball season.",
        "highlight candidates (choose at most 3 by id, or none):",
        "- cli · landmark · CLI",
        "- query · landmark · Query path",
        "- web-ui · landmark · Web UI",
        "- group-data · group · Data",
      ].join("\n"),
    },
    {
      placeId: "notes",
      kind: "none",
      hasView: false,
      source: "listing",
      title: null,
      summary: null,
      candidates: [{ id: "readme-md", label: "README.md", kind: "file" }],
      text: "=== WORK PLACE notes ===\nkind: folder\nhighlight candidates (choose at most 3 by id, or none):\n- readme-md · file · README.md",
    },
  ],
  roles: ["context", "wiki"],
  chars: 0,
};

const FOLDERS = { context: "Context", wiki: "wiki" } as const;

function answer(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    title: "alabs root",
    places: [
      { placeId: "notes", description: "A folder with a README.", highlightIds: ["readme-md"] },
      { placeId: "defiance", description: "Corpus for one baseball season with a CLI and a web UI.", highlightIds: ["cli", "web-ui"] },
    ],
    knowledge: [{ role: "Context" }, { role: "wiki" }],
    ...over,
  });
}

const ok = (text: string, evidence = EVIDENCE) => {
  const v = validateRootMap(text, evidence, FOLDERS);
  expect(v.kind).toBe("ok");
  if (v.kind !== "ok") throw new Error("rejected");
  return v;
};
const rejected = (text: string, evidence = EVIDENCE) => {
  const v = validateRootMap(text, evidence, FOLDERS);
  expect(v.kind).toBe("rejected");
  return v.kind === "rejected" ? v.reason : "";
};

describe("a true answer", () => {
  it("is accepted with places in the evidence's order, highlights as canonical labels and knowledge in role order", () => {
    const { map, dropped } = ok(answer());
    expect(map.places.map((p) => p.placeId)).toEqual(["defiance", "notes"]);
    expect(map.places[0]).toEqual({
      placeId: "defiance",
      kind: "repo",
      description: "Corpus for one baseball season with a CLI and a web UI.",
      highlights: [
        { id: "cli", label: "CLI" },
        { id: "web-ui", label: "Web UI" },
      ],
    });
    expect(map.places[1]).toEqual({ placeId: "notes", kind: "none", description: "A folder with a README.", highlights: [{ id: "readme-md", label: "README.md" }] });
    expect(map.knowledge).toEqual([
      { role: "context", label: "Context", folder: "Context" },
      { role: "wiki", label: "Wiki", folder: "wiki" },
    ]);
    expect(dropped).toEqual({ highlights: 0, descriptions: 0, reasons: {} });
  });

  it("accepts a fenced or prose-wrapped object, a group candidate, and zero highlights", () => {
    const { map } = ok("Here it is:\n```json\n" + answer({ places: [{ placeId: "defiance", highlightIds: ["group-data"] }, { placeId: "notes" }] }) + "\n```");
    expect(map.places[0].highlights).toEqual([{ id: "group-data", label: "Data" }]);
    expect(map.places[1].highlights).toEqual([]);
  });

  it("uses the canonical summary when the model gives no description, and the title when there is no summary", () => {
    const { map } = ok(answer({ places: [{ placeId: "defiance" }, { placeId: "notes" }] }));
    expect(map.places[0].description).toBe("A source-backed corpus for one baseball season.");
    expect(map.places[1].description).toBe("");
    const titled: RootEvidence = { ...EVIDENCE, places: [{ ...EVIDENCE.places[0], summary: null }, EVIDENCE.places[1]] };
    expect(ok(answer({ places: [{ placeId: "defiance" }, { placeId: "notes" }] }), titled).map.places[0].description).toBe("Defiance");
  });
});

describe("the place inventory", () => {
  it("rejects a missing place", () => {
    expect(rejected(answer({ places: [{ placeId: "defiance" }] }))).toBe("missing place");
  });

  it("rejects an invented place", () => {
    expect(rejected(answer({ places: [{ placeId: "defiance" }, { placeId: "notes" }, { placeId: "orchestrator" }] }))).toBe("unknown place");
  });

  it("rejects a duplicate place", () => {
    expect(rejected(answer({ places: [{ placeId: "defiance" }, { placeId: "notes" }, { placeId: "defiance" }] }))).toBe("duplicate place");
  });

  it("never lets the model rename a place: a near miss is unknown", () => {
    expect(rejected(answer({ places: [{ placeId: "Defiance" }, { placeId: "notes" }] }))).toBe("unknown place");
  });
});

describe("highlights", () => {
  it("drops an unknown id and keeps the place and its other highlights", () => {
    const { map, dropped } = ok(answer({ places: [{ placeId: "defiance", highlightIds: ["cli", "ai-orchestration-layer", "query"] }, { placeId: "notes" }] }));
    expect(map.places[0].highlights.map((h) => h.id)).toEqual(["cli", "query"]);
    expect(dropped.highlights).toBe(1);
    expect(dropped.reasons["unknown-highlight"]).toBe(1);
  });

  it("drops an id from another place's evidence", () => {
    const { map, dropped } = ok(answer({ places: [{ placeId: "defiance" }, { placeId: "notes", highlightIds: ["cli"] }] }));
    expect(map.places[1].highlights).toEqual([]);
    expect(dropped.reasons["unknown-highlight"]).toBe(1);
  });

  it("bounds the count and drops a repeat", () => {
    const { map, dropped } = ok(answer({ places: [{ placeId: "defiance", highlightIds: ["cli", "cli", "query", "web-ui", "group-data"] }, { placeId: "notes" }] }));
    expect(map.places[0].highlights).toHaveLength(MAX_HIGHLIGHTS);
    expect(map.places[0].highlights.map((h) => h.id)).toEqual(["cli", "query", "web-ui"]);
    expect(dropped.reasons["duplicate-highlight"]).toBe(1);
    expect(dropped.reasons["too-many-highlights"]).toBe(1);
  });

  it("treats a missing or malformed list as no highlights", () => {
    expect(ok(answer({ places: [{ placeId: "defiance", highlightIds: "cli" }, { placeId: "notes", highlightIds: [3, null] }] })).map.places.map((p) => p.highlights)).toEqual([[], []]);
  });
});

describe("descriptions", () => {
  it("keeps a description whose words all come from the place's evidence, and drops one that invents a part", () => {
    expect(supportedBy("a source backed corpus with a web ui", EVIDENCE.places[0].text)).toBe(true);
    expect(supportedBy("an AI orchestration layer", EVIDENCE.places[0].text)).toBe(false);
    const { map, dropped } = ok(answer({ places: [{ placeId: "defiance", description: "An AI orchestration layer over the corpus." }, { placeId: "notes" }] }));
    expect(map.places[0].description).toBe("A source-backed corpus for one baseball season.");
    expect(dropped.descriptions).toBe(1);
    expect(dropped.reasons["description-unsupported"]).toBe(1);
  });

  it("checks only words of four characters or more, and allows a plural or singular of an evidence word", () => {
    expect(supportedBy("the CLI of it", "cli")).toBe(true);
    expect(supportedBy("corpus queries", "query corpus")).toBe(true);
    expect(supportedBy("one landmark", "landmarks")).toBe(true);
    expect(supportedBy("season report", "seasons reporting")).toBe(false);
  });

  it("clips a long description", () => {
    const long = "corpus ".repeat(40).trim();
    const { map } = ok(answer({ places: [{ placeId: "defiance", description: long }, { placeId: "notes" }] }));
    expect(map.places[0].description.length).toBeLessThanOrEqual(120);
    expect(map.places[0].description.endsWith("…")).toBe(true);
  });
});

describe("knowledge", () => {
  it("rejects an unknown or invented role and a role the root does not have", () => {
    expect(rejected(answer({ knowledge: [{ role: "Context" }, { role: "Wiki" }, { role: "Ontology" }] }))).toBe("unknown knowledge role");
    expect(rejected(answer({ knowledge: [{ role: "Context" }, { role: "Wiki" }, { role: "Definitions" }] }))).toBe("unknown knowledge role");
    expect(rejected(answer({ knowledge: [{ name: "Context" }, { role: "Wiki" }] }))).toBe("unknown knowledge role");
    expect(rejected(answer({ knowledge: "Context" }))).toBe("missing knowledge");
  });

  it("fills a role the model left out or repeated from what the root has, and counts the slip: the saved map always holds exactly the present roles", () => {
    const omitted = ok(answer({ knowledge: [{ role: "Context" }] }));
    expect(omitted.map.knowledge.map((k) => k.role)).toEqual(["context", "wiki"]);
    expect(omitted.dropped.reasons["knowledge-omitted"]).toBe(1);
    const repeated = ok(answer({ knowledge: [{ role: "Context" }, { role: "Wiki" }, { role: "context" }] }));
    expect(repeated.map.knowledge.map((k) => k.role)).toEqual(["context", "wiki"]);
    expect(repeated.dropped.reasons["knowledge-repeated"]).toBe(1);
    const none = ok(answer({ knowledge: [] }));
    expect(none.map.knowledge.map((k) => k.role)).toEqual(["context", "wiki"]);
    expect(none.dropped.reasons["knowledge-omitted"]).toBe(2);
  });
});

describe("hostile or malformed answers", () => {
  it("rejects raw SVG, HTML, a URL, an absolute path, a home path and a backtick in any text", () => {
    for (const bad of ['<svg xmlns="x"/>', "<b>bold</b>", "see https://example.com", "read /Users/me/notes", "in ~/notes", "run `rm -rf`"]) {
      expect(rejected(answer({ places: [{ placeId: "defiance", description: bad }, { placeId: "notes" }] })), bad).toBe("markup or link in text");
    }
    expect(rejected(answer({ title: "<script>alert(1)</script>" }))).toBe("markup or link in text");
    expect(rejected(answer({ places: [{ placeId: "defiance", highlightIds: ["<cli>"] }, { placeId: "notes" }] }))).toBe("markup or link in text");
    expect(rejected(answer({ knowledge: [{ role: "<Context>" }, { role: "Wiki" }] }))).toBe("markup or link in text");
  });

  it("rejects a control character", () => {
    expect(rejected(answer({ places: [{ placeId: "defiance", description: "a" + String.fromCharCode(7) + "b" }, { placeId: "notes" }] }))).toBe("markup or link in text");
  });

  it("rejects an oversized answer before parsing it", () => {
    expect(rejected(answer() + " ".repeat(MAX_ROOT_RESPONSE_CHARS))).toBe("answer too large");
  });

  it("rejects text that is not JSON, not an object, or another version", () => {
    expect(rejected("no map here")).toBe("not JSON");
    expect(rejected("{not json}")).toBe("not JSON");
    expect(rejected("[1, 2]")).toBe("not JSON");
    expect(rejected(answer({ version: 2 }))).toBe("unsupported version");
    expect(rejected(answer({ places: "defiance" }))).toBe("missing places");
    expect(rejected(answer({ places: ["defiance", "notes"] }))).toBe("missing places");
  });
});

describe("the saved file", () => {
  const map = (): RootMap => ok(answer()).map;

  it("round-trips through the readable serialization", () => {
    const text = serializeRootMap(map());
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n").length).toBeGreaterThan(10);
    expect(readSavedRootMap(text)).toEqual(map());
  });

  it("reads leniently: unusable fields are dropped, unusable places and roles skipped, nothing is fatal but the shape", () => {
    const saved = readSavedRootMap(
      JSON.stringify({
        version: 1,
        title: "<x>",
        places: [
          { placeId: "defiance", kind: "weird", description: "<b>hi</b>", highlights: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }, { id: "a", label: "again" }] },
          { placeId: "../up", kind: "repo" },
          { placeId: ".hidden" },
          { placeId: "defiance" },
          "notes",
        ],
        knowledge: [{ role: "Wiki" }, { role: "context", folder: "Context" }, { role: "wiki" }, { role: "Ontology" }, 4],
      }),
    );
    expect(saved).toEqual({
      version: 1,
      title: "alabs root",
      places: [
        {
          placeId: "defiance",
          kind: "none",
          description: "",
          highlights: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
            { id: "c", label: "C" },
          ],
        },
      ],
      knowledge: [
        { role: "context", label: "Context", folder: "Context" },
        { role: "wiki", label: "Wiki", folder: "wiki" },
      ],
    });
  });

  it("is null for text that is not a root map, or is too large", () => {
    expect(readSavedRootMap("nope")).toBeNull();
    expect(readSavedRootMap(JSON.stringify({ version: 2, places: [], knowledge: [] }))).toBeNull();
    expect(readSavedRootMap(JSON.stringify({ version: 1, place: "defiance", groups: [], landmarks: [] }))).toBeNull();
    expect(readSavedRootMap(serializeRootMap(map()) + " ".repeat(MAX_SAVED_ROOT_CHARS))).toBeNull();
  });
});

describe("the structural stale check", () => {
  const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });
  const saved = (): RootMap => ({
    version: 1,
    title: "alabs root",
    places: [
      { placeId: "defiance", kind: "repo", description: "old words", highlights: [] },
      { placeId: "notes", kind: "none", description: "", highlights: [] },
    ],
    knowledge: [
      { role: "context", label: "Context", folder: "context" },
      { role: "wiki", label: "Wiki", folder: "wiki" },
    ],
  });

  it("is current when the same work places and present roles exist, whatever their order or contents", () => {
    expect(rootViewCurrent(saved(), classifyRoot([dir("notes"), dir("wiki"), dir("defiance"), dir("context"), dir("views"), dir(".git")]))).toBe(true);
  });

  it("needs a rebuild when a work place was added or removed", () => {
    expect(rootViewCurrent(saved(), classifyRoot([dir("defiance"), dir("notes"), dir("zed"), dir("context"), dir("wiki")]))).toBe(false);
    expect(rootViewCurrent(saved(), classifyRoot([dir("defiance"), dir("context"), dir("wiki")]))).toBe(false);
  });

  it("needs a rebuild when the knowledge role set differs", () => {
    expect(rootViewCurrent(saved(), classifyRoot([dir("defiance"), dir("notes"), dir("context"), dir("wiki"), dir("definitions")]))).toBe(false);
    expect(rootViewCurrent(saved(), classifyRoot([dir("defiance"), dir("notes"), dir("context")]))).toBe(false);
    // A conflicted role is not present.
    expect(rootViewCurrent(saved(), classifyRoot([dir("defiance"), dir("notes"), dir("context"), dir("wiki"), dir("Wiki")]))).toBe(false);
  });

  it("ignores everything inside a place: only the sets are compared", () => {
    const changed = saved();
    changed.places[0].description = "entirely different words";
    changed.places[0].highlights = [{ id: "x", label: "X" }];
    expect(rootViewCurrent(changed, classifyRoot([dir("defiance"), dir("notes"), dir("context"), dir("wiki")]))).toBe(true);
  });
});
