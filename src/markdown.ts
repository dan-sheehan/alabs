/**
 * Rendered Markdown (BUILD_PLAN Step 4, DESIGN.md 6.6). Two stages, both
 * required before anything enters the app DOM:
 *
 * 1. `renderUnsafe`: `marked` with three renderer overrides. Raw HTML tokens
 *    (block and inline) render as nothing; a link renders as `<a data-path>`
 *    only when it is a relative link that resolves to a root-relative path,
 *    otherwise as its text (an `http(s)` link is inert; a scheme, an absolute
 *    path or a fragment is plain text); an image renders as its alt text.
 *    marked escapes every piece of text it emits.
 * 2. `sanitizeHtml`: DOMPurify with a strict allowlist: text tags only and
 *    exactly one attribute, `data-path`. No `href`, `src`, `style`, `class`,
 *    handlers, scripts, frames or images can survive, whatever stage 1 did.
 *
 * The DOM then only ever sees inert markup; the surface routes a click on
 * `a[data-path]` through the shared boundary-checked `openPath`. No server,
 * no asset serving, no size fallback yet (Step 7 measures first).
 */
import DOMPurify, { type Config } from "dompurify";
import { Marked, type Tokens } from "marked";

/** Tags the rendered Markdown may contain. Text structure only. */
export const ALLOWED_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "em",
  "strong",
  "del",
  "br",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
] as const;

/** The one attribute that may survive: the root-relative target of a local link. */
export const ALLOWED_ATTR = ["data-path"] as const;

/** The DOMPurify configuration, exported so a test can assert its shape. */
export const SANITIZE_CONFIG: Config & { RETURN_DOM: false; RETURN_DOM_FRAGMENT: false } = {
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  WHOLE_DOCUMENT: false,
};

/**
 * The root-relative path a Markdown link points at, or null when the link is
 * not a local relative link. `filePath` is the root-relative path of the file
 * the link is written in; a relative href resolves against that file's own
 * folder. Anything with a scheme (`http:`, `mailto:`, `javascript:`), a
 * protocol-relative or absolute path, an empty or fragment-only href, or a
 * path that climbs above the root is not a local link. A trailing fragment or
 * query is dropped; percent-encoding is decoded.
 */
export function resolveLink(filePath: string, href: string): string | null {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("\\")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const cut = raw.split(/[?#]/, 1)[0];
  if (cut === "") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(cut);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const dir = filePath.split("/").slice(0, -1);
  const out = [...dir];
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  if (out.length === 0) return null;
  return out.join("/");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One parser per rendered file, so the link renderer knows the file's own folder. */
function markedFor(filePath: string): Marked {
  return new Marked({
    gfm: true,
    breaks: false,
    pedantic: false,
    async: false,
    renderer: {
      // Raw HTML, block or inline, never reaches the DOM.
      html(): string {
        return "";
      },
      link(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token: Tokens.Link): string {
        const text = this.parser.parseInline(token.tokens);
        const target = resolveLink(filePath, token.href);
        if (target === null) return text;
        return `<a data-path="${escapeAttr(target)}">${text}</a>`;
      },
      image(token: Tokens.Image): string {
        return escapeText(token.text);
      },
    },
  });
}

/**
 * Stage 1: Markdown to HTML with the overrides above. The result is not yet
 * safe for the DOM; `renderMarkdown` sanitizes it. Exported for pure tests.
 */
export function renderUnsafe(text: string, filePath: string): string {
  const out = markedFor(filePath).parse(text);
  return typeof out === "string" ? out : "";
}

/** Stage 2: the strict allowlist. Needs a DOM; throws where there is none. */
export function sanitizeHtml(html: string): string {
  if (!DOMPurify.isSupported) throw new Error("Markdown rendering needs a browser DOM");
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/** Rendered, sanitized HTML for `text`, the contents of the file at `filePath`. */
export function renderMarkdown(text: string, filePath: string): string {
  return sanitizeHtml(renderUnsafe(text, filePath));
}
