// @vitest-environment jsdom
import DOMPurify from "dompurify";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_SVG_ATTR,
  ALLOWED_SVG_TAGS,
  cleanViewPath,
  invalidFailure,
  parseView,
  readFailure,
  removeExternalReferences,
  scanLandmarks,
  SVG_NS,
  SVG_SANITIZE_CONFIG,
} from "./viewSanitize";

// The Visual View sanitizer (BUILD_PLAN Step 2.5 result, Step 5). DOMPurify
// needs a DOM, so this file runs in jsdom, the environment DOMPurify's own
// tests use. Every case asserts the wrong result too: what must not
// survive, and what must.

const VIEW = "views/defiance/map.svg";

const HOSTILE = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" onload="alert(1)">
  <script>alert(2)</script>
  <style>rect { fill: red }</style>
  <defs>
    <marker id="m" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto"><path d="M0 0L4 2L0 4z" fill="#4a4a4a"/></marker>
  </defs>
  <g data-landmark="Validation" data-note="Where every rule runs." data-path="defiance/src/defiance/corpus.py" class="node" style="fill:red" onclick="alert(3)">
    <title>Validation</title>
    <rect x="1" y="1" width="10" height="10" fill="#1b1b1b" stroke="#363636" marker-end="url(#m)"/>
    <rect x="2" y="2" width="1" height="1" fill="url(http://evil.example/x.svg#p)"/>
    <text x="3" y="3" font-family="Menlo" font-size="12">Validation<tspan data-path="defiance/tests/test_corpus.py"> rules</tspan></text>
    <image href="http://evil.example/y.png" width="1" height="1"/>
    <use href="http://evil.example/x.svg#a"/>
    <use xlink:href="#m"/>
    <use href="javascript:alert(4)"/>
    <a href="http://evil.example"><rect x="5" y="5" width="1" height="1"/></a>
    <foreignObject width="10" height="10"><div onmouseover="alert(5)">hi</div></foreignObject>
    <animate attributeName="x" from="0" to="1" dur="1s"/>
    <iframe src="http://evil.example"></iframe>
  </g>
</svg>`;

function ok(text: string) {
  const parsed = parseView(text);
  if (parsed.kind !== "ok") throw new Error(`expected a usable view, got: ${parsed.reason}`);
  return parsed;
}

describe("unsafe content never survives", () => {
  it("removes scripts, event handlers, styles, classes, images, links, foreign content, animation and frames", () => {
    const { svg } = ok(HOSTILE);
    const html = svg.outerHTML;
    for (const bad of ["<script", "alert(", "onload", "onclick", "onmouseover", "<style", "class=", "style=", "<image", "<a ", "foreignObject", "<div", "<animate", "<iframe", "evil.example", "javascript:"]) {
      expect(html, bad).not.toContain(bad);
    }
    expect(svg.querySelector("script, style, image, a, foreignObject, animate, iframe, div")).toBeNull();
  });

  it("keeps the drawing, its presentation attributes, local references and the three data attributes", () => {
    const { svg, landmarks } = ok(HOSTILE);
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(svg.getAttribute("onload")).toBeNull();
    const rect = svg.querySelector("rect");
    expect(rect?.getAttribute("fill")).toBe("#1b1b1b");
    expect(rect?.getAttribute("stroke")).toBe("#363636");
    expect(rect?.getAttribute("marker-end")).toBe("url(#m)");
    expect(svg.querySelector("marker")?.getAttribute("refX")).toBe("2");
    expect(svg.querySelector("text")?.getAttribute("font-family")).toBe("Menlo");
    expect(svg.querySelector("title")?.textContent).toBe("Validation");
    expect(svg.querySelector("text")?.textContent).toBe("Validation rules");
    const group = svg.querySelector("[data-landmark]");
    expect(group?.getAttribute("data-landmark")).toBe("Validation");
    expect(group?.getAttribute("data-note")).toBe("Where every rule runs.");
    expect(group?.getAttribute("data-path")).toBe("defiance/src/defiance/corpus.py");
    expect(svg.querySelector("tspan")?.getAttribute("data-path")).toBe("defiance/tests/test_corpus.py");
    expect(landmarks).toEqual([{ name: "Validation", note: "Where every rule runs.", paths: ["defiance/src/defiance/corpus.py", "defiance/tests/test_corpus.py"], badPaths: [] }]);
  });

  it("external references: stage 1 alone lets an http use href through; stage 2 removes it and every non-local url()", () => {
    const body: Node = DOMPurify.sanitize(HOSTILE, SVG_SANITIZE_CONFIG);
    const svg = (body as Element).querySelector("svg")!;
    const hrefs = () => Array.from(svg.querySelectorAll("use")).map((u) => u.getAttribute("href") ?? u.getAttribute("xlink:href"));
    expect(hrefs()).toContain("http://evil.example/x.svg#a");
    expect(svg.querySelector('[fill^="url(http"]')).not.toBeNull();
    removeExternalReferences(svg);
    expect(hrefs()).toEqual([null, "#m", null]);
    expect(svg.querySelector('[fill^="url(http"]')).toBeNull();
    expect(svg.outerHTML).not.toContain("evil.example");
    // A local url() with quotes and spaces is still local.
    const local = ok('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url( \'#g\' )"/><rect fill="url(#a) url(//x/y)"/></svg>');
    const fills = Array.from(local.svg.querySelectorAll("rect")).map((r) => r.getAttribute("fill"));
    expect(fills).toEqual(["url( '#g' )", null]);
  });

  it("the configuration is the explicit allowlist and nothing else", () => {
    for (const tag of ["script", "style", "foreignObject", "image", "a", "animate", "iframe", "object", "embed", "video", "set", "animateTransform"]) {
      expect(ALLOWED_SVG_TAGS as readonly string[], tag).not.toContain(tag);
    }
    for (const attr of ["class", "style", "onload", "onclick", "xmlns", "src", "srcset", "aria-label", "tabindex", "role"]) {
      expect(ALLOWED_SVG_ATTR as readonly string[], attr).not.toContain(attr);
    }
    expect(ALLOWED_SVG_ATTR).toContain("data-landmark");
    expect(ALLOWED_SVG_ATTR).toContain("data-note");
    expect(ALLOWED_SVG_ATTR).toContain("data-path");
    expect(SVG_SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(false);
    expect(SVG_SANITIZE_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
    expect(SVG_SANITIZE_CONFIG.ALLOW_UNKNOWN_PROTOCOLS).toBe(false);
    expect(SVG_SANITIZE_CONFIG.KEEP_CONTENT).toBe(false);
    expect(SVG_SANITIZE_CONFIG.RETURN_DOM).toBe(true);
    expect(SVG_SANITIZE_CONFIG.WHOLE_DOCUMENT).toBe(false);
    expect(SVG_SANITIZE_CONFIG.ALLOWED_TAGS).toEqual([...ALLOWED_SVG_TAGS]);
    expect(SVG_SANITIZE_CONFIG.ALLOWED_ATTR).toEqual([...ALLOWED_SVG_ATTR]);
  });

  it("a data attribute that is not one of the three is dropped", () => {
    const { svg } = ok('<svg xmlns="http://www.w3.org/2000/svg"><g data-landmark="A" data-other="x" data-src="http://evil.example"><rect/></g></svg>');
    const g = svg.querySelector("g")!;
    expect(g.getAttribute("data-other")).toBeNull();
    expect(g.getAttribute("data-src")).toBeNull();
    expect(g.getAttribute("data-landmark")).toBe("A");
  });
});

describe("malformed views are named, never blank", () => {
  it("an empty file", () => {
    expect(parseView("")).toEqual({ kind: "invalid", reason: "the file is empty" });
    expect(parseView("   \n")).toEqual({ kind: "invalid", reason: "the file is empty" });
  });

  it("a file with no drawing", () => {
    expect(parseView("<p>hello</p>")).toEqual({ kind: "invalid", reason: "no SVG drawing was found in it" });
    expect(parseView("just words")).toEqual({ kind: "invalid", reason: "no SVG drawing was found in it" });
    expect(parseView("<script>alert(1)</script>")).toEqual({ kind: "invalid", reason: "no SVG drawing was found in it" });
  });

  it("two drawings", () => {
    expect(parseView('<svg xmlns="http://www.w3.org/2000/svg"></svg><svg xmlns="http://www.w3.org/2000/svg"></svg>')).toEqual({
      kind: "invalid",
      reason: "it holds more than one top-level drawing",
    });
  });

  it("stray text around one drawing is ignored; an empty drawing has no landmarks", () => {
    const parsed = ok('hello <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg> world');
    expect(parsed.svg.localName).toBe("svg");
    expect(parsed.landmarks).toEqual([]);
  });
});

describe("landmark parsing", () => {
  const MAP = `<svg xmlns="http://www.w3.org/2000/svg">
    <g data-landmark=" Second " data-path="defiance/b.py"><rect/></g>
    <g data-landmark="First" data-note=" one line " data-path="./defiance/a.py">
      <rect/>
      <text data-path="defiance/a.py">dup</text>
      <tspan data-path="defiance/tests/test_a.py"/>
      <g data-landmark="Inner" data-path="defiance/inner.py"><rect data-path="defiance/inner2.py"/></g>
      <g data-path="../outside.md"></g>
      <g data-path="/etc/passwd"></g>
      <g data-path=""></g>
      <g data-path="a//b"></g>
    </g>
    <g data-landmark="" data-path="defiance/ignored.py"><rect/></g>
    <g data-landmark="Bare"><rect/></g>
  </svg>`;

  it("reads name, note and paths in document order, deduplicated, group first, and keeps nested landmarks separate", () => {
    const { landmarks } = ok(MAP);
    expect(landmarks.map((l) => l.name)).toEqual(["Second", "First", "Inner", "Bare"]);
    const first = landmarks[1];
    expect(first.note).toBe("one line");
    expect(first.paths).toEqual(["defiance/a.py", "defiance/tests/test_a.py"]);
    expect(first.badPaths).toEqual(["../outside.md", "/etc/passwd", "", "a//b"]);
    expect(landmarks[2]).toEqual({ name: "Inner", note: "", paths: ["defiance/inner.py", "defiance/inner2.py"], badPaths: [] });
    expect(landmarks[3]).toEqual({ name: "Bare", note: "", paths: [], badPaths: [] });
    // The scan is over the sanitized element, so it sees exactly what the DOM will hold.
    expect(scanLandmarks(ok(MAP).svg)).toEqual(landmarks);
  });

  it("cleanViewPath accepts only root-relative paths", () => {
    expect(cleanViewPath("defiance/src/a.py")).toBe("defiance/src/a.py");
    expect(cleanViewPath("  defiance/a.py  ")).toBe("defiance/a.py");
    expect(cleanViewPath("./defiance/./a.py")).toBe("defiance/a.py");
    expect(cleanViewPath("views/defiance/map.svg")).toBe("views/defiance/map.svg");
    for (const bad of ["", "   ", "/etc/passwd", "../x", "defiance/../wiki/x.md", "a//b", "a\\b", "a/", ".", "a\0b"]) {
      expect(cleanViewPath(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("named failure copy", () => {
  it("missing, too large, unreadable, invalid", () => {
    expect(readFailure("cannot access views/defiance/map.svg: No such file or directory (os error 2)", VIEW)).toEqual({
      kind: "missing",
      text: "View file not found: views/defiance/map.svg",
    });
    expect(readFailure("cannot access views/defiance/map.svg: Not a directory (os error 20)", VIEW).kind).toBe("missing");
    expect(readFailure("file is larger than 2 MB: views/defiance/map.svg", VIEW)).toEqual({ kind: "too-large", text: "View is too large to open in alabs." });
    expect(readFailure("cannot access views/defiance/map.svg: Permission denied (os error 13)", VIEW)).toEqual({
      kind: "unreadable",
      text: "Could not read the view: cannot access views/defiance/map.svg: Permission denied.",
    });
    expect(readFailure("not a UTF-8 text file: views/defiance/map.svg", VIEW).kind).toBe("unreadable");
    expect(readFailure("not a file: views/defiance/map.svg", VIEW).kind).toBe("unreadable");
    expect(invalidFailure("the file is empty", VIEW)).toEqual({
      kind: "invalid",
      text: "Could not show the view: the file is empty. Fix views/defiance/map.svg, then Refresh.",
    });
    // Nothing above says stage, frame, mount or any other never-on-screen word.
    for (const f of [readFailure("cannot access x: Permission denied", VIEW), invalidFailure("no SVG drawing was found in it", VIEW)]) {
      expect(f.text).not.toMatch(/frame|mount|handle|subject|scope/i);
    }
  });
});

/**
 * Four DOMPurify advisories are open against the version Monaco pins
 * (GHSA-c2j3-45gr-mqc4, GHSA-cmwh-pvxp-8882, GHSA-vxr8-fq34-vvx9,
 * GHSA-55q2-fjhq-7xh7). Every one of them needs an option or an API that
 * alabs does not use — `CUSTOM_ELEMENT_HANDLING`, `setConfig`, `clearConfig`
 * with Trusted Types, and `IN_PLACE` — and every one of them acts on the
 * instance whose configuration or hooks were changed.
 *
 * Monaco does use all of them, so what keeps alabs out of reach is that
 * Monaco sanitizes with a copy of DOMPurify it vendors itself rather than
 * with the one alabs imports. That is a fact about someone else's package,
 * so it is pinned here: if a future Monaco shares alabs' instance, these
 * advisories stop being theoretical and this fails.
 */
describe("alabs' sanitizer is its own", () => {
  it("does not share an instance with Monaco, so Monaco's hooks and config cannot reach it", async () => {
    // Monaco ships this copy without type declarations; what is used below
    // is DOMPurify's own surface.
    // @ts-expect-error no declaration file for Monaco's vendored DOMPurify
    const vendored = await import("monaco-editor/base/browser/dompurify/dompurify.js");
    // Only the four surfaces the advisories need, because that is all this
    // test does to it.
    const monaco = vendored.default as {
      addHook(name: string, hook: (node: unknown) => unknown): void;
      setConfig(config: unknown): void;
      removeAllHooks(): void;
      clearConfig(): void;
    };
    expect(monaco).toBeTruthy();
    expect(monaco).not.toBe(DOMPurify);

    // Pollute Monaco's instance the way the advisories describe: a hook that
    // keeps everything, and a configuration that allows every attribute.
    monaco.addHook("uponSanitizeElement", (node) => node);
    monaco.setConfig({ ALLOWED_ATTR: ["onload", "onerror", "href", "xlink:href"], ADD_TAGS: ["script"] });
    try {
      const parsed = parseView(HOSTILE);
      expect(parsed.kind).toBe("ok");
      if (parsed.kind !== "ok") return;
      expect(parsed.svg.querySelector("script")).toBeNull();
      expect(parsed.svg.outerHTML).not.toContain("onload");
      expect(parsed.svg.outerHTML).not.toContain("onerror");
    } finally {
      monaco.removeAllHooks();
      monaco.clearConfig();
    }
  });

  it("uses none of the options the open advisories need", () => {
    const config = SVG_SANITIZE_CONFIG as unknown as Record<string, unknown>;
    for (const option of ["IN_PLACE", "CUSTOM_ELEMENT_HANDLING", "RETURN_TRUSTED_TYPE", "TRUSTED_TYPES_POLICY", "ADD_TAGS", "ADD_ATTR"]) {
      expect(config[option], option).toBeUndefined();
    }
  });
});
