/**
 * The deterministic SVG renderer behind an automatic Visual View
 * (post-Stage-1 feature): a validated `ViewMap` in, the text of
 * `views/<place>/map.svg` out. The model never touches this; nothing in the
 * map decides a coordinate, a colour or an element, only what is drawn.
 *
 * Layout, fixed: groups stacked top to bottom in the map's order, each a
 * bordered box with its tag on the border; landmarks in rows of three inside
 * their group, in the map's order, each a box with its name, one line of
 * note and its first path; connections as orthogonal hairlines with an
 * arrow, routed through the gaps between rows and the gutters beside the
 * groups so they cross no box. Readable, not pretty.
 *
 * The output is the Stage 5 contract exactly: plain SVG with presentation
 * attributes (no `class`, `style`, script, image, link or external
 * reference), one `<g data-landmark data-note data-path>` per landmark with
 * the remaining paths on nested `<g data-path>` children, root-relative
 * paths (`<place>/…`), so the existing sanitizer, surface and inspector
 * take it as they take a hand-made map. Everything from the map is escaped.
 */
import type { MapConnection, MapLandmark, ViewMap } from "./viewMap";

export const MAP_WIDTH = 760;
const MARGIN = 24;
const GROUP_PAD = 12;
const GROUP_TOP = 22;
const GROUP_GAP = 44;
const BOX_W = 220;
const BOX_H = 62;
const BOX_GAP = 12;
const COLS = 3;
const FOOTER = 34;
/** Bottom of the fixed head (title and one summary line); a second summary line adds a row. */
const HEAD_BOTTOM = 84;
const SUMMARY_LINE = 16;

const BG = "#1b1b1b";
const BOX_FILL = "#1f1f1f";
const BORDER = "#363636";
const LINE_STRONG = "#4a4a4a";
const TEXT = "#d6d6d6";
const STRONG = "#ffffff";
const MUTED = "#8c8c8c";
const DIM = "#5f5f5f";
const FONT_UI = "-apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif";
const FONT_MONO = "SF Mono, Menlo, monospace";

/** Approximate advance per character, for wrapping and tag backgrounds. */
const UI_BOLD_PX = 7.2;
const MONO_10_PX = 6.3;
const MONO_11_PX = 6.7;
const TAG_PX = 7.9;

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Cut `text` to `max` characters with an ellipsis. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** Cut a path to `max` characters from the left, keeping its end. */
function clipPath(path: string, max: number): string {
  return path.length <= max ? path : "…" + path.slice(path.length - max + 1);
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

interface Box {
  x: number;
  y: number;
  group: number;
  row: number;
  col: number;
  lastRow: boolean;
}

interface Placed {
  height: number;
  boxes: Map<string, Box>;
  groupTop: number[];
  groupBottom: number[];
  summaryLines: string[];
}

/** Every coordinate of the map, from its order alone. */
function place(map: ViewMap): Placed {
  const summaryLines = map.summary === "" ? [] : wrap(map.summary, 100, 2);
  let y = HEAD_BOTTOM + Math.max(0, summaryLines.length - 1) * SUMMARY_LINE;
  const boxes = new Map<string, Box>();
  const groupTop: number[] = [];
  const groupBottom: number[] = [];
  map.groups.forEach((group, gi) => {
    const members = map.landmarks.filter((l) => l.groupId === group.id);
    const rows = Math.max(1, Math.ceil(members.length / COLS));
    groupTop.push(y);
    members.forEach((l, j) => {
      const col = j % COLS;
      const row = Math.floor(j / COLS);
      boxes.set(l.id, {
        x: MARGIN + GROUP_PAD + col * (BOX_W + BOX_GAP),
        y: y + GROUP_TOP + row * (BOX_H + BOX_GAP),
        group: gi,
        row,
        col,
        lastRow: row === rows - 1,
      });
    });
    const height = GROUP_TOP + rows * BOX_H + (rows - 1) * BOX_GAP + GROUP_PAD;
    groupBottom.push(y + height);
    y += height + GROUP_GAP;
  });
  return { height: y - GROUP_GAP + FOOTER, boxes, groupTop, groupBottom, summaryLines };
}

function text(x: number, y: number, body: string, attrs: string): string {
  return `<text x="${x}" y="${y}" ${attrs}>${escapeXml(body)}</text>`;
}

const mono = (size: number, fill: string, extra = "") => `font-family="${FONT_MONO}" font-size="${size}" fill="${fill}"${extra}`;

function renderGroup(map: ViewMap, gi: number, placed: Placed): string {
  const group = map.groups[gi];
  const top = placed.groupTop[gi];
  const height = placed.groupBottom[gi] - top;
  const label = clip(group.label.toUpperCase(), 40);
  const note = clip(group.note, 70);
  const labelW = label.length * TAG_PX;
  const tagW = labelW + (note === "" ? 0 : 12 + note.length * MONO_11_PX) + 12;
  const parts = [
    `<rect x="${MARGIN}" y="${top}" width="${MAP_WIDTH - 2 * MARGIN}" height="${height}" fill="none" stroke="${BORDER}" stroke-width="1"/>`,
    `<rect x="${MARGIN + 8}" y="${top - 7}" width="${Math.min(tagW, MAP_WIDTH - 2 * MARGIN - 16).toFixed(1)}" height="14" fill="${BG}"/>`,
    text(MARGIN + 14, top + 4, label, mono(11, DIM, ' letter-spacing="0.12em"')),
  ];
  if (note !== "") parts.push(text(MARGIN + 14 + labelW + 12, top + 4, note, mono(11, MUTED)));
  return parts.join("\n");
}

function renderLandmark(map: ViewMap, landmark: MapLandmark, box: Box): string {
  const [first, ...rest] = landmark.paths;
  const attrs = [`data-landmark="${escapeXml(landmark.label)}"`, `data-note="${escapeXml(landmark.note)}"`, `data-path="${escapeXml(`${map.place}/${first}`)}"`].join(" ");
  const parts = [
    `<g ${attrs}>`,
    `<rect x="${box.x}" y="${box.y}" width="${BOX_W}" height="${BOX_H}" fill="${BOX_FILL}" stroke="${LINE_STRONG}" stroke-width="1"/>`,
    text(box.x + 8, box.y + 18, clip(landmark.label, Math.floor((BOX_W - 16) / UI_BOLD_PX)), `font-family="${FONT_UI}" font-size="12.5" font-weight="600" fill="${STRONG}"`),
  ];
  if (landmark.note !== "") parts.push(text(box.x + 8, box.y + 34, clip(landmark.note, Math.floor((BOX_W - 16) / MONO_10_PX)), mono(10.5, TEXT)));
  parts.push(text(box.x + 8, box.y + 52, clipPath(first, Math.floor((BOX_W - 16) / MONO_10_PX)), mono(10, MUTED)));
  for (const path of rest) parts.push(`<g data-path="${escapeXml(`${map.place}/${path}`)}"></g>`);
  parts.push("</g>");
  return parts.join("\n");
}

/** One connection: an orthogonal path that crosses no box, with its label near the start. */
function renderConnection(c: MapConnection, index: number, placed: Placed): string {
  const a = placed.boxes.get(c.from);
  const b = placed.boxes.get(c.to);
  if (!a || !b) return "";
  const acx = a.x + BOX_W / 2;
  const bcx = b.x + BOX_W / 2;
  const aBottom = a.y + BOX_H;
  const lane = index % 4;
  let d: string;
  let label: [number, number];
  if (a.group === b.group && a.col === b.col && b.row === a.row + 1) {
    // Straight down to the box below.
    d = `M${acx} ${aBottom} V${b.y}`;
    label = [acx + 6, aBottom + 9];
  } else if (b.group === a.group + 1 && a.lastRow && b.row === 0) {
    // Adjacent groups: down through the gap between them.
    const mid = (placed.groupBottom[a.group] + placed.groupTop[b.group]) / 2;
    d = acx === bcx ? `M${acx} ${aBottom} V${b.y}` : `M${acx} ${aBottom} V${mid} H${bcx} V${b.y}`;
    label = [Math.min(acx, bcx) + 6, mid - 4];
  } else {
    // Any other pair: out through the row gap below, along a gutter beside
    // the groups (left when heading down, right otherwise), in through the
    // row gap above the target.
    const down = b.group > a.group || (b.group === a.group && b.row > a.row);
    const gx = down ? MARGIN - 8 - lane * 4 : MAP_WIDTH - MARGIN + 8 + lane * 4;
    d = `M${acx} ${aBottom} V${aBottom + 6} H${gx} V${b.y - 6} H${bcx} V${b.y}`;
    label = [acx + 6, aBottom + 4 + 9];
  }
  const parts = [`<path d="${d}" fill="none" stroke="${LINE_STRONG}" stroke-width="1" marker-end="url(#arrow)"/>`];
  if (c.label !== "") parts.push(text(label[0], label[1], clip(c.label, 24), mono(10, MUTED)));
  return parts.join("\n");
}

/** The whole file. Deterministic: the same map gives the same text. */
export function renderMapSvg(map: ViewMap): string {
  const placed = place(map);
  const head = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_WIDTH} ${placed.height}" width="${MAP_WIDTH}" height="${placed.height}" font-family="${FONT_UI}">`,
    `<title>${escapeXml(map.title)}</title>`,
    `<desc>${escapeXml(`A map of ${map.place} built by alabs from views/${map.place}/view.json. Each landmark carries data-landmark, data-note and data-path; paths are relative to the alabs root. Every arrow cites evidence in view.json.`)}</desc>`,
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L8 4 L0 8 z" fill="${LINE_STRONG}"/></marker></defs>`,
    `<rect x="0" y="0" width="${MAP_WIDTH}" height="${placed.height}" fill="${BG}"/>`,
    text(MARGIN, 30, clip(map.title, 90), `font-family="${FONT_UI}" font-size="14" font-weight="600" fill="${TEXT}"`),
  ];
  placed.summaryLines.forEach((line, i) => head.push(text(MARGIN, 50 + i * SUMMARY_LINE, line, mono(11, MUTED))));
  const body: string[] = [];
  map.groups.forEach((_, gi) => body.push(renderGroup(map, gi, placed)));
  map.connections.forEach((c, i) => body.push(renderConnection(c, i, placed)));
  for (const landmark of map.landmarks) {
    const box = placed.boxes.get(landmark.id);
    if (box) body.push(renderLandmark(map, landmark, box));
  }
  const footer = text(MARGIN, placed.height - 12, `views/${map.place}/map.svg · select a landmark to see its real files`, mono(11, DIM));
  return [...head, ...body, footer, "</svg>", ""].join("\n");
}
