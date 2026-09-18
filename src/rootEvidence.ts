/**
 * The bounded evidence behind the root Visual View (the Home map): what of
 * the alabs root the selected local model is shown, built from facts alabs
 * already holds, and the one fixed prompt. Pure over injected reads;
 * nothing here walks a repository, runs anything or keeps an index.
 *
 * Per work place, best evidence first, one tier only:
 *
 * 1. its identity: the folder name and its kind (git repository or folder);
 * 2. `views/<place>/view.json` when it exists and reads as a validated
 *    place map: its title, summary, group labels and landmark labels;
 * 3. otherwise the Overview facts, from one listing and one bounded README
 *    read: the README's first heading and first paragraph, and the
 *    top-level folder and file names.
 *
 * The knowledge places enter as their roles only. Nothing inside a place
 * is rescanned: the place-level view already understood the repository;
 * the root map understands the forest from those facts.
 *
 * Limits, fixed and chosen for a personal root of a handful of places:
 *
 * | limit | value |
 * | --- | --- |
 * | work places | `MAX_ROOT_PLACES` (40, `rootMap.ts`); more refuses the build |
 * | group candidates per place | `MAX_GROUP_CANDIDATES` (6) |
 * | landmark candidates per place | `MAX_LANDMARK_CANDIDATES` (12) |
 * | top-level candidates per fallback place | `MAX_TOP_LEVEL_CANDIDATES` (12) |
 * | README title | `MAX_README_TITLE_CHARS` (80) |
 * | README excerpt | `EXCERPT_CHARS` (400, the Overview's own bound) |
 * | text from one place | `MAX_PLACE_CHARS` (1,500) |
 * | evidence in all | `MAX_ROOT_EVIDENCE_CHARS` (24,000); past it a place keeps only its identity and title |
 * | model answer | `MAX_ROOT_RESPONSE_CHARS` (20,000, `rootMap.ts`) |
 */
import type { HomeData } from "./launch";
import { placeViewJsonPath, ROLES, roleInfo, type Role } from "./places";
import { EXCERPT_CHARS, KIND_TEXT, readmeExcerpt, readOverview, type OverviewIo, type PlaceKind } from "./overviewFacts";
import { MAX_GROUPS, MAX_LANDMARKS, MAP_VERSION } from "./viewMap";
import {
  cleanRootId,
  cleanRootText,
  MAX_HIGHLIGHT_LABEL_CHARS,
  MAX_HIGHLIGHTS,
  MAX_ROOT_PLACES,
  slugOf,
  type HighlightCandidate,
  type PlaceEvidence,
  type RootEvidence,
} from "./rootMap";

export const MAX_GROUP_CANDIDATES = 6;
export const MAX_LANDMARK_CANDIDATES = 12;
export const MAX_TOP_LEVEL_CANDIDATES = 12;
export const MAX_README_TITLE_CHARS = 80;
export const MAX_SUMMARY_CHARS = EXCERPT_CHARS;
export const MAX_TITLE_CHARS = 80;
export const MAX_PLACE_CHARS = 1_500;
export const MAX_ROOT_EVIDENCE_CHARS = 24_000;

export type RootEvidenceIo = OverviewIo;

/** What a saved place map contributes: its validated title, summary and the labels of its parts. */
export interface ChildView {
  title: string | null;
  summary: string | null;
  groups: Array<{ id: string; label: string }>;
  landmarks: Array<{ id: string; label: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read a place's saved `view.json` as evidence: only a version-1 map for
 * this very place counts, and only its clean text. Anything else (another
 * place's map, a hand-edited file that is not a map, markup in a label)
 * gives null and the place falls back to its Overview facts.
 */
export function readChildView(text: string, place: string): ChildView | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== MAP_VERSION || raw.place !== place) return null;
  if (!Array.isArray(raw.groups) || !Array.isArray(raw.landmarks)) return null;
  const title = cleanRootText(raw.title, MAX_TITLE_CHARS);
  const summary = cleanRootText(raw.summary, MAX_SUMMARY_CHARS);
  const labelled = (items: unknown[], max: number) => {
    const out: Array<{ id: string; label: string }> = [];
    for (const item of items.slice(0, max)) {
      if (!isRecord(item)) continue;
      const id = cleanRootId(item.id);
      const label = cleanRootText(item.label, MAX_HIGHLIGHT_LABEL_CHARS);
      if (id === null || label.kind !== "ok" || out.some((o) => o.id === id)) continue;
      out.push({ id, label: label.text });
    }
    return out;
  };
  return {
    title: title.kind === "ok" ? title.text : null,
    summary: summary.kind === "ok" ? summary.text : null,
    groups: labelled(raw.groups, MAX_GROUPS),
    landmarks: labelled(raw.landmarks, MAX_LANDMARKS),
  };
}

/** The README's first heading line, without its `#`s, or null. */
export function readmeTitle(text: string): string | null {
  const line = text.split(/\r?\n/).find((l) => /^#{1,6}\s+\S/.test(l));
  if (!line) return null;
  const clean = cleanRootText(line.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, ""), MAX_README_TITLE_CHARS);
  return clean.kind === "ok" ? clean.text : null;
}

/** Add `candidate` unless its id is taken; a taken id gets a numeric suffix so every candidate is reachable. */
function addCandidate(list: HighlightCandidate[], id: string, label: string, kind: HighlightCandidate["kind"]) {
  let unique = id;
  let n = 2;
  while (list.some((c) => c.id === unique)) unique = `${id}-${n++}`;
  list.push({ id: unique, label, kind });
}

/** The candidates a validated child view offers: its landmarks under their own ids, its groups as `group-<id>`. */
export function viewCandidates(view: ChildView): HighlightCandidate[] {
  const out: HighlightCandidate[] = [];
  for (const l of view.landmarks.slice(0, MAX_LANDMARK_CANDIDATES)) addCandidate(out, l.id, l.label, "landmark");
  for (const g of view.groups.slice(0, MAX_GROUP_CANDIDATES)) addCandidate(out, `group-${g.id}`, g.label, "group");
  return out;
}

/** The candidates a fallback place offers: its top-level folders and files, as listed, by a slug of each name. */
export function listingCandidates(entries: ReadonlyArray<{ name: string; is_dir: boolean }>): HighlightCandidate[] {
  const out: HighlightCandidate[] = [];
  for (const e of entries.slice(0, MAX_TOP_LEVEL_CANDIDATES)) {
    const label = cleanRootText(e.is_dir ? `${e.name}/` : e.name, MAX_HIGHLIGHT_LABEL_CHARS);
    if (label.kind !== "ok") continue;
    addCandidate(out, slugOf(e.name), label.text, e.is_dir ? "folder" : "file");
  }
  return out;
}

/** The block the model is shown for one place, bounded to `MAX_PLACE_CHARS`; candidate lines are the first thing cut. */
export function placeBlock(place: Omit<PlaceEvidence, "text">, withCandidates = true): { text: string; candidates: HighlightCandidate[] } {
  const lines = [`=== WORK PLACE ${place.placeId} ===`, `kind: ${KIND_TEXT[place.kind]}`];
  if (place.title !== null) lines.push(`title: ${place.title}`);
  if (place.summary !== null) lines.push(`summary: ${place.summary}`);
  let chars = lines.join("\n").length;
  const kept: HighlightCandidate[] = [];
  if (withCandidates && place.candidates.length > 0) {
    const head = `highlight candidates (choose at most ${MAX_HIGHLIGHTS} by id, or none):`;
    lines.push(head);
    chars += head.length + 1;
    for (const c of place.candidates) {
      const line = `- ${c.id} · ${c.kind} · ${c.label}`;
      if (chars + line.length + 1 > MAX_PLACE_CHARS) break;
      lines.push(line);
      chars += line.length + 1;
      kept.push(c);
    }
    if (kept.length === 0) lines.pop();
  }
  return { text: lines.join("\n"), candidates: kept };
}

/** The evidence of one place: its saved view when it reads as one, else its Overview facts, else its identity alone. */
export async function placeEvidence(io: RootEvidenceIo, placeId: string, kind: PlaceKind, hasView: boolean): Promise<Omit<PlaceEvidence, "text">> {
  const base = { placeId, kind, hasView };
  try {
    const { content } = await io.readFile(placeViewJsonPath(placeId));
    const view = readChildView(content, placeId);
    if (view) return { ...base, source: "view", title: view.title, summary: view.summary, candidates: viewCandidates(view) };
  } catch {
    // No saved view, or one that cannot be read: the Overview facts decide.
  }
  try {
    const sheet = await readOverview(io, placeId);
    const readme = sheet.readme?.text ?? null;
    const title = readme === null ? null : readmeTitle(readme);
    const excerpt = readme === null ? null : cleanRootText(readmeExcerpt(readme), MAX_SUMMARY_CHARS);
    const summary = excerpt !== null && excerpt.kind === "ok" && excerpt.text !== title ? excerpt.text : null;
    return { ...base, source: readme === null ? "listing" : "readme", title, summary, candidates: listingCandidates(sheet.entries) };
  } catch {
    return { ...base, source: "none", title: null, summary: null, candidates: [] };
  }
}

/**
 * The evidence of the whole root from Home's data: every work place in
 * listing order and every present knowledge role. Rejects a root over
 * `MAX_ROOT_PLACES`. Past `MAX_ROOT_EVIDENCE_CHARS` a place keeps its
 * identity, title and summary and offers no candidates, so every place
 * still enters and the packet stays bounded.
 */
export async function collectRootEvidence(io: RootEvidenceIo, home: HomeData): Promise<RootEvidence> {
  const work = home.listing.work;
  if (work.length > MAX_ROOT_PLACES) throw new Error(`too many places: ${work.length} over ${MAX_ROOT_PLACES}`);
  const kindOf = (name: string): PlaceKind => home.git.get(name) ?? "none";
  const gathered = await Promise.all(work.map((p) => placeEvidence(io, p.name, kindOf(p.name), home.views.has(p.name))));
  const places: PlaceEvidence[] = [];
  let chars = 0;
  for (const g of gathered) {
    let block = placeBlock(g);
    if (chars + block.text.length + 2 > MAX_ROOT_EVIDENCE_CHARS) block = placeBlock(g, false);
    chars += block.text.length + 2;
    places.push({ ...g, candidates: block.candidates, text: block.text });
  }
  const roles = ROLES.filter(({ role }) => home.listing.roles[role].kind === "present").map(({ role }) => role);
  return { places, roles, chars };
}

/** The on-disk folder of each present role, for the saved map. */
export function roleFolders(home: HomeData): Partial<Record<Role, string>> {
  const out: Partial<Record<Role, string>> = {};
  for (const { role } of ROLES) {
    const state = home.listing.roles[role];
    if (state.kind === "present") out[role] = state.name;
  }
  return out;
}

/** The fixed instruction of the root call. */
export const ROOT_INSTRUCTION = [
  "You describe one local folder of folders, the alabs root, for its owner, who wants to see what work is here and what each place is.",
  "You are shown one block per work place with its kind, its title and summary when known, and a list of highlight candidates with ids; then the knowledge places present.",
  "Use only the supplied evidence. Do not use outside knowledge. Every supplied work place must appear exactly once, with its placeId exactly as given; do not create, rename, merge or omit places.",
  `Choose highlightIds only from that place's own candidate ids, at most ${MAX_HIGHLIGHTS}, picking the parts that best tell the owner what the place is made of; prefer fewer highlights over unsupported ones, and an empty list is a valid answer.`,
  "The description is one short factual line built from that place's own title, summary and candidate labels; do not add parts, technologies, purposes or qualities the evidence does not show, and do not describe how places relate to each other.",
  "knowledge lists the knowledge places shown, each once, by role.",
  'Answer with one JSON object and nothing else, of this exact shape: {"version": 1, "title": "alabs root", "places": [{"placeId": "a supplied place id", "description": "one short factual line", "highlightIds": ["a candidate id"]}], "knowledge": [{"role": "Context"}]}.',
  "Do not output SVG, HTML, markup, links, commands or paths.",
].join(" ");

/** The root call's prompt: the head, one block per place, the knowledge places, the task. */
export function rootPrompt(evidence: RootEvidence): string {
  const names = evidence.places.map((p) => p.placeId);
  const head = [
    "=== ALABS ROOT ===",
    `work places: ${names.length}${names.length === 0 ? "" : ` (${names.join(", ")})`}`,
    `knowledge places: ${evidence.roles.length === 0 ? "none" : evidence.roles.map((r) => roleInfo(r).label).join(", ")}`,
  ].join("\n");
  const blocks = evidence.places.map((p) => p.text);
  const knowledge = `=== KNOWLEDGE ===\n${evidence.roles.length === 0 ? "none" : evidence.roles.map((r) => `- ${roleInfo(r).label}`).join("\n")}`;
  const roleShape = JSON.stringify({ knowledge: evidence.roles.map((r) => ({ role: roleInfo(r).label })) });
  return [head, ...blocks, knowledge, `=== TASK ===\nReturn the root map as one JSON object of the required shape. Include this exact knowledge field (objects, not strings): ${roleShape}`].join("\n\n");
}
