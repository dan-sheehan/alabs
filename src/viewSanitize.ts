/**
 * The Visual View artifact (BUILD_PLAN Step 2.5 result, built out in Step
 * 5): what alabs accepts from `views/<place>/map.svg` and how it reads the
 * landmarks out of it.
 *
 * The file is an ordinary SVG that any browser opens. Before any of it
 * enters the app DOM it passes two stages:
 *
 * 1. DOMPurify with an explicit allowlist: the drawing elements below and
 *    presentation, geometry and marker attributes only. No `script`,
 *    `style`, `class`, `foreignObject`, `image`, `a`, animation, event
 *    handler or unknown attribute survives, whatever the file says.
 * 2. alabs' own pass over what is left: `href` and `xlink:href` must be a
 *    fragment (`#id`) and every `url(...)` must be local (`url(#id)`);
 *    anything else is removed. Exactly one `<svg>` root must remain, or the
 *    view is a named failure.
 *
 * The landmark contract: `<g data-landmark="Name" data-note="one line">`
 * with `data-path` on the group and/or its descendants (document order,
 * deduplicated). A path in the file is data. The inspector hands it to the
 * same `openPath` every surface uses, whose owner check and the Rust
 * resolver decide whether it opens. No inspector, script or bridge lives
 * inside the file.
 */
import DOMPurify, { type Config } from "dompurify";
import { failureNotice } from "./notices";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Drawing elements a view may contain, plus text nodes (`#text`, DOMPurify's name for them). Nothing that scripts, styles, embeds or animates. */
export const ALLOWED_SVG_TAGS = [
  "#text",
  "svg",
  "g",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
  "tspan",
  "title",
  "desc",
  "defs",
  "marker",
  "symbol",
  "use",
] as const;

/**
 * Attributes a view may carry: geometry, marker and symbol layout,
 * presentation attributes (authors use these because `class` and `style`
 * are refused), fragment references, and the three landmark data
 * attributes. No `class`, `style`, `on*`, `xmlns` or aria attribute.
 */
export const ALLOWED_SVG_ATTR = [
  "id",
  "viewBox",
  "preserveAspectRatio",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "d",
  "points",
  "dx",
  "dy",
  "rotate",
  "transform",
  "textLength",
  "lengthAdjust",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
  "orient",
  "markerUnits",
  "href",
  "xlink:href",
  "marker-start",
  "marker-mid",
  "marker-end",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "visibility",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "word-spacing",
  "text-anchor",
  "text-decoration",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "white-space",
  "xml:space",
  "paint-order",
  "vector-effect",
  "shape-rendering",
  "text-rendering",
  "pointer-events",
  "overflow",
  "data-landmark",
  "data-note",
  "data-path",
] as const;

/**
 * The DOMPurify configuration for stage 1, exported so a test can assert its
 * shape. The lists are frozen: DOMPurify lowercases a list it is handed in
 * place unless it is frozen, and the declared lists must stay what they say.
 */
export const SVG_SANITIZE_CONFIG: Config & { RETURN_DOM: true } = {
  ALLOWED_TAGS: Object.freeze([...ALLOWED_SVG_TAGS]) as string[],
  ALLOWED_ATTR: Object.freeze([...ALLOWED_SVG_ATTR]) as string[],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: false,
  RETURN_DOM: true,
  WHOLE_DOCUMENT: false,
};

/** One landmark as read from the file: a name, a one-line note, its real root-relative paths, and any path that is not usable. */
export interface Landmark {
  name: string;
  note: string;
  /** Root-relative paths in document order, deduplicated. Ownership is decided by `openPath`, not here. */
  paths: string[];
  /** Attribute values that are not a root-relative path (absolute, climbing, empty, malformed). Shown, never opened. */
  badPaths: string[];
}

export type ViewParse =
  /** The drawing is safe to mount: one `<svg>` element and the landmarks read from it. */
  | { kind: "ok"; svg: SVGSVGElement; landmarks: Landmark[] }
  /** The file is not a usable map; `reason` is plain language for the named state. */
  | { kind: "invalid"; reason: string };

/**
 * A usable root-relative path from a `data-path` value, or null. Trimmed;
 * `.` segments dropped; refuses empty, absolute (`/`), backslashes, NUL,
 * empty segments and `..`.
 */
export function cleanViewPath(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.startsWith("/") || text.includes("\\") || text.includes("\0")) return null;
  const out: string[] = [];
  for (const part of text.split("/")) {
    if (part === "") return null;
    if (part === ".") continue;
    if (part === "..") return null;
    out.push(part);
  }
  return out.length === 0 ? null : out.join("/");
}

/** True for a reference that stays inside the drawing: `#id`, no whitespace. */
function isFragment(value: string): boolean {
  return /^#[^\s#]+$/.test(value.trim());
}

/** True for an attribute value whose every `url(...)` is a local `url(#id)`. */
function urlsAreLocal(value: string): boolean {
  const matches = value.match(/url\([^)]*\)?/gi);
  if (!matches) return true;
  return matches.every((m) => /^url\(\s*["']?#[^\s"')]+["']?\s*\)$/i.test(m));
}

/** Stage 2: remove every reference that could leave the drawing. Mutates the sanitized tree in place. */
export function removeExternalReferences(root: Element): void {
  const walk = (el: Element) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === "href" || name === "xlink:href") {
        if (!isFragment(attr.value)) el.removeAttribute(attr.name);
      } else if (/url\(/i.test(attr.value) && !urlsAreLocal(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(root);
}

/** The landmarks of a sanitized drawing, in document order. A group with an empty name is not a landmark. */
export function scanLandmarks(svg: Element): Landmark[] {
  const out: Landmark[] = [];
  for (const el of Array.from(svg.querySelectorAll("[data-landmark]"))) {
    const name = (el.getAttribute("data-landmark") ?? "").trim();
    if (name === "") continue;
    const note = (el.getAttribute("data-note") ?? "").trim();
    const paths: string[] = [];
    const badPaths: string[] = [];
    const carriers = [el, ...Array.from(el.querySelectorAll("[data-path]"))];
    for (const carrier of carriers) {
      // A nested landmark's paths belong to it, not to the outer one.
      if (carrier.closest("[data-landmark]") !== el) continue;
      const raw = carrier.getAttribute("data-path");
      if (raw === null) continue;
      const clean = cleanViewPath(raw);
      if (clean === null) {
        if (!badPaths.includes(raw)) badPaths.push(raw);
      } else if (!paths.includes(clean)) paths.push(clean);
    }
    out.push({ name, note, paths, badPaths });
  }
  return out;
}

/**
 * Both stages over the text of a view file. Needs a DOM; throws where there
 * is none. The returned element belongs to the sanitizer's own document
 * until the caller appends it.
 */
export function parseView(text: string): ViewParse {
  if (!DOMPurify.isSupported) throw new Error("Visual View rendering needs a browser DOM");
  if (text.trim() === "") return { kind: "invalid", reason: "the file is empty" };
  const body: Node = DOMPurify.sanitize(text, SVG_SANITIZE_CONFIG);
  // Only elements count; stray text around the drawing is inert and ignored.
  const elements = Array.from(body.childNodes).filter((n): n is Element => n.nodeType === 1);
  if (elements.length === 0) return { kind: "invalid", reason: "no SVG drawing was found in it" };
  if (elements.length > 1) return { kind: "invalid", reason: "it holds more than one top-level drawing" };
  const svg = elements[0];
  if (svg.namespaceURI !== SVG_NS || svg.localName !== "svg") return { kind: "invalid", reason: "its top-level element is not an SVG drawing" };
  removeExternalReferences(svg);
  return { kind: "ok", svg: svg as SVGSVGElement, landmarks: scanLandmarks(svg) };
}

/** The named failure states of a Visual View (DESIGN.md 6.8). `text` is the copy shown in place of the drawing. */
export interface ViewFailure {
  kind: "missing" | "too-large" | "unreadable" | "invalid";
  text: string;
}

/** The named state for a read that failed, from the raw Rust reason and the view's root-relative path. */
export function readFailure(reason: unknown, viewPath: string): ViewFailure {
  const raw = String(reason);
  if (/No such file or directory|\(os error 2\)|\(os error 20\)|Not a directory/i.test(raw)) {
    return { kind: "missing", text: `View file not found: ${viewPath}` };
  }
  if (/^file is larger than \d+ MB/.test(raw)) return { kind: "too-large", text: "View is too large to open in alabs." };
  return { kind: "unreadable", text: `Could not read the view: ${failureNotice(raw).text}` };
}

/** The named state for a file that was read but is not a usable map. */
export function invalidFailure(reason: string, viewPath: string): ViewFailure {
  return { kind: "invalid", text: `Could not show the view: ${reason}. Fix ${viewPath}, then Refresh.` };
}
