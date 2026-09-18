// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { escapeXml, MAP_WIDTH, renderMapSvg } from "./viewRender";
import { parseView } from "./viewSanitize";
import type { ViewMap } from "./viewMap";

// The deterministic renderer: a validated map becomes a plain SVG that the
// Stage 5 sanitizer accepts with every landmark intact, carrying only the
// map's paths as data, with everything from the map escaped. The model
// never reaches this module; a map is the only input.

function map(over: Partial<ViewMap> = {}): ViewMap {
  return {
    version: 1,
    place: "defiance",
    title: "Defiance",
    summary: "A corpus builder for one season.",
    groups: [
      { id: "ingest", label: "Ingestion", note: "offline" },
      { id: "query", label: "Query path", note: "" },
    ],
    landmarks: [
      { id: "fetch", groupId: "ingest", label: "Fetch", note: "downloads pages", paths: ["src/fetch.py", "config/2017/corpus.json"] },
      { id: "parse", groupId: "ingest", label: "Parsers", note: "", paths: ["src/parse.py"] },
      { id: "answer", groupId: "query", label: "Answer", note: "routes questions", paths: ["src/answer.py"] },
    ],
    connections: [
      { from: "fetch", to: "parse", label: "feeds", evidence: [{ path: "src/parse.py", kind: "read", anchor: "open(" }] },
      { from: "parse", to: "answer", label: "read by", evidence: [{ path: "src/answer.py", kind: "import", anchor: "import parse" }] },
    ],
    ...over,
  };
}

const dataPaths = (svg: string) => Array.from(svg.matchAll(/data-path="([^"]*)"/g), (m) => m[1]);

describe("the rendered file", () => {
  it("passes the existing sanitizer with every landmark, note and root-relative path intact", () => {
    const svg = renderMapSvg(map());
    const parsed = parseView(svg);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.landmarks.map((l) => [l.name, l.note, l.paths, l.badPaths])).toEqual([
      ["Fetch", "downloads pages", ["defiance/src/fetch.py", "defiance/config/2017/corpus.json"], []],
      ["Parsers", "", ["defiance/src/parse.py"], []],
      ["Answer", "routes questions", ["defiance/src/answer.py"], []],
    ]);
    // Nothing the sanitizer would strip is there to begin with: the text is the same size in and out.
    const serialized = new XMLSerializer().serializeToString(parsed.svg);
    expect(serialized).toContain("data-landmark=\"Fetch\"");
    expect(serialized).not.toContain("<script");
  });

  it("carries only the map's paths as data, each under the place", () => {
    const svg = renderMapSvg(map());
    const paths = dataPaths(svg);
    expect(paths).toEqual(["defiance/src/fetch.py", "defiance/config/2017/corpus.json", "defiance/src/parse.py", "defiance/src/answer.py"]);
    for (const p of paths) expect(p.startsWith("defiance/")).toBe(true);
  });

  it("is deterministic, uses presentation attributes only, and references nothing outside itself", () => {
    const a = renderMapSvg(map());
    const b = renderMapSvg(map());
    expect(a).toBe(b);
    expect(a).not.toMatch(/\b(class|style|onload|onclick|href)=/);
    expect(a).not.toContain("<script");
    expect(a).not.toContain("<image");
    expect(a).not.toContain("<foreignObject");
    expect(a).not.toMatch(/url\((?!#)/);
    expect(a).toContain('marker-end="url(#arrow)"');
    expect(a.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_WIDTH} `)).toBe(true);
    expect(a.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("escapes every string from the map, so markup in a label is text and never an element", () => {
    const hostile = map({ title: "A & B <script>alert(1)</script>", landmarks: [{ id: "x", groupId: "ingest", label: "Quote \" & <b>", note: "note <i>", paths: ["a\"b.py"] }], connections: [] });
    const svg = renderMapSvg(hostile);
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain('data-landmark="Quote &quot; &amp; &lt;b&gt;"');
    const parsed = parseView(svg);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.landmarks[0].name).toBe('Quote " & <b>');
    expect(parsed.landmarks[0].paths).toEqual(['defiance/a"b.py']);
    expect(parsed.svg.querySelector("script")).toBeNull();
    expect(escapeXml("<&\">")).toBe("&lt;&amp;&quot;&gt;");
  });

  it("draws one arrow per connection, labelled, and none for a map without connections", () => {
    const svg = renderMapSvg(map());
    const arrows = svg.match(/<path d="M[^"]*" fill="none" stroke="#4a4a4a" stroke-width="1" marker-end="url\(#arrow\)"\/>/g) ?? [];
    expect(arrows).toHaveLength(2);
    expect(svg).toContain(">feeds</text>");
    expect(svg).toContain(">read by</text>");
    const none = renderMapSvg(map({ connections: [] }));
    expect(none).not.toContain('marker-end="url(#arrow)"');
    expect(parseView(none).kind).toBe("ok");
  });

  it("stacks groups top to bottom in map order with landmarks in rows of three, and grows with the content", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `l${i}`, groupId: "ingest", label: `Landmark ${i}`, note: "", paths: [`src/f${i}.py`] }));
    const small = renderMapSvg(map({ landmarks: many.slice(0, 3), connections: [] }));
    const large = renderMapSvg(map({ landmarks: many, connections: [] }));
    const height = (svg: string) => Number(svg.match(/viewBox="0 0 \d+ (\d+)"/)?.[1]);
    expect(height(large)).toBeGreaterThan(height(small));
    const xs = Array.from(large.matchAll(/<g data-landmark="Landmark \d"[^>]*>\n<rect x="(\d+)" y="(\d+)"/g), (m) => [Number(m[1]), Number(m[2])]);
    expect(xs).toHaveLength(7);
    expect(new Set(xs.map(([x]) => x)).size).toBe(3);
    expect(xs[3][1]).toBeGreaterThan(xs[0][1]);
    expect(xs[3][0]).toBe(xs[0][0]);
    expect(large.indexOf(">INGESTION<")).toBeLessThan(large.indexOf(">QUERY PATH<"));
    expect(xs.every(([x]) => x + 220 <= MAP_WIDTH - 24)).toBe(true);
  });

  it("clips long text and shows each landmark's first path on the box", () => {
    const long = "L".repeat(120);
    const svg = renderMapSvg(map({ landmarks: [{ id: "x", groupId: "ingest", label: long, note: "N".repeat(200), paths: ["a/very/long/path/that/keeps/going/on/and/on/file.py"] }], connections: [] }));
    // The box shows a clipped name; the data attribute keeps the whole name for the inspector.
    expect(svg).toMatch(/>L{20,}…<\/text>/);
    expect(svg).toContain(`data-landmark="${long}"`);
    expect(svg).not.toMatch(/>L{80,}/);
    expect(svg).not.toContain("N".repeat(200) + "</text>");
    expect(svg).toMatch(/>…[^<]*going\/on\/and\/on\/file\.py<\/text>/);
    expect(svg).toContain(`data-path="defiance/a/very/long/path/that/keeps/going/on/and/on/file.py"`);
  });
});
