/**
 * The structured map behind the root Visual View (the Home map): the one
 * small versioned shape the selected local model returns for the whole
 * alabs root, the validation that decides what of it alabs renders, the
 * reader for the saved `views/.root/view.json`, and the structural stale
 * check. The model never writes SVG, never names a path and never decides a
 * coordinate; it selects and organizes facts alabs already holds.
 *
 * ```json
 * {
 *   "version": 1,
 *   "title": "alabs root",
 *   "places": [{ "placeId": "defiance", "description": "…", "highlightIds": ["cli", "query"] }],
 *   "knowledge": [{ "role": "Context" }, { "role": "Wiki" }, { "role": "Definitions" }]
 * }
 * ```
 *
 * Every place id and every highlight id is owned by alabs: the evidence
 * (`rootEvidence.ts`) supplies them and the model may only choose among
 * them. Two kinds of failure, deliberately different:
 *
 * - The whole answer is rejected when its inventory is structurally wrong
 *   or it looks hostile: not JSON, another version, a place the root does
 *   not have, a place listed twice, a place left out, a knowledge role that
 *   is not present or is invented, markup, a link, an absolute path or a
 *   control character in any text.
 * - One optional claim is dropped when it is not supported: a highlight id
 *   the place's evidence does not list, a fourth highlight, a description
 *   that uses a word the place's evidence never showed (the canonical
 *   summary or README line takes its place), a present knowledge role the
 *   model left out or repeated (the saved map always holds exactly the
 *   present roles, which alabs knows without the model). A bad highlight
 *   never costs the map its other places.
 *
 * The saved map carries the display text reconstructed from the canonical
 * evidence (labels, kinds), so `view.json` reads as plain facts without
 * alabs and the renderer needs nothing else.
 */
import { isPlaceName, ROLES, roleInfo, type Role, type RootListing } from "./places";
import type { PlaceKind } from "./overviewFacts";

export const ROOT_MAP_VERSION = 1;
/** Most work places one root map holds; a larger root is refused at evidence time, never silently cut. */
export const MAX_ROOT_PLACES = 40;
export const MAX_HIGHLIGHTS = 3;
export const MAX_ROOT_TITLE_CHARS = 60;
export const MAX_DESCRIPTION_CHARS = 120;
export const MAX_HIGHLIGHT_LABEL_CHARS = 60;
export const MAX_ID_CHARS = 40;
/** Longest model answer alabs will parse; the JSON of a map at every bound is a fraction of this. */
export const MAX_ROOT_RESPONSE_CHARS = 20_000;
/** Longest saved `view.json` alabs will read back. */
export const MAX_SAVED_ROOT_CHARS = 200_000;
/** A description word this long or longer must occur in the place's evidence; shorter words are function words. */
export const MIN_CHECKED_WORD_CHARS = 4;

/**
 * Longer words a description may use without the evidence showing them:
 * function words and a few structural verbs that name no part, technology,
 * purpose or quality. A closed list; everything else must come from the
 * place's own evidence.
 */
export const FREE_WORDS = new Set([
  "with", "from", "that", "this", "these", "those", "into", "onto", "over", "under", "about", "which", "where", "when", "while", "what",
  "they", "them", "their", "there", "then", "than", "have", "been", "being", "also", "only", "some", "such", "each", "both", "more", "most",
  "very", "holds", "holding", "contains", "containing", "includes", "including", "made", "makes", "along", "plus", "inside", "within",
  "without", "between", "among", "through", "keeps", "keeping", "stores", "storing", "based", "used", "uses", "using", "built", "builds",
]);

export type HighlightKind = "group" | "landmark" | "folder" | "file";

/** One thing the model may pick as a highlight: an id alabs made, and the canonical label it stands for. */
export interface HighlightCandidate {
  id: string;
  label: string;
  kind: HighlightKind;
}

/** Where a place's facts came from, best first. */
export type EvidenceSource = "view" | "readme" | "listing" | "none";

/** The canonical evidence for one work place, as the model sees it and as validation checks against. */
export interface PlaceEvidence {
  placeId: string;
  kind: PlaceKind;
  hasView: boolean;
  source: EvidenceSource;
  /** The validated child view's title, or the README's first heading; null when neither exists. */
  title: string | null;
  /** The validated child view's summary, or the README's first paragraph; null when neither exists. */
  summary: string | null;
  candidates: HighlightCandidate[];
  /** The exact block the model was shown for this place; a description may use only these words. */
  text: string;
}

export interface RootEvidence {
  /** Every current work place, in listing order. */
  places: PlaceEvidence[];
  /** The knowledge roles present in the root, in `ROLES` order. */
  roles: Role[];
  /** Characters of evidence in all (the prompt body). */
  chars: number;
}

export interface RootHighlight {
  id: string;
  label: string;
}

export interface RootPlace {
  placeId: string;
  kind: PlaceKind;
  /** One short orientation line, or empty. */
  description: string;
  /** Zero to `MAX_HIGHLIGHTS` labels reconstructed from the place's own evidence. */
  highlights: RootHighlight[];
}

export interface RootKnowledge {
  role: Role;
  label: string;
  /** The on-disk folder the role resolved to when the map was built. */
  folder: string;
}

export interface RootMap {
  version: typeof ROOT_MAP_VERSION;
  title: string;
  /** Every work place exactly once, in listing order. */
  places: RootPlace[];
  /** Every present knowledge role exactly once, in `ROLES` order. */
  knowledge: RootKnowledge[];
}

export const ROOT_DROP_REASONS = ["unknown-highlight", "duplicate-highlight", "too-many-highlights", "description-unsupported", "knowledge-omitted", "knowledge-repeated"] as const;
export type RootDropReason = (typeof ROOT_DROP_REASONS)[number];

/** What validation dropped as unsupported: counts of claims, never their text. */
export interface RootDropped {
  highlights: number;
  descriptions: number;
  reasons: Partial<Record<RootDropReason, number>>;
}

export type RootValidation = { kind: "ok"; map: RootMap; dropped: RootDropped } | { kind: "rejected"; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The JSON object inside a model answer: a code fence or prose around it is dropped. Null when there is no object. */
export function extractRootJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Control characters (NUL to US, and DEL): never part of a fact. Built from codes so no escape sequence sits in the source. */
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

/**
 * True for text that must not enter a map at all: markup, a link, an
 * absolute or home path, a backtick or a control character. None of these
 * is a fact about the root; each is a way to say something else.
 */
export function isHostileText(v: string): boolean {
  return /[<>`]|:\/\/|(^|\s)(~|\/[A-Za-z0-9._])/.test(v) || CONTROL_CHARS.test(v);
}

/** A trimmed, single-spaced string, clipped with an ellipsis; `hostile` for text that may not enter a map, `empty` for no usable text. */
export function cleanRootText(v: unknown, max: number): { kind: "ok"; text: string } | { kind: "hostile" } | { kind: "empty" } {
  if (typeof v !== "string") return { kind: "empty" };
  if (isHostileText(v)) return { kind: "hostile" };
  const text = v.replace(/\s+/g, " ").trim();
  if (text === "") return { kind: "empty" };
  return { kind: "ok", text: text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text };
}

/** A candidate id: lowercase letters, digits and hyphens, from a model id with spaces or underscores folded. Null when not usable. */
export function cleanRootId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return /^[a-z0-9][a-z0-9-]*$/.test(id) && id.length <= MAX_ID_CHARS ? id : null;
}

/** A candidate id made from any label: lowercase runs of letters and digits joined by hyphens, bounded; `item` when nothing is left. */
export function slugOf(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID_CHARS)
    .replace(/-+$/, "");
  return slug === "" ? "item" : slug;
}

/** The words of a text that the description gate checks: lowercase runs of letters and digits at least `MIN_CHECKED_WORD_CHARS` long that are not free words. */
export function checkedWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= MIN_CHECKED_WORD_CHARS && !FREE_WORDS.has(w));
}

/**
 * True when every checked word of `description` occurs in `evidence` (a
 * plural or singular of it counts). A description that passes may
 * rephrase the evidence; it cannot introduce a part, a technology or a
 * relationship the evidence never showed.
 */
export function supportedBy(description: string, evidence: string): boolean {
  const words = new Set(evidence.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== ""));
  return checkedWords(description).every((w) => {
    if (words.has(w) || words.has(`${w}s`) || words.has(`${w}es`) || words.has(`${w.replace(/y$/, "")}ies`)) return true;
    if (w.endsWith("ies") && words.has(`${w.slice(0, -3)}y`)) return true;
    if (w.endsWith("es") && words.has(w.slice(0, -2))) return true;
    return w.endsWith("s") && words.has(w.slice(0, -1));
  });
}

/** The knowledge role a model value names: the role key or its label, case-insensitively; null for anything else. */
export function roleFromValue(v: unknown): Role | null {
  if (typeof v !== "string") return null;
  const text = v.trim().toLowerCase();
  return ROLES.find((r) => r.role === text || r.label.toLowerCase() === text)?.role ?? null;
}

/** The canonical description of a place when the model's is dropped or absent: its summary, else its title, else nothing. */
export function canonicalDescription(place: PlaceEvidence): string {
  const summary = cleanRootText(place.summary, MAX_DESCRIPTION_CHARS);
  if (summary.kind === "ok") return summary.text;
  const title = cleanRootText(place.title, MAX_DESCRIPTION_CHARS);
  return title.kind === "ok" ? title.text : "";
}

/**
 * Validate one model answer against the root evidence. The place inventory
 * must be exactly the evidence's, or the answer is rejected; a highlight or
 * a description that is not supported is dropped and counted. Places come
 * out in the evidence's order, whatever order the model used, so the
 * layout is alabs' and deterministic.
 */
export function validateRootMap(text: string, evidence: RootEvidence, folders: Partial<Record<Role, string>> = {}): RootValidation {
  if (text.length > MAX_ROOT_RESPONSE_CHARS) return { kind: "rejected", reason: "answer too large" };
  const json = extractRootJson(text);
  if (json === null) return { kind: "rejected", reason: "not JSON" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { kind: "rejected", reason: "not JSON" };
  }
  if (!isRecord(raw)) return { kind: "rejected", reason: "not an object" };
  if (raw.version !== ROOT_MAP_VERSION) return { kind: "rejected", reason: "unsupported version" };

  const title = cleanRootText(raw.title, MAX_ROOT_TITLE_CHARS);
  if (title.kind === "hostile") return { kind: "rejected", reason: "markup or link in text" };

  if (!Array.isArray(raw.places)) return { kind: "rejected", reason: "missing places" };
  if (!Array.isArray(raw.knowledge)) return { kind: "rejected", reason: "missing knowledge" };

  const dropped: RootDropped = { highlights: 0, descriptions: 0, reasons: {} };
  const drop = (reason: RootDropReason) => {
    dropped.reasons[reason] = (dropped.reasons[reason] ?? 0) + 1;
  };

  // Places: every id known, none twice, none missing.
  const known = new Map(evidence.places.map((p) => [p.placeId, p] as const));
  const answered = new Map<string, { description: string; highlights: RootHighlight[] }>();
  for (const item of raw.places) {
    if (!isRecord(item)) return { kind: "rejected", reason: "missing places" };
    const placeId = typeof item.placeId === "string" ? item.placeId.trim() : "";
    const place = known.get(placeId);
    if (!place) return { kind: "rejected", reason: "unknown place" };
    if (answered.has(placeId)) return { kind: "rejected", reason: "duplicate place" };
    const description = cleanRootText(item.description, MAX_DESCRIPTION_CHARS);
    if (description.kind === "hostile") return { kind: "rejected", reason: "markup or link in text" };
    let line: string;
    if (description.kind === "ok" && supportedBy(description.text, place.text)) line = description.text;
    else {
      if (description.kind === "ok") {
        dropped.descriptions += 1;
        drop("description-unsupported");
      }
      line = canonicalDescription(place);
    }
    const highlights: RootHighlight[] = [];
    const ids = Array.isArray(item.highlightIds) ? item.highlightIds : [];
    for (const rawId of ids) {
      if (typeof rawId === "string" && isHostileText(rawId)) return { kind: "rejected", reason: "markup or link in text" };
      const id = cleanRootId(rawId);
      const candidate = id === null ? undefined : place.candidates.find((c) => c.id === id);
      if (!candidate) {
        dropped.highlights += 1;
        drop("unknown-highlight");
        continue;
      }
      if (highlights.some((h) => h.id === candidate.id)) {
        dropped.highlights += 1;
        drop("duplicate-highlight");
        continue;
      }
      if (highlights.length >= MAX_HIGHLIGHTS) {
        dropped.highlights += 1;
        drop("too-many-highlights");
        continue;
      }
      highlights.push({ id: candidate.id, label: candidate.label });
    }
    answered.set(placeId, { description: line, highlights });
  }
  if (answered.size < known.size) return { kind: "rejected", reason: "missing place" };

  // Knowledge: nothing the root does not have. The present roles are
  // alabs' own certain fact, so the saved map always holds exactly them: a
  // role the model left out or repeated costs nothing (counted), while an
  // invented one rejects the answer as it would an invented place.
  const roles = new Set<Role>();
  for (const item of raw.knowledge) {
    if (!isRecord(item)) return { kind: "rejected", reason: "missing knowledge" };
    if (typeof item.role === "string" && isHostileText(item.role)) return { kind: "rejected", reason: "markup or link in text" };
    const role = roleFromValue(item.role);
    if (role === null || !evidence.roles.includes(role)) return { kind: "rejected", reason: "unknown knowledge role" };
    if (roles.has(role)) drop("knowledge-repeated");
    roles.add(role);
  }
  for (const role of evidence.roles) if (!roles.has(role)) drop("knowledge-omitted");

  return {
    kind: "ok",
    map: {
      version: ROOT_MAP_VERSION,
      title: title.kind === "ok" ? title.text : "alabs root",
      places: evidence.places.map((p) => {
        const a = answered.get(p.placeId);
        return { placeId: p.placeId, kind: p.kind, description: a?.description ?? canonicalDescription(p), highlights: a?.highlights ?? [] };
      }),
      knowledge: evidence.roles.map((role) => ({ role, label: roleInfo(role).label, folder: folders[role] ?? roleInfo(role).folder })),
    },
    dropped,
  };
}

/** The saved `views/.root/view.json` text: the validated map, pretty-printed, so it stays readable without alabs. */
export function serializeRootMap(map: RootMap): string {
  return JSON.stringify(map, null, 2) + "\n";
}

const PLACE_KINDS: PlaceKind[] = ["repo", "linked", "none"];

/**
 * Read a saved `view.json` back, leniently and bounded: alabs' own file,
 * but an ordinary one that may have been edited by hand. A field that is
 * not usable is dropped, not fatal; a place that is not one root child, a
 * role that is not one of the three, or a repeated one, is skipped. Null
 * when the text is not a root map at all.
 */
export function readSavedRootMap(text: string): RootMap | null {
  if (text.length > MAX_SAVED_ROOT_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== ROOT_MAP_VERSION || !Array.isArray(raw.places) || !Array.isArray(raw.knowledge)) return null;
  const title = cleanRootText(raw.title, MAX_ROOT_TITLE_CHARS);
  const places: RootPlace[] = [];
  for (const item of raw.places.slice(0, MAX_ROOT_PLACES)) {
    if (!isRecord(item) || typeof item.placeId !== "string" || !isPlaceName(item.placeId) || item.placeId.startsWith(".")) continue;
    if (places.some((p) => p.placeId === item.placeId)) continue;
    const kind = PLACE_KINDS.includes(item.kind as PlaceKind) ? (item.kind as PlaceKind) : "none";
    const description = cleanRootText(item.description, MAX_DESCRIPTION_CHARS);
    const highlights: RootHighlight[] = [];
    for (const h of Array.isArray(item.highlights) ? item.highlights : []) {
      if (!isRecord(h)) continue;
      const id = cleanRootId(h.id);
      const label = cleanRootText(h.label, MAX_HIGHLIGHT_LABEL_CHARS);
      if (id === null || label.kind !== "ok" || highlights.some((x) => x.id === id)) continue;
      if (highlights.length < MAX_HIGHLIGHTS) highlights.push({ id, label: label.text });
    }
    places.push({ placeId: item.placeId, kind, description: description.kind === "ok" ? description.text : "", highlights });
  }
  const knowledge: RootKnowledge[] = [];
  for (const item of raw.knowledge) {
    if (!isRecord(item)) continue;
    const role = roleFromValue(item.role);
    if (role === null || knowledge.some((k) => k.role === role)) continue;
    const folder = typeof item.folder === "string" && isPlaceName(item.folder) ? item.folder : roleInfo(role).folder;
    knowledge.push({ role, label: roleInfo(role).label, folder });
  }
  knowledge.sort((a, b) => ROLES.findIndex((r) => r.role === a.role) - ROLES.findIndex((r) => r.role === b.role));
  return { version: ROOT_MAP_VERSION, title: title.kind === "ok" ? title.text : "alabs root", places, knowledge };
}

/**
 * The structural stale check, and only that: does the saved map hold
 * exactly the work places and the present knowledge roles the root has
 * now? Nothing inside a place is looked at.
 */
export function rootViewCurrent(saved: RootMap, listing: RootListing): boolean {
  const savedPlaces = saved.places.map((p) => p.placeId).sort();
  const nowPlaces = listing.work.map((p) => p.name).sort();
  if (savedPlaces.length !== nowPlaces.length || savedPlaces.some((p, i) => p !== nowPlaces[i])) return false;
  const savedRoles = saved.knowledge.map((k) => k.role).sort();
  const nowRoles = ROLES.filter(({ role }) => listing.roles[role].kind === "present")
    .map(({ role }) => role)
    .sort();
  return savedRoles.length === nowRoles.length && savedRoles.every((r, i) => r === nowRoles[i]);
}
