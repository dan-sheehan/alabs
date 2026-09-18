/**
 * The structured map behind an automatic Visual View (post-Stage-1 feature):
 * the one small versioned shape a local model returns, and the validation
 * that decides what of it alabs will render. The model never writes SVG;
 * it returns this JSON, alabs checks every claim against the place, and
 * `viewRender.ts` draws only what survived.
 *
 * ```json
 * {
 *   "version": 1,
 *   "title": "Place name",
 *   "summary": "One factual sentence",
 *   "groups": [{ "id": "validation", "label": "Validation", "note": "…" }],
 *   "landmarks": [{ "id": "corpus-validation", "groupId": "validation", "label": "Corpus validation", "note": "…", "paths": ["src/x.py"] }],
 *   "connections": [{ "from": "a", "to": "b", "label": "validated by", "evidence": [{ "path": "src/x.py", "kind": "call", "anchor": "validate(" }] }]
 * }
 * ```
 *
 * Paths are relative to the place (as the inventory showed them). The saved
 * `view.json` adds `place`, the root child the map belongs to.
 *
 * Two kinds of failure, deliberately different:
 *
 * - The whole answer is rejected when it is not the contract or looks
 *   hostile: unparseable, wrong version, over a count bound, an absolute
 *   or climbing path, a URL, markup in text, an unknown evidence kind.
 *   Nothing is rendered.
 * - One claim is dropped when it is well-formed but not true of the place
 *   or not tied to it: a path that does not exist, an anchor that does not
 *   occur in its file, a landmark whose group id names no group, a
 *   connection whose endpoint names no landmark, a repeated id (the later
 *   one goes, and a connection naming an id that was repeated goes with it
 *   as ambiguous). A small model's slip must not cost a true map its other
 *   twenty claims. The landmark or connection goes; the rest stays. A map
 *   that loses every landmark is rejected.
 *
 * Beyond presence, every connection passes a semantic gate: the evidence
 * must mechanically tie the source landmark to the target landmark, or the
 * connection goes. An anchor that merely exists somewhere is not enough.
 *
 * - import: the evidence file is one of the source's paths and the import
 *   line names the target file's stem as a whole token.
 * - call: the evidence file is one of the source's paths, the anchor holds a
 *   call `identifier(`, and that identifier occurs as a whole token in one of
 *   the target's files.
 * - read, write, config: the evidence file is one of the source's paths and
 *   the anchor names a target file by its path or its basename.
 * - documented, contains: the anchor names the target file; when the
 *   evidence file is not one of the source's paths it must name the source
 *   file too. A related topic is not a relationship.
 *
 * Sparse maps are correct. Nothing here executes or renders anything; it
 * reads files only to look for anchors and identifiers, through the same
 * root-bounded bridge as everything else.
 */

export const MAP_VERSION = 1;
export const MAX_GROUPS = 10;
export const MAX_LANDMARKS = 25;
export const MAX_CONNECTIONS = 40;
export const MAX_PATHS_PER_LANDMARK = 6;
export const MAX_EVIDENCE_PER_CONNECTION = 4;
export const MAX_ID_CHARS = 40;
export const MAX_TITLE_CHARS = 80;
export const MAX_SUMMARY_CHARS = 240;
export const MAX_LABEL_CHARS = 60;
export const MAX_NOTE_CHARS = 160;
export const MIN_ANCHOR_CHARS = 2;
export const MAX_ANCHOR_CHARS = 200;
/** Longest model answer alabs will parse; the JSON of a map at every bound is a fraction of this. */
export const MAX_MODEL_RESPONSE_CHARS = 60_000;

/** The small fixed set of ways one file can support a connection. */
export const EVIDENCE_KINDS = ["import", "call", "read", "write", "config", "documented", "contains"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface MapGroup {
  id: string;
  label: string;
  note: string;
}

export interface MapLandmark {
  id: string;
  groupId: string;
  label: string;
  note: string;
  /** Place-relative paths that exist, deduplicated, in the model's order. */
  paths: string[];
}

export interface MapEvidence {
  path: string;
  kind: EvidenceKind;
  /** An exact substring of the file at `path`, verified. */
  anchor: string;
}

export interface MapConnection {
  from: string;
  to: string;
  label: string;
  evidence: MapEvidence[];
}

export interface ViewMap {
  version: typeof MAP_VERSION;
  /** The root child the map belongs to; set by alabs, never by the model. */
  place: string;
  title: string;
  summary: string;
  groups: MapGroup[];
  landmarks: MapLandmark[];
  connections: MapConnection[];
}

/** Why one evidence item or connection was dropped: bounded categories for tests and diagnostics, never content. */
export const DROP_REASONS = [
  /** A connection endpoint names no kept landmark, or the two are the same. */
  "endpoint",
  /** A second connection between the same two landmarks. */
  "duplicate",
  /** No evidence item survived. */
  "no-evidence",
  /** The evidence path does not exist in the place. */
  "evidence-path",
  /** The anchor does not occur in the evidence file, or is too short or too long. */
  "evidence-anchor",
  /** The evidence file is not one of the source landmark's files. */
  "evidence-ownership",
  /** An import line that does not name the target file. */
  "import-target",
  /** A call anchor with no `identifier(` in it. */
  "call-identifier",
  /** The called identifier occurs in none of the target's files. */
  "call-target",
  /** A read, write or config anchor that names no target file. */
  "target-name",
  /** A documented or contains anchor that does not name both endpoints. */
  "documented-endpoints",
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** What validation dropped as unsupported; each is a count of claims, never their text. */
export interface MapDropped {
  landmarks: number;
  connections: number;
  groups: number;
  /** Evidence items whose path did not exist. */
  paths: number;
  /** Evidence items whose anchor was not in the file. */
  anchors: number;
  /** Evidence items and connections dropped, by reason. */
  reasons: Partial<Record<DropReason, number>>;
}

export type MapValidation =
  | { kind: "ok"; map: ViewMap; dropped: MapDropped }
  /** `reason` is one short fixed category, safe to log. */
  | { kind: "rejected"; reason: string };

export interface MapContext {
  place: string;
  /** Place-relative paths of every file the inventory listed. */
  files: ReadonlySet<string>;
  /** The text of a listed file, or null when it is binary, unreadable or over the read bound. */
  readText: (placeRelPath: string) => Promise<string | null>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The JSON object inside a model answer: a code fence or prose around it is
 * dropped, and the text between the first `{` and the last `}` is what is
 * parsed. Null when there is no object at all.
 */
export function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** A trimmed, single-spaced string without markup, links or control characters; null when the value is not usable text. */
function cleanText(v: unknown, max: number): { kind: "ok"; text: string } | { kind: "hostile" } | { kind: "empty" } {
  if (typeof v !== "string") return { kind: "empty" };
  // eslint-disable-next-line no-control-regex
  if (/[<>]|:\/\/|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return { kind: "hostile" };
  const text = v.replace(/\s+/g, " ").trim();
  if (text === "") return { kind: "empty" };
  return { kind: "ok", text: text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text };
}

/** A usable id: lowercase letters, digits and hyphens, from a model id with spaces or underscores folded. */
function cleanId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return /^[a-z0-9][a-z0-9-]*$/.test(id) && id.length <= MAX_ID_CHARS ? id : null;
}

/**
 * A place-relative path from a model value: trimmed, `./` and `.` segments
 * dropped. `hostile` for anything absolute, climbing, backslashed, a URL or
 * a control character: that is not a mistake about the place, it is a way
 * out of it, and the whole answer is refused for it.
 */
export function cleanMapPath(raw: unknown): { kind: "ok"; path: string } | { kind: "hostile" } | { kind: "empty" } {
  if (typeof raw !== "string") return { kind: "empty" };
  const text = raw.trim();
  if (text === "") return { kind: "empty" };
  // eslint-disable-next-line no-control-regex
  if (text.startsWith("/") || text.includes("\\") || text.includes("://") || /[\u0000-\u001f]/.test(text)) return { kind: "hostile" };
  const out: string[] = [];
  for (const part of text.split("/")) {
    if (part === "..") return { kind: "hostile" };
    if (part === "" || part === ".") continue;
    out.push(part);
  }
  return out.length === 0 ? { kind: "empty" } : { kind: "ok", path: out.join("/") };
}

/** The listed file a clean path names: as given, or with the place's own folder name stripped when the model prefixed it. */
function existingFile(path: string, ctx: MapContext): string | null {
  if (ctx.files.has(path)) return path;
  const prefix = `${ctx.place}/`;
  if (path.startsWith(prefix) && ctx.files.has(path.slice(prefix.length))) return path.slice(prefix.length);
  return null;
}

/** True when `anchor` holds the file stem (basename without its last extension) of one of `paths` as a whole token. */
export function namesTarget(anchor: string, paths: readonly string[]): boolean {
  const tokens = new Set(anchor.toLowerCase().split(/[^a-z0-9_-]+/).filter((t) => t !== ""));
  return paths.some((path) => {
    const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    return tokens.has(stem) || tokens.has(base);
  });
}

/** The whole tokens of a text: runs of letters, digits, `_` and `-`, lowercased. */
function tokensOf(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_-]+/).filter((t) => t !== ""));
}

/**
 * True when `anchor` names one of `paths` outright: the whole path, or the
 * file's basename with its extension (`corpus.json`), or, for a file with no
 * extension (`Makefile`), the basename as a whole token. A stem alone
 * (`config`) is a word, not a name, and does not count here.
 */
export function namesFile(anchor: string, paths: readonly string[]): boolean {
  const tokens = tokensOf(anchor);
  return paths.some((path) => {
    if (anchor.includes(path)) return true;
    const base = path.slice(path.lastIndexOf("/") + 1);
    return base.includes(".") ? anchor.includes(base) : tokens.has(base.toLowerCase());
  });
}

/** The identifier of the first call in `anchor` (`corpus.assemble_corpus(` gives `assemble_corpus`), or null. */
export function callIdentifier(anchor: string): string | null {
  const m = anchor.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  return m ? m[1] : null;
}

/** True when `identifier` occurs in `text` as a whole word. */
export function hasIdentifier(text: string, identifier: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${identifier}(?![A-Za-z0-9_])`).test(text);
}

type Step<T> = { kind: "ok"; value: T } | { kind: "rejected"; reason: string };

const reject = <T>(reason: string): Step<T> => ({ kind: "rejected", reason });

function list(v: unknown, name: string, max: number): Step<unknown[]> {
  if (!Array.isArray(v)) return reject(`missing ${name}`);
  if (v.length > max) return reject(`too many ${name}`);
  return { kind: "ok", value: v };
}

/**
 * Validate one model answer against the place. Structural and hostile
 * problems reject the whole answer; unsupported claims are dropped and
 * counted. Reads only the files that evidence names, once each.
 */
export async function validateMap(text: string, ctx: MapContext): Promise<MapValidation> {
  if (text.length > MAX_MODEL_RESPONSE_CHARS) return { kind: "rejected", reason: "answer too large" };
  const json = extractJson(text);
  if (json === null) return { kind: "rejected", reason: "not JSON" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { kind: "rejected", reason: "not JSON" };
  }
  if (!isRecord(raw)) return { kind: "rejected", reason: "not an object" };
  if (raw.version !== MAP_VERSION) return { kind: "rejected", reason: "unsupported version" };

  const title = cleanText(raw.title, MAX_TITLE_CHARS);
  if (title.kind === "hostile") return { kind: "rejected", reason: "markup or link in text" };
  const summary = cleanText(raw.summary, MAX_SUMMARY_CHARS);
  if (summary.kind === "hostile") return { kind: "rejected", reason: "markup or link in text" };

  const groupsRaw = list(raw.groups, "groups", MAX_GROUPS);
  if (groupsRaw.kind === "rejected") return groupsRaw;
  const landmarksRaw = list(raw.landmarks, "landmarks", MAX_LANDMARKS);
  if (landmarksRaw.kind === "rejected") return landmarksRaw;
  const connectionsRaw = list(raw.connections ?? [], "connections", MAX_CONNECTIONS);
  if (connectionsRaw.kind === "rejected") return connectionsRaw;
  if (groupsRaw.value.length === 0) return { kind: "rejected", reason: "missing groups" };
  if (landmarksRaw.value.length === 0) return { kind: "rejected", reason: "missing landmarks" };

  const dropped: MapDropped = { landmarks: 0, connections: 0, groups: 0, paths: 0, anchors: 0, reasons: {} };
  const drop = (reason: DropReason) => {
    dropped.reasons[reason] = (dropped.reasons[reason] ?? 0) + 1;
  };

  // Groups: ids unique, text clean.
  const groups: MapGroup[] = [];
  const groupIds = new Set<string>();
  for (const g of groupsRaw.value) {
    if (!isRecord(g)) return { kind: "rejected", reason: "missing groups" };
    const id = cleanId(g.id);
    if (id === null) return { kind: "rejected", reason: "missing id" };
    const label = cleanText(g.label, MAX_LABEL_CHARS);
    const note = cleanText(g.note, MAX_NOTE_CHARS);
    if (label.kind === "hostile" || note.kind === "hostile") return { kind: "rejected", reason: "markup or link in text" };
    if (label.kind !== "ok") return { kind: "rejected", reason: "missing label" };
    if (groupIds.has(id)) {
      dropped.groups += 1;
      continue;
    }
    groupIds.add(id);
    groups.push({ id, label: label.text, note: note.kind === "ok" ? note.text : "" });
  }

  // Landmarks: ids unique, group known, paths real (or the landmark goes).
  const landmarks: MapLandmark[] = [];
  const landmarkIds = new Set<string>();
  /** Ids the answer used twice: the later landmark goes, and so does any connection naming the id. */
  const ambiguous = new Set<string>();
  const keptIds = new Set<string>();
  const labels = new Set<string>();
  for (const l of landmarksRaw.value) {
    if (!isRecord(l)) return { kind: "rejected", reason: "missing landmarks" };
    const id = cleanId(l.id);
    if (id === null) return { kind: "rejected", reason: "missing id" };
    const duplicate = landmarkIds.has(id);
    if (duplicate) ambiguous.add(id);
    landmarkIds.add(id);
    const groupId = cleanId(l.groupId);
    const label = cleanText(l.label, MAX_LABEL_CHARS);
    const note = cleanText(l.note, MAX_NOTE_CHARS);
    if (label.kind === "hostile" || note.kind === "hostile") return { kind: "rejected", reason: "markup or link in text" };
    if (label.kind !== "ok") return { kind: "rejected", reason: "missing label" };
    if (!Array.isArray(l.paths)) return { kind: "rejected", reason: "missing paths" };
    const paths: string[] = [];
    for (const p of l.paths) {
      const clean = cleanMapPath(p);
      if (clean.kind === "hostile") return { kind: "rejected", reason: "path is not inside the place" };
      if (clean.kind === "empty") continue;
      const real = existingFile(clean.path, ctx);
      if (real === null) {
        dropped.paths += 1;
        continue;
      }
      if (!paths.includes(real) && paths.length < MAX_PATHS_PER_LANDMARK) paths.push(real);
    }
    const key = label.text.toLowerCase();
    if (duplicate || groupId === null || !groupIds.has(groupId) || paths.length === 0 || labels.has(key)) {
      dropped.landmarks += 1;
      continue;
    }
    labels.add(key);
    keptIds.add(id);
    landmarks.push({ id, groupId, label: label.text, note: note.kind === "ok" ? note.text : "", paths });
  }
  if (landmarks.length === 0) return { kind: "rejected", reason: "no landmark has a real path" };

  // Connections: endpoints known, evidence real and anchored, and the
  // relationship mechanically tied to both landmarks (or the connection goes).
  const pathsOf = new Map(landmarks.map((l) => [l.id, l.paths] as const));
  const connections: MapConnection[] = [];
  const pairs = new Set<string>();
  const texts = new Map<string, string | null>();
  const textOf = async (path: string): Promise<string | null> => {
    if (!texts.has(path)) texts.set(path, await ctx.readText(path));
    return texts.get(path) ?? null;
  };
  /** The semantic gate for one verified evidence item; null when it ties source to target, else why not. */
  const gate = async (kind: EvidenceKind, evidencePath: string, anchor: string, source: readonly string[], target: readonly string[]): Promise<DropReason | null> => {
    const owned = source.includes(evidencePath);
    switch (kind) {
      case "import":
        if (!owned) return "evidence-ownership";
        return namesTarget(anchor, target) ? null : "import-target";
      case "call": {
        if (!owned) return "evidence-ownership";
        const identifier = callIdentifier(anchor);
        if (identifier === null) return "call-identifier";
        for (const path of target) {
          const text = await textOf(path);
          if (text !== null && hasIdentifier(text, identifier)) return null;
        }
        return "call-target";
      }
      case "read":
      case "write":
      case "config":
        if (!owned) return "evidence-ownership";
        return namesFile(anchor, target) ? null : "target-name";
      case "documented":
      case "contains":
        if (!namesFile(anchor, target)) return "documented-endpoints";
        if (!owned && !namesFile(anchor, source)) return "documented-endpoints";
        return null;
    }
  };
  for (const c of connectionsRaw.value) {
    if (!isRecord(c)) return { kind: "rejected", reason: "missing connections" };
    const from = cleanId(c.from);
    const to = cleanId(c.to);
    const label = cleanText(c.label, MAX_LABEL_CHARS);
    if (label.kind === "hostile") return { kind: "rejected", reason: "markup or link in text" };
    if (!Array.isArray(c.evidence)) return { kind: "rejected", reason: "missing evidence" };
    if (c.evidence.length > MAX_EVIDENCE_PER_CONNECTION * 2) return { kind: "rejected", reason: "too many evidence items" };
    const endpointsOk =
      from !== null && to !== null && from !== to && !ambiguous.has(from) && !ambiguous.has(to) && keptIds.has(from) && keptIds.has(to);
    const source = from === null ? [] : (pathsOf.get(from) ?? []);
    const target = to === null ? [] : (pathsOf.get(to) ?? []);
    const evidence: MapEvidence[] = [];
    for (const e of c.evidence) {
      if (!isRecord(e)) return { kind: "rejected", reason: "missing evidence" };
      if (typeof e.kind !== "string" || !(EVIDENCE_KINDS as readonly string[]).includes(e.kind)) {
        return { kind: "rejected", reason: "unknown evidence kind" };
      }
      const clean = cleanMapPath(e.path);
      if (clean.kind === "hostile") return { kind: "rejected", reason: "path is not inside the place" };
      if (typeof e.anchor !== "string") return { kind: "rejected", reason: "missing evidence" };
      // A multi-line anchor (a model copying a whole import block) counts by its first line; an anchor that is too short to mean anything or too long to be one line is unsupported.
      const anchor = (e.anchor.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? "").trim();
      const real = clean.kind === "ok" ? existingFile(clean.path, ctx) : null;
      if (real === null) {
        dropped.paths += 1;
        drop("evidence-path");
        continue;
      }
      const content = anchor.length < MIN_ANCHOR_CHARS || anchor.length > MAX_ANCHOR_CHARS ? null : await textOf(real);
      if (content === null || !content.includes(anchor)) {
        dropped.anchors += 1;
        drop("evidence-anchor");
        continue;
      }
      if (!endpointsOk) continue;
      const kind = e.kind as EvidenceKind;
      const why = await gate(kind, real, anchor, source, target);
      if (why !== null) {
        drop(why);
        continue;
      }
      if (evidence.length < MAX_EVIDENCE_PER_CONNECTION) evidence.push({ path: real, kind, anchor });
    }
    const pair = `${from}\u0000${to}`;
    if (!endpointsOk) {
      dropped.connections += 1;
      drop("endpoint");
      continue;
    }
    if (pairs.has(pair)) {
      dropped.connections += 1;
      drop("duplicate");
      continue;
    }
    if (evidence.length === 0) {
      dropped.connections += 1;
      drop("no-evidence");
      continue;
    }
    pairs.add(pair);
    connections.push({ from, to, label: label.kind === "ok" ? label.text : "", evidence });
  }

  const used = new Set(landmarks.map((l) => l.groupId));
  const keptGroups = groups.filter((g) => used.has(g.id));
  dropped.groups += groups.length - keptGroups.length;

  return {
    kind: "ok",
    map: {
      version: MAP_VERSION,
      place: ctx.place,
      title: title.kind === "ok" ? title.text : ctx.place,
      summary: summary.kind === "ok" ? summary.text : "",
      groups: keptGroups,
      landmarks,
      connections,
    },
    dropped,
  };
}

/** The saved `view.json` text: the validated map, pretty-printed, so it stays readable without alabs. */
export function serializeMap(map: ViewMap): string {
  return JSON.stringify(map, null, 2) + "\n";
}
