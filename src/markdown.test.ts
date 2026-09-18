import { describe, expect, it } from "vitest";
import { ALLOWED_ATTR, ALLOWED_TAGS, renderUnsafe, resolveLink, SANITIZE_CONFIG } from "./markdown";

// Stage 1 of the pipeline (marked with the alabs overrides) is pure and
// tested here. Stage 2 (DOMPurify) needs a browser DOM: its configuration is
// asserted here and its behaviour is proved in the browser harness.

const file = "defiance/docs/README.md";

describe("raw HTML never reaches the output", () => {
  it("drops block HTML, scripts and inline tags but keeps their text", () => {
    const html = renderUnsafe("Before\n\n<script>alert(1)</script>\n\n<div onclick=\"x()\">block</div>\n\nAfter <span onmouseover=\"y()\">inline</span> text.", file);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("<div");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onmouseover");
    expect(html).not.toContain("<span");
    expect(html).toContain("<p>Before</p>");
    expect(html).toContain("After inline text.");
  });

  it("drops images written as HTML and event handlers in them", () => {
    const html = renderUnsafe('<img src="x" onerror="alert(1)">\n\n<iframe src="http://x"></iframe>', file);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("http://x");
  });

  it("escapes angle brackets in ordinary text and code", () => {
    const html = renderUnsafe("a < b and `<b>` and\n\n```\n<script>x</script>\n```\n", file);
    expect(html).toContain("a &lt; b");
    expect(html).toContain("<code>&lt;b&gt;</code>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("links", () => {
  it("renders http(s), mailto and javascript links as plain text with no href", () => {
    const html = renderUnsafe(
      "[web](https://example.com) [mail](mailto:a@b.c) [js](javascript:alert(1)) <https://auto.example> https://bare.example [ref][r]\n\n[r]: http://ref.example",
      file,
    );
    expect(html).not.toContain("href");
    expect(html).not.toContain("<a");
    expect(html).toContain("web");
    expect(html).toContain("mail");
    expect(html).toContain("js");
    expect(html).toContain("https://auto.example");
    expect(html).toContain("https://bare.example");
    expect(html).toContain("ref");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("ref.example");
  });

  it("turns a relative link into a data-path resolved against the file's own folder", () => {
    const html = renderUnsafe("[guide](guide.md) [up](../src/main.py) [deep](./a/b.md#section) [sp](my%20file.md?x=1)", file);
    expect(html).toContain('<a data-path="defiance/docs/guide.md">guide</a>');
    expect(html).toContain('<a data-path="defiance/src/main.py">up</a>');
    expect(html).toContain('<a data-path="defiance/docs/a/b.md">deep</a>');
    expect(html).toContain('<a data-path="defiance/docs/my file.md">sp</a>');
    expect(html).not.toContain("href");
  });

  it("a link that climbs above the root, an absolute path or a fragment is plain text", () => {
    const html = renderUnsafe("[out](../../../etc/passwd) [abs](/etc/passwd) [frag](#top) [prot](//evil.example/x)", file);
    expect(html).not.toContain("data-path");
    expect(html).toContain("out");
    expect(html).toContain("abs");
    expect(html).toContain("frag");
    expect(html).toContain("prot");
  });

  it("escapes the data-path value so a crafted target cannot break out of the attribute", () => {
    const html = renderUnsafe('[x](a"onclick="y.md)', file);
    expect(html).not.toContain('"onclick="');
    expect(html).toContain("&quot;");
  });
});

describe("resolveLink", () => {
  it("resolves against the file's folder and normalizes dots", () => {
    expect(resolveLink("defiance/README.md", "docs/x.md")).toBe("defiance/docs/x.md");
    expect(resolveLink("defiance/docs/a.md", "../b.md")).toBe("defiance/b.md");
    expect(resolveLink("defiance/docs/a.md", "../../wiki/c.md")).toBe("wiki/c.md");
    expect(resolveLink("defiance/docs/a.md", "./x/./y.md")).toBe("defiance/docs/x/y.md");
    expect(resolveLink("defiance/README.md", "x.md#frag")).toBe("defiance/x.md");
    expect(resolveLink("defiance/README.md", "  x.md  ")).toBe("defiance/x.md");
  });

  it("refuses everything that is not a local relative path", () => {
    expect(resolveLink("defiance/README.md", "../../x.md")).toBeNull();
    expect(resolveLink("defiance/README.md", "..")).toBeNull();
    expect(resolveLink("defiance/README.md", "/x.md")).toBeNull();
    expect(resolveLink("defiance/README.md", "//host/x.md")).toBeNull();
    expect(resolveLink("defiance/README.md", "https://x/y.md")).toBeNull();
    expect(resolveLink("defiance/README.md", "javascript:alert(1)")).toBeNull();
    expect(resolveLink("defiance/README.md", "file:///etc/passwd")).toBeNull();
    expect(resolveLink("defiance/README.md", "#top")).toBeNull();
    expect(resolveLink("defiance/README.md", "")).toBeNull();
    expect(resolveLink("defiance/README.md", "?q=1")).toBeNull();
    expect(resolveLink("defiance/README.md", "a%00b.md")).toBeNull();
    expect(resolveLink("defiance/README.md", "a\\b.md")).toBeNull();
    expect(resolveLink("defiance/README.md", "%E0%A4%A")).toBeNull();
  });
});

describe("images", () => {
  it("render as their alt text only", () => {
    const html = renderUnsafe("![Architecture diagram](docs/arch.png) and ![](empty.png) and ![remote](https://x/y.png)", file);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("arch.png");
    expect(html).toContain("Architecture diagram");
    expect(html).toContain("remote");
  });
});

describe("the DOMPurify allowlist", () => {
  it("permits text tags and exactly one attribute, and nothing that can load, run or style", () => {
    expect(SANITIZE_CONFIG.ALLOWED_TAGS).toEqual([...ALLOWED_TAGS]);
    expect(SANITIZE_CONFIG.ALLOWED_ATTR).toEqual([...ALLOWED_ATTR]);
    expect(ALLOWED_ATTR).toEqual(["data-path"]);
    for (const tag of ["script", "img", "iframe", "object", "embed", "style", "svg", "math", "form", "input", "button", "link", "meta", "base", "video", "audio"]) {
      expect(ALLOWED_TAGS as readonly string[]).not.toContain(tag);
    }
    expect(SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(false);
    expect(SANITIZE_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
    expect(SANITIZE_CONFIG.ALLOW_UNKNOWN_PROTOCOLS).toBe(false);
    expect(SANITIZE_CONFIG.WHOLE_DOCUMENT).toBe(false);
    expect(SANITIZE_CONFIG.RETURN_DOM).toBe(false);
  });

  it("renders the ordinary structure of a README", () => {
    const html = renderUnsafe("# Title\n\nPara with **bold** and `code`.\n\n- one\n- two\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n", file);
    for (const tag of ["<h1>", "<p>", "<strong>", "<code>", "<ul>", "<li>", "<blockquote>", "<table>", "<th>", "<td>", "<hr>"]) expect(html).toContain(tag);
  });
});
