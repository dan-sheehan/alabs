// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderRootSvg, ROOT_MAP_WIDTH } from "./rootRender";
import { parseView } from "./viewSanitize";
import type { RootMap } from "./rootMap";

// The deterministic root renderer: a validated root map becomes a plain
// SVG that the Stage 5 sanitizer accepts with every place and knowledge
// folder as a landmark, no arrows, nothing external, everything from the
// map escaped, and no coordinate decided by the map's text.

function map(over: Partial<RootMap> = {}): RootMap {
  return {
    version: 1,
    title: "alabs root",
    places: [
      { placeId: "40audit", kind: "none", description: "Audit reports and a PDF builder.", highlights: [{ id: "a", label: "Audit Reports" }] },
      { placeId: "cockpit-v2", kind: "repo", description: "", highlights: [] },
      {
        placeId: "defiance",
        kind: "repo",
        description: "A source-backed corpus for one season.",
        highlights: [
          { id: "cli", label: "CLI" },
          { id: "query", label: "Query" },
          { id: "web-ui", label: "Web UI" },
        ],
      },
    ],
    knowledge: [
      { role: "context", label: "Context", folder: "context" },
      { role: "wiki", label: "Wiki", folder: "wiki" },
      { role: "definitions", label: "Definitions", folder: "Definitions" },
    ],
    ...over,
  };
}

describe("the rendered file", () => {
  it("passes the existing sanitizer with every place and knowledge folder as a landmark whose path is its own folder", () => {
    const svg = renderRootSvg(map());
    const parsed = parseView(svg);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.landmarks.map((l) => [l.name, l.note, l.paths, l.badPaths])).toEqual([
      ["40audit", "Audit reports and a PDF builder.", ["40audit"], []],
      ["cockpit-v2", "", ["cockpit-v2"], []],
      ["defiance", "A source-backed corpus for one season.", ["defiance"], []],
      ["Context", "knowledge · context/", ["context"], []],
      ["Wiki", "knowledge · wiki/", ["wiki"], []],
      ["Definitions", "knowledge · Definitions/", ["Definitions"], []],
    ]);
    const serialized = new XMLSerializer().serializeToString(parsed.svg);
    expect(serialized).toContain('data-landmark="defiance"');
    expect(serialized).not.toContain("<script");
  });

  it("shows every place once, zero highlights as a valid node, and up to three highlight labels on one line", () => {
    const svg = renderRootSvg(map());
    expect(svg.match(/data-landmark="defiance"/g)).toHaveLength(1);
    expect(svg.match(/data-landmark="cockpit-v2"/g)).toHaveLength(1);
    expect(svg).toContain("▪ CLI · Query · Web UI");
    expect(svg).toContain("▪ Audit Reports");
    expect(svg).toContain(">GIT<");
    expect(svg).toContain(">FOLDER<");
    expect(svg).toContain("3 work · 3 knowledge");
  });

  it("draws containment only: no arrows, no marker, no cross-place path", () => {
    const svg = renderRootSvg(map());
    expect(svg).not.toContain("marker");
    expect(svg).not.toContain("<defs");
    // The one hairline from the root into the groups is the only path.
    expect(svg.match(/<path /g)).toHaveLength(1);
  });

  it("is deterministic, uses presentation attributes only, and references nothing outside the file", () => {
    const a = renderRootSvg(map());
    const b = renderRootSvg(map());
    expect(a).toBe(b);
    expect(a).not.toMatch(/\b(class|style|href|xlink|onload|onclick)=/);
    expect(a).not.toContain("<image");
    expect(a).not.toContain("<foreignObject");
    expect(a.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toContain("://");
    expect(a).not.toContain("javascript");
    expect(a.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ROOT_MAP_WIDTH} `)).toBe(true);
  });

  it("escapes everything from the map, so no text can add an attribute, an element or a coordinate", () => {
    const hostile = map({
      title: 'x" y="999',
      places: [{ placeId: 'a" x="999', kind: "none", description: '</text><rect x="999"/><script>1</script>', highlights: [{ id: "h", label: '<use href="http://evil"/>' }] }],
    });
    const svg = renderRootSvg(hostile);
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain('x="999"');
    expect(svg).not.toContain("<use");
    expect(svg).not.toContain('href="http');
    expect(svg).toContain("&lt;use href=&quot;http://evil&quot;/&gt;");
    expect(svg).toContain("&lt;script&gt;");
    const parsed = parseView(svg);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.landmarks).toHaveLength(4);
    expect(parsed.landmarks[0].name).toBe('a" x="999');
    expect(parsed.landmarks[0].paths).toEqual(['a" x="999']);
  });

  it("keeps the same coordinates whatever the descriptions and highlights say", () => {
    const rects = (svg: string) => Array.from(svg.matchAll(/<rect [^>]*x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g), (m) => m.slice(1).join(","));
    const plain = renderRootSvg(map());
    const wordy = renderRootSvg(
      map({
        places: map().places.map((p) => ({ ...p, description: "a different and much longer description that wraps onto more than one line of the box", highlights: [{ id: "z", label: "Z".repeat(80) }] })),
      }),
    );
    expect(rects(wordy)).toEqual(rects(plain));
  });

  it("renders an empty root and an empty knowledge group with their sentences", () => {
    const svg = renderRootSvg(map({ places: [], knowledge: [] }));
    expect(svg).toContain("No work here yet.");
    expect(svg).toContain("No knowledge folders yet.");
    expect(svg).toContain("0 work · 0 knowledge");
    const parsed = parseView(svg);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") expect(parsed.landmarks).toEqual([]);
  });

  it("grows with the places: two per row, and the legend and footer at the bottom", () => {
    const heightOf = (svg: string) => Number(svg.match(/viewBox="0 0 \d+ (\d+)"/)?.[1]);
    const one = renderRootSvg(map({ places: map().places.slice(0, 1) }));
    const two = renderRootSvg(map({ places: map().places.slice(0, 2) }));
    const three = renderRootSvg(map());
    expect(heightOf(two)).toBe(heightOf(one));
    expect(heightOf(three)).toBeGreaterThan(heightOf(two));
    expect(three).toContain("git repository");
    expect(three).toContain("views/.root/map.svg · select a place to enter it");
  });
});
