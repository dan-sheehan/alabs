/**
 * The deterministic SVG renderer behind the root Visual View (the Home
 * map): a validated `RootMap` in, the text of `views/.root/map.svg` out.
 * The model never touches this; nothing in the map decides a coordinate,
 * a colour or an element, only what is drawn.
 *
 * Layout, fixed:
 *
 * ```text
 * ALABS ROOT  <title>
 *   │
 *   ├─ WORK · N places        one box per place, two per row, listing order
 *   │     name  KIND / description / ▪ highlight · highlight · highlight
 *   │
 *   └─ KNOWLEDGE              Context · Wiki · Definitions, one box each
 * ```
 *
 * A connector means "contained in this root" and nothing else. No arrows,
 * no other marks: the root map has no cross-place relationships to draw.
 * The output is the Stage 5 contract exactly: plain SVG with presentation
 * attributes, one `<g data-landmark data-note data-path>` per place and per
 * knowledge folder (the path is the folder itself), so the existing
 * sanitizer and the Home surface take it as they take any map, and the file
 * opens in any browser. Everything from the map is escaped.
 */
import { rootViewPath } from "./places";
import { escapeXml } from "./viewRender";
import type { RootMap, RootPlace } from "./rootMap";

export const ROOT_MAP_WIDTH = 760;
const MARGIN = 24;
const GROUP_PAD = 12;
const GROUP_TOP = 22;
const GROUP_GAP = 36;
const COLS = 2;
const BOX_GAP = 12;
const BOX_W = (ROOT_MAP_WIDTH - 2 * MARGIN - 2 * GROUP_PAD - (COLS - 1) * BOX_GAP) / COLS;
const BOX_H = 84;
const KNOW_W = 220;
const KNOW_H = 44;
const ROOT_TOP = 20;
const ROOT_H = 40;
const BUS_X = MARGIN + 20;
const FOOTER = 40;

const BG = "#1b1b1b";
const BOX_FILL = "#1f1f1f";
const BORDER = "#363636";
const LINE_STRONG = "#4a4a4a";
const TEXT = "#d6d6d6";
const STRONG = "#ffffff";
const MUTED = "#8c8c8c";
const DIM = "#5f5f5f";
const GIT = "#3fbfa0";
const FOLDER = "#9a9a9a";
const KNOW = "#9d8cff";
const FONT_UI = "-apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif";
const FONT_MONO = "SF Mono, Menlo, monospace";

const UI_BOLD_PX = 7.2;
const MONO_10_PX = 6.3;
const TAG_PX = 7.9;

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** Word-wrap into at most `lines` lines of `width` characters; the last line is clipped. */
function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else {
      out.push(line);
      line = word;
      if (out.length === lines) break;
    }
  }
  if (out.length < lines && line !== "") out.push(line);
  if (out.length > lines) out.length = lines;
  if (out.length === lines) {
    const rest = text.slice(out.slice(0, -1).join(" ").length).trim();
    if (rest.length > width) out[lines - 1] = clip(rest, width);
  }
  return out;
}

function text(x: number, y: number, body: string, attrs: string): string {
  return `<text x="${x}" y="${y}" ${attrs}>${escapeXml(body)}</text>`;
}

const mono = (size: number, fill: string, extra = "") => `font-family="${FONT_MONO}" font-size="${size}" fill="${fill}"${extra}`;
const tagAttrs = mono(11, DIM, ' letter-spacing="0.12em"');

function kindColour(place: RootPlace): string {
  return place.kind === "repo" ? GIT : FOLDER;
}

function kindTag(place: RootPlace): string {
  return place.kind === "repo" ? "GIT" : place.kind === "linked" ? "LINKED" : "FOLDER";
}

interface Placed {
  height: number;
  workTop: number;
  workBottom: number;
  knowTop: number;
  knowBottom: number;
  boxes: Map<string, { x: number; y: number }>;
  knowBoxes: Map<string, { x: number; y: number }>;
}

/** Every coordinate of the map, from its order alone. */
function place(map: RootMap): Placed {
  const boxes = new Map<string, { x: number; y: number }>();
  const workTop = ROOT_TOP + ROOT_H + 28;
  const rows = Math.max(1, Math.ceil(map.places.length / COLS));
  map.places.forEach((p, i) => {
    boxes.set(p.placeId, {
      x: MARGIN + GROUP_PAD + (i % COLS) * (BOX_W + BOX_GAP),
      y: workTop + GROUP_TOP + Math.floor(i / COLS) * (BOX_H + BOX_GAP),
    });
  });
  const workBottom = workTop + GROUP_TOP + (map.places.length === 0 ? 26 : rows * BOX_H + (rows - 1) * BOX_GAP) + GROUP_PAD;
  const knowTop = workBottom + GROUP_GAP;
  const knowBoxes = new Map<string, { x: number; y: number }>();
  const perRow = Math.max(1, Math.floor((ROOT_MAP_WIDTH - 2 * MARGIN - 2 * GROUP_PAD + BOX_GAP) / (KNOW_W + BOX_GAP)));
  map.knowledge.forEach((k, i) => {
    knowBoxes.set(k.role, {
      x: MARGIN + GROUP_PAD + (i % perRow) * (KNOW_W + BOX_GAP),
      y: knowTop + GROUP_TOP + Math.floor(i / perRow) * (KNOW_H + BOX_GAP),
    });
  });
  const knowRows = Math.max(1, Math.ceil(map.knowledge.length / perRow));
  const knowBottom = knowTop + GROUP_TOP + (map.knowledge.length === 0 ? 26 : knowRows * KNOW_H + (knowRows - 1) * BOX_GAP) + GROUP_PAD;
  return { height: knowBottom + FOOTER, workTop, workBottom, knowTop, knowBottom, boxes, knowBoxes };
}

function renderGroup(label: string, detail: string, top: number, bottom: number): string {
  const labelW = label.length * TAG_PX;
  const tagW = labelW + (detail === "" ? 0 : 12 + detail.length * MONO_10_PX) + 12;
  const parts = [
    `<rect x="${MARGIN}" y="${top}" width="${ROOT_MAP_WIDTH - 2 * MARGIN}" height="${bottom - top}" fill="none" stroke="${BORDER}" stroke-width="1"/>`,
    `<rect x="${MARGIN + 8}" y="${top - 7}" width="${Math.min(tagW, ROOT_MAP_WIDTH - 2 * MARGIN - 16).toFixed(1)}" height="14" fill="${BG}"/>`,
    text(MARGIN + 14, top + 4, label, tagAttrs),
  ];
  if (detail !== "") parts.push(text(MARGIN + 14 + labelW + 12, top + 4, detail, mono(11, MUTED)));
  return parts.join("\n");
}

function renderPlace(p: RootPlace, box: { x: number; y: number }): string {
  const attrs = [`data-landmark="${escapeXml(p.placeId)}"`, `data-note="${escapeXml(p.description)}"`, `data-path="${escapeXml(p.placeId)}"`].join(" ");
  const nameMax = Math.floor((BOX_W - 16 - 60) / UI_BOLD_PX);
  const lineMax = Math.floor((BOX_W - 20) / MONO_10_PX);
  const parts = [
    `<g ${attrs}>`,
    `<rect x="${box.x}" y="${box.y}" width="${BOX_W}" height="${BOX_H}" fill="${BOX_FILL}" stroke="${LINE_STRONG}" stroke-width="1"/>`,
    `<rect x="${box.x}" y="${box.y}" width="3" height="${BOX_H}" fill="${kindColour(p)}"/>`,
    text(box.x + 12, box.y + 19, clip(p.placeId, nameMax), `font-family="${FONT_UI}" font-size="12.5" font-weight="600" fill="${STRONG}"`),
    text(box.x + BOX_W - 8, box.y + 19, kindTag(p), `${tagAttrs} text-anchor="end"`),
  ];
  const lines = p.description === "" ? [] : wrap(p.description, lineMax, 2);
  lines.forEach((line, i) => parts.push(text(box.x + 12, box.y + 37 + i * 15, line, mono(10.5, TEXT))));
  if (p.highlights.length > 0) {
    parts.push(text(box.x + 12, box.y + 73, clip(`▪ ${p.highlights.map((h) => h.label).join(" · ")}`, lineMax), mono(10.5, MUTED)));
  }
  parts.push("</g>");
  return parts.join("\n");
}

function renderKnowledge(role: RootMap["knowledge"][number], box: { x: number; y: number }): string {
  const note = `knowledge · ${role.folder}/`;
  const attrs = [`data-landmark="${escapeXml(role.label)}"`, `data-note="${escapeXml(note)}"`, `data-path="${escapeXml(role.folder)}"`].join(" ");
  return [
    `<g ${attrs}>`,
    `<rect x="${box.x}" y="${box.y}" width="${KNOW_W}" height="${KNOW_H}" fill="${BOX_FILL}" stroke="${LINE_STRONG}" stroke-width="1"/>`,
    `<rect x="${box.x}" y="${box.y}" width="3" height="${KNOW_H}" fill="${KNOW}"/>`,
    text(box.x + 12, box.y + 19, role.label, `font-family="${FONT_UI}" font-size="12.5" font-weight="600" fill="${STRONG}"`),
    text(box.x + 12, box.y + 35, clip(`${role.folder}/`, Math.floor((KNOW_W - 20) / MONO_10_PX)), mono(10, MUTED)),
    "</g>",
  ].join("\n");
}

/** The whole file. Deterministic: the same map gives the same text. */
export function renderRootSvg(map: RootMap): string {
  const placed = place(map);
  const rootW = ROOT_MAP_WIDTH - 2 * MARGIN;
  const head = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ROOT_MAP_WIDTH} ${placed.height}" width="${ROOT_MAP_WIDTH}" height="${placed.height}" font-family="${FONT_UI}">`,
    `<title>${escapeXml(map.title)}</title>`,
    `<desc>${escapeXml(`A map of the alabs root built by alabs from ${rootViewPath().replace(/map\.svg$/, "view.json")}. Each place carries data-landmark, data-note and data-path; the path is the place's own folder. A connector means contained in this root and nothing else.`)}</desc>`,
    `<rect x="0" y="0" width="${ROOT_MAP_WIDTH}" height="${placed.height}" fill="${BG}"/>`,
    // The root node.
    `<rect x="${MARGIN}" y="${ROOT_TOP}" width="${rootW}" height="${ROOT_H}" fill="none" stroke="${LINE_STRONG}" stroke-width="1"/>`,
    `<rect x="${MARGIN + 8}" y="${ROOT_TOP - 7}" width="${("ALABS ROOT".length * TAG_PX + 12).toFixed(1)}" height="14" fill="${BG}"/>`,
    text(MARGIN + 14, ROOT_TOP + 4, "ALABS ROOT", tagAttrs),
    text(MARGIN + 12, ROOT_TOP + 26, clip(map.title, 80), `font-family="${FONT_UI}" font-size="13" font-weight="600" fill="${TEXT}"`),
    text(MARGIN + rootW - 10, ROOT_TOP + 26, `${map.places.length} work · ${map.knowledge.length} knowledge`, `${mono(11, MUTED)} text-anchor="end"`),
    // Containment: one hairline from the root into each group.
    `<path d="M${BUS_X} ${ROOT_TOP + ROOT_H} V${placed.knowTop}" fill="none" stroke="${LINE_STRONG}" stroke-width="1"/>`,
  ];
  const body: string[] = [];
  body.push(renderGroup("WORK", map.places.length === 0 ? "" : `${map.places.length} ${map.places.length === 1 ? "place" : "places"}`, placed.workTop, placed.workBottom));
  if (map.places.length === 0) body.push(text(MARGIN + GROUP_PAD, placed.workTop + GROUP_TOP + 14, "No work here yet.", mono(11, TEXT)));
  for (const p of map.places) {
    const box = placed.boxes.get(p.placeId);
    if (box) body.push(renderPlace(p, box));
  }
  body.push(renderGroup("KNOWLEDGE", "", placed.knowTop, placed.knowBottom));
  if (map.knowledge.length === 0) body.push(text(MARGIN + GROUP_PAD, placed.knowTop + GROUP_TOP + 14, "No knowledge folders yet.", mono(11, TEXT)));
  for (const k of map.knowledge) {
    const box = placed.knowBoxes.get(k.role);
    if (box) body.push(renderKnowledge(k, box));
  }
  // Legend and footer: the kind colours, then where the file lives.
  const ly = placed.height - 14;
  const legend: string[] = [];
  let lx = MARGIN;
  for (const [colour, label] of [
    [GIT, "git repository"],
    [FOLDER, "folder"],
    [KNOW, "knowledge"],
  ] as const) {
    legend.push(`<rect x="${lx}" y="${ly - 8}" width="8" height="8" fill="${colour}"/>`);
    legend.push(text(lx + 12, ly, label, mono(11, MUTED)));
    lx += 12 + label.length * MONO_10_PX + 16;
  }
  const footer = text(ROOT_MAP_WIDTH - MARGIN, ly, `${rootViewPath()} · select a place to enter it`, `${mono(11, DIM)} text-anchor="end"`);
  return [...head, ...body, ...legend, footer, "</svg>", ""].join("\n");
}
