/**
 * What Raven is shown of a work place and how it asks for more
 * (`creatures/raven/CREATURE.md`, Workflow): the starting evidence, the
 * actions the model may take one at a time, how each result is written into
 * its working notes, and the fixed prompts. Pure over injected reads;
 * nothing here runs the place, installs anything, touches the network or
 * keeps an index.
 *
 * Starting evidence: the inventory (a bounded file tree), then README and
 * other top-level documentation and the project manifests. Dependency,
 * build and version-control folders never reach the inventory
 * (`view_files.rs`); a file that is not text by name is never read; a file
 * that reads as binary is dropped. A private environment file (`.env`,
 * `.env.*`, `*.env`) is listed by name like any other file but its
 * contents never enter the evidence: not as starting evidence, not through
 * `read`, not as a search hit, not to check an anchor (`isPrivateEnvFile`).
 *
 * Then the model works incrementally. Each call sees the starting
 * evidence and the notes so far and answers with one action, or with the
 * map. `list` shows any subfolder of the place, `search` runs the same
 * literal search as the Search box over the whole place, `read` shows a
 * file from any line. The whole place is never placed in one prompt; the
 * model reaches all of it by asking, within the bounds.
 *
 * The budget is one fixed set of limits, not tuned to any model:
 *
 * | limit | value |
 * | --- | --- |
 * | inventory entries shown | `MAX_INVENTORY_LINES` (300, the walk bound) |
 * | inventory text | `MAX_INVENTORY_CHARS` (8,000) |
 * | starting files read | `MAX_STARTER_FILES` (6): README and manifests |
 * | characters per read | `MAX_FILE_CHARS` (3,000, from the asked line) |
 * | actions in one run | `MAX_ACTIONS` (12) |
 * | notes, starting evidence included | `MAX_EVIDENCE_CHARS` (32,000, about 8,000 tokens) |
 * | listing lines per action | `MAX_LIST_LINES` (200) |
 * | search hits per action | `MAX_SEARCH_HITS` (40) |
 * | model answer | `MAX_MODEL_RESPONSE_CHARS` (60,000, `viewMap.ts`) |
 */
import type { Entry, Inventory, InventoryEntry, SearchResult, SearchSummary } from "./subject";
import { EVIDENCE_KINDS, MAX_GROUPS, MAX_LANDMARKS, MAX_PATHS_PER_LANDMARK } from "./viewMap";

export const MAX_INVENTORY_LINES = 300;
export const MAX_INVENTORY_CHARS = 8_000;
export const MAX_STARTER_FILES = 6;
export const MAX_FILE_CHARS = 3_000;
export const MAX_EVIDENCE_CHARS = 32_000;
export const MAX_ACTIONS = 12;
export const MAX_LIST_LINES = 200;
export const MAX_SEARCH_HITS = 40;
export const MAX_QUERY_CHARS = 200;
/** Files over this size are never read: the head of a huge file rarely explains it. */
export const MAX_READ_BYTES = 512 * 1024;

/** File extensions read as text. Anything else is never read, whatever its contents. */
export const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "rst",
  "adoc",
  "py",
  "pyi",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "rs",
  "go",
  "rb",
  "java",
  "kt",
  "swift",
  "m",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "html",
  "css",
  "scss",
  "vue",
  "svelte",
  "json",
  "toml",
  "yaml",
  "yml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "csv",
  "lua",
  "r",
  "ex",
  "exs",
  "erl",
  "hs",
  "scala",
  "dart",
  "gradle",
  "proto",
  "graphql",
  "tex",
]);

/** Files read as text by exact name (case-insensitive) when they carry no extension. */
export const TEXT_NAMES = new Set(["readme", "license", "makefile", "dockerfile", "procfile", "cmakelists.txt", "justfile", "rakefile", "gemfile", "podfile", ".gitignore", ".editorconfig"]);

/** Manifests: what the place is made of and how it is built. */
const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "cargo.toml",
  "go.mod",
  "gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "package.swift",
  "composer.json",
  "mix.exs",
  "makefile",
  "cmakelists.txt",
  "dockerfile",
  "justfile",
  "procfile",
  "pubspec.yaml",
]);

/** Lock files and generated listings: never evidence. */
const LOCK_NAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "uv.lock", "poetry.lock", "cargo.lock", "gemfile.lock", "composer.lock", "go.sum", "podfile.lock"]);

const ENTRY_STEMS = new Set(["main", "index", "app", "cli", "server", "lib", "mod", "__init__", "__main__", "run", "start"]);

const SOURCE_EXTENSIONS = new Set(["py", "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "rb", "java", "kt", "swift", "m", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "sql", "vue", "svelte", "lua", "ex", "exs", "scala", "dart"]);

const CONFIG_EXTENSIONS = new Set(["toml", "yaml", "yml", "ini", "cfg", "conf", "json"]);

/** Priority tiers, lowest first. */
export type Tier = "docs" | "manifest" | "config" | "entry" | "source" | "test" | "other";

const TIER_ORDER: Tier[] = ["docs", "manifest", "config", "entry", "source", "test", "other"];

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function depth(path: string): number {
  return path.split("/").length - 1;
}

/**
 * True for a file that exists to hold credentials or private environment
 * values, at any depth, by name alone: `.env`, every `.env.*` variant
 * (`.env.local`, `.env.production`, also `.env.example`) and every `*.env`
 * file (`production.env`, `local.env`). Its contents are never shown to the
 * model, whatever it asks. This is a fixed-name rule, not secret detection:
 * nothing looks inside a file.
 */
export function isPrivateEnvFile(path: string): boolean {
  const name = baseName(path).toLowerCase();
  return name.endsWith(".env") || name.startsWith(".env.");
}

/** True for a file alabs will read for evidence, by name alone. */
export function isTextFile(path: string): boolean {
  const name = baseName(path).toLowerCase();
  if (isPrivateEnvFile(name) || LOCK_NAMES.has(name)) return false;
  if (TEXT_NAMES.has(name)) return true;
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  if (TEXT_NAMES.has(stem) && extension(name) === "") return true;
  return TEXT_EXTENSIONS.has(extension(name));
}

/** Which tier a text file belongs to, from its path alone. */
export function tierOf(path: string): Tier {
  const name = baseName(path).toLowerCase();
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  const ext = extension(name);
  const lower = path.toLowerCase();
  const d = depth(path);
  if (stem === "readme" || ((ext === "md" || ext === "markdown" || ext === "rst" || ext === "txt" || ext === "adoc") && (d <= 1 || lower.startsWith("docs/") || lower.startsWith("doc/")))) return "docs";
  if (MANIFEST_NAMES.has(name)) return "manifest";
  if (/(^|\/)(tests?|spec|__tests__|fixtures?)(\/|$)/.test(lower) || /(^|[._-])(test|spec)s?([._-]|$)/.test(stem)) return "test";
  // Configuration wires the place together; a JSON file below the top
  // level is data (a corpus, a fixture, an export) and is read last.
  if (ext === "json" ? d === 0 : CONFIG_EXTENSIONS.has(ext) && d <= 2) return "config";
  if (lower.startsWith(".github/")) return "config";
  if (ENTRY_STEMS.has(stem) && SOURCE_EXTENSIONS.has(ext) && d <= 3) return "entry";
  if (SOURCE_EXTENSIONS.has(ext)) return "source";
  return "other";
}

/** A README sorts before everything; then shallower paths; then the path. */
function compareWithinTier(a: string, b: string): number {
  const ra = baseName(a).toLowerCase().startsWith("readme") ? 0 : 1;
  const rb = baseName(b).toLowerCase().startsWith("readme") ? 0 : 1;
  return ra - rb || depth(a) - depth(b) || a.localeCompare(b);
}

/** One text file the packet may read, in priority order. */
export interface Candidate {
  path: string;
  size: number;
  tier: Tier;
}

/**
 * The readable files of an inventory in priority order: by tier, README
 * first within docs, shallow before deep, then alphabetical. Folders,
 * non-text names, lock files, empty and oversized files are not candidates.
 */
export function candidates(inventory: Inventory): Candidate[] {
  const out: Candidate[] = [];
  for (const entry of inventory.entries) {
    if (entry.is_dir || !isTextFile(entry.path) || entry.size === 0 || entry.size > MAX_READ_BYTES) continue;
    out.push({ path: entry.path, size: entry.size, tier: tierOf(entry.path) });
  }
  out.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || compareWithinTier(a.path, b.path));
  return out;
}

/** The inventory as the model sees it: one line per entry, folders with a trailing `/`, files with their size, bounded. */
export function inventoryText(inventory: Inventory): string {
  const lines: string[] = [];
  let chars = 0;
  let shown = 0;
  for (const entry of inventory.entries.slice(0, MAX_INVENTORY_LINES)) {
    const line = entry.is_dir ? `${entry.path}/` : `${entry.path} (${entry.size} bytes)`;
    if (chars + line.length + 1 > MAX_INVENTORY_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
    shown += 1;
  }
  const total = inventory.entries.length;
  if (shown < total || inventory.truncated) {
    lines.push(`… and more entries not listed (${inventory.files} files and ${inventory.folders} folders were counted${inventory.truncated ? ", listing stopped at a bound" : ""})`);
  }
  return lines.join("\n");
}

/**
 * A file as evidence, from line `from` (1-based), bounded, between markers;
 * the marker says when it was cut and where it started, so the model can
 * ask for the rest with a later `read`.
 */
export function fileExcerpt(path: string, content: string, from = 1): string {
  const whole = content.replace(/\s+$/, "");
  const lines = whole.split("\n");
  const start = Math.min(Math.max(from, 1), Math.max(lines.length, 1));
  const rest = start === 1 ? whole : lines.slice(start - 1).join("\n");
  const where = start === 1 ? "" : `from line ${start.toLocaleString()} of ${lines.length.toLocaleString()}`;
  if (rest.length <= MAX_FILE_CHARS) return `=== FILE ${path}${where ? ` (${where})` : ""} ===\n${rest}\n=== END ${path} ===`;
  const head = rest.slice(0, MAX_FILE_CHARS).trimEnd();
  const shown = head.split("\n").length;
  const cut = `first ${MAX_FILE_CHARS.toLocaleString()} of ${rest.length.toLocaleString()} characters; continue with read from line ${(start + shown).toLocaleString()}`;
  return `=== FILE ${path} (${where ? `${where}, ` : ""}${cut}) ===\n${head}\n=== END ${path} ===`;
}

/** True when the text reads as binary: a NUL byte. The bridge already refused invalid UTF-8. */
export function looksBinary(content: string): boolean {
  return content.includes("\0");
}

/** Reads one listed file, or null for binary, unreadable or oversized. Injected by the pipeline. */
export type ReadText = (placeRelPath: string) => Promise<string | null>;

export interface Packet {
  /** The prompt text after the inventory: the file excerpts, in order. */
  text: string;
  /** The files that entered, in order. */
  files: string[];
  chars: number;
}

/**
 * Read `order` in sequence within the file and character bounds after
 * `already` characters are spoken for, skipping files that read as
 * binary or cannot be read. Deterministic: same order, same bounds, same
 * packet.
 */
export async function readPacket(
  order: readonly string[],
  readText: ReadText,
  already: number,
  maxFiles = MAX_STARTER_FILES,
  maxChars = MAX_EVIDENCE_CHARS,
): Promise<Packet> {
  const parts: string[] = [];
  const files: string[] = [];
  let chars = already;
  const seen = new Set<string>();
  for (const path of order) {
    if (files.length >= maxFiles) break;
    if (seen.has(path)) continue;
    seen.add(path);
    const content = await readText(path);
    if (content === null || looksBinary(content)) continue;
    const excerpt = fileExcerpt(path, content);
    if (chars + excerpt.length + 2 > maxChars) continue;
    parts.push(excerpt);
    files.push(path);
    chars += excerpt.length + 2;
  }
  return { text: parts.join("\n\n"), files, chars };
}

/** Which candidates every packet starts with: README and the manifests, the head of the priority order. */
export function alwaysFirst(list: readonly Candidate[]): string[] {
  const docs = list.filter((c) => c.tier === "docs").slice(0, 3);
  const manifests = list.filter((c) => c.tier === "manifest").slice(0, 3);
  return [...docs, ...manifests].map((c) => c.path);
}

/** The fixed instruction of every Raven call: the actions, the map, and the rule that only shown evidence counts. */
export const MAP_INSTRUCTION = [
  "You describe one local folder for its owner, who wants to understand what is in it and where to look. You are shown the folder's file listing, some of its files between FILE and END markers with their paths, and the results of your earlier actions.",
  "You work step by step. Each answer is exactly one JSON object and nothing else: either one action, or the finished map.",
  'Actions: {"action": "list", "path": "a folder path inside the listing, or \"\" for the top"} shows a folder\'s entries, including ones the listing did not show. {"action": "search", "query": "a word or phrase"} finds every file whose name or lines contain it, anywhere in the folder, case-insensitively. {"action": "read", "path": "a file path", "from": 1} shows a file from that line; use a later "from" to continue a file that was cut.',
  "Use actions to check what you are unsure of: read the entry files and the modules that do the main work, search for how parts refer to each other, read tests and configuration when they explain structure. You have a fixed number of actions and a fixed amount of notes; every result stays in your notes. When the notes explain the folder, or the task line says no more actions, answer with the map.",
  "Use only the supplied evidence. Do not use outside knowledge to fill in facts about this folder. Do not infer a connection because names look related. Omit anything uncertain. Prefer fewer supported claims over more speculative ones.",
  "The map is one JSON object of this exact shape:",
  `{"version": 1, "title": "short name", "summary": "one factual sentence", "groups": [{"id": "kebab-id", "label": "Group name", "note": "one short factual line"}], "landmarks": [{"id": "kebab-id", "groupId": "a group id", "label": "Landmark name", "note": "one short factual line", "paths": ["a path you have seen"]}], "connections": [{"from": "a landmark id", "to": "a landmark id", "label": "two or three words", "evidence": [{"path": "a path you have seen", "kind": "import", "anchor": "an exact substring copied from that file's shown contents"}]}]}`,
  `Rules. Groups are the major parts of the folder, in a sensible reading order, ${"3"} to ${MAX_GROUPS} of them. Landmarks are the things worth knowing inside a group, ${"5"} to ${MAX_LANDMARKS} in all; each names one to ${MAX_PATHS_PER_LANDMARK} real paths you have seen in the listing or in a result. Do not list every file.`,
  `A connection says that one landmark uses, calls, reads, writes, configures or documents another. Add one only when a shown file proves it, and cite that file with an evidence kind from: ${EVIDENCE_KINDS.join(", ")}; the anchor must be copied exactly from the shown contents of that file (an import line, a call, a filename mentioned in a document). For source code, connections are expected, not optional: whenever a shown file imports, calls, reads or writes something that belongs to another landmark, add that connection and cite the exact line (an import line at the top of the file is evidence of kind import: copy the whole line as the anchor). Go through every shown source file for these before answering. A connection without such evidence must be left out. A folder of documents or data may have groups and landmarks and no connections at all; that is a valid answer.`,
  "Every id is lowercase letters, digits and hyphens. Labels are short. Notes are one factual line. Never include markup, links or anything that is not in the evidence.",
].join(" ");

/** The packet head: the place and its inventory. */
export function packetHead(place: string, inventory: Inventory): string {
  return `=== PLACE ${place} ===\n\n=== INVENTORY (${inventory.files} files, ${inventory.folders} folders) ===\n${inventoryText(inventory)}`;
}

/** What one run has left: actions and note characters. */
export interface Left {
  actions: number;
  chars: number;
}

/**
 * One call's prompt: the head, the notes (starting evidence and every
 * result so far, in order), and the task line, which either offers one
 * more action or asks for the map because the actions or the notes are
 * spent.
 */
export function stepPrompt(head: string, notes: readonly string[], left: Left): string {
  const body = notes.length === 0 ? "\n\n=== NO FILE CONTENTS WERE READABLE ===" : `\n\n${notes.join("\n\n")}`;
  const task =
    left.actions <= 0 || left.chars <= 0
      ? "No more actions. Produce the map now as one JSON object of the required shape."
      : `Take one action as {"action": ...} (${left.actions} ${left.actions === 1 ? "action" : "actions"} and ${left.chars.toLocaleString()} note characters left), or produce the map as one JSON object of the required shape.`;
  return `${head}${body}\n\n=== TASK ===\n${task}`;
}

/** What one model answer asks for. `map` carries the whole answer for the validator; `none` is an answer that is neither. */
export type Action = { kind: "list"; path: string } | { kind: "search"; query: string } | { kind: "read"; path: string; from: number } | { kind: "map"; text: string } | { kind: "none"; reason: string };

/**
 * A place-relative path as the model may name one: no leading slash, no
 * backslash, no empty, `.` or `..` component. The empty path is the place
 * itself (only `list` accepts it). Null for anything else.
 */
export function placePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (clean === "") return "";
  if (clean.startsWith("/") || clean.includes("\\") || clean.includes("\0")) return null;
  if (clean.split("/").some((p) => p === "" || p === "." || p === "..")) return null;
  return clean;
}

/** Read one answer as an action or the map. Never throws. */
export function parseAction(answer: string): Action {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return { kind: "none", reason: "not JSON" };
  let raw: unknown;
  try {
    raw = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return { kind: "none", reason: "not JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "none", reason: "not an object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.action !== "string") return "landmarks" in o || "version" in o ? { kind: "map", text: answer } : { kind: "none", reason: "neither an action nor a map" };
  switch (o.action) {
    case "list": {
      const path = placePath(o.path ?? "");
      return path === null ? { kind: "none", reason: "list needs a path inside the folder" } : { kind: "list", path };
    }
    case "search": {
      const query = typeof o.query === "string" ? o.query.trim().slice(0, MAX_QUERY_CHARS) : "";
      return query === "" ? { kind: "none", reason: "search needs a query" } : { kind: "search", query };
    }
    case "read": {
      const path = placePath(o.path);
      if (path === null || path === "") return { kind: "none", reason: "read needs a file path inside the folder" };
      const from = typeof o.from === "number" && Number.isFinite(o.from) && o.from >= 1 ? Math.floor(o.from) : 1;
      return { kind: "read", path, from };
    }
    default:
      return { kind: "none", reason: `unknown action ${String(o.action).slice(0, 20)}` };
  }
}

/** A refused or unusable action as a note, so the model sees what to do instead. */
export function noteText(reason: string): string {
  return `=== ACTION REFUSED ===\n${reason}. Allowed: {"action": "list", "path": ...}, {"action": "search", "query": ...}, {"action": "read", "path": ..., "from": 1}, or the map.`;
}

/** A folder listing as a note: one line per entry, folders with a trailing slash, bounded. */
export function listText(path: string, entries: readonly Entry[], place: string): string {
  const shown = entries.slice(0, MAX_LIST_LINES);
  const lines = shown.map((e) => `${placeRelative(e.rel_path, place)}${e.is_dir ? "/" : ""}`);
  if (entries.length > shown.length) lines.push(`… and ${(entries.length - shown.length).toLocaleString()} more entries not listed`);
  const where = path === "" ? "." : path;
  return `=== LIST ${where} (${entries.length.toLocaleString()} entries) ===\n${lines.length === 0 ? "(empty)" : lines.join("\n")}`;
}

/** Search hits as a note: `path:line: text` per content hit, `path` alone for a name hit, bounded. */
export function searchText(query: string, results: readonly SearchResult[], summary: SearchSummary, place: string): string {
  const shown = results.slice(0, MAX_SEARCH_HITS);
  const lines = shown.map((r) => (r.line === null ? `${placeRelative(r.rel_path, place)} (name)` : `${placeRelative(r.rel_path, place)}:${r.line}: ${r.text ?? ""}`));
  const more = results.length > shown.length || summary.truncated;
  if (more) lines.push(`… more hits not listed (${summary.results.toLocaleString()} found${summary.truncated ? ", search stopped at a bound" : ""}); use a more specific query`);
  return `=== SEARCH "${query}" (${summary.results.toLocaleString()} hits in ${summary.files.toLocaleString()} files) ===\n${lines.length === 0 ? "(no hits)" : lines.join("\n")}`;
}

/** A root-relative path as the model sees it: relative to the place. */
function placeRelative(relPath: string, place: string): string {
  const prefix = `${place}/`;
  return relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
}

export type { InventoryEntry };
