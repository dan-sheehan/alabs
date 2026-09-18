/**
 * The places rule: which children of the alabs root are work places, which
 * are knowledge roles, and which root-relative paths belong to which place.
 * Pure functions over a root listing; nothing here touches the disk.
 */
import type { Entry } from "./subject";

export type Role = "context" | "wiki" | "definitions";

/** The one small table mapping knowledge roles to their default folder names and labels. */
export const ROLES: ReadonlyArray<{ role: Role; folder: string; label: string }> = [
  { role: "context", folder: "context", label: "Context" },
  { role: "wiki", folder: "wiki", label: "Wiki" },
  { role: "definitions", folder: "definitions", label: "Definitions" },
];

/** The root child that holds visual views; never a place. Matched case-insensitively. */
export const VIEWS_FOLDER = "views";

/** The portable Visual View file inside `views/<place>/`: the SVG alabs renders (BUILD_PLAN Step 2.5 result). */
export const VIEW_FILE = "map.svg";

/**
 * The reserved child of `views/` that holds the root Visual View (the Home
 * map). A dot name: `classifyRoot` never lists a dot folder as a work place,
 * so `views/.root/` can never collide with a place's own view folder, and
 * `ownerOfPath` gives it no owner, so it never opens as a place tab.
 */
export const ROOT_VIEW_DIR = ".root";

/** One eligible work place: a real child folder of the root. `name` is its on-disk spelling and its root-relative path. */
export interface Place {
  name: string;
}

export type RoleState =
  /** One folder matched the role; `name` is the on-disk spelling. */
  | { kind: "present"; name: string }
  /** No folder matches; the default name would be created on request. */
  | { kind: "missing" }
  /** Two or more folders match the role case-insensitively; open and create are disabled. */
  | { kind: "conflict"; names: string[] };

export interface RootListing {
  /** Work places, alphabetical case-insensitive (the listing order). */
  work: Place[];
  roles: Record<Role, RoleState>;
}

export const EMPTY_LISTING: RootListing = {
  work: [],
  roles: { context: { kind: "missing" }, wiki: { kind: "missing" }, definitions: { kind: "missing" } },
};

function roleOf(name: string): Role | null {
  const lower = name.toLowerCase();
  return ROLES.find((r) => r.folder === lower)?.role ?? null;
}

/**
 * Classify one root listing. A child is a work place only when it is an
 * eligible directory: not `views/`, not a knowledge-role folder, not
 * dot-prefixed, not a symlink (listed by its own type, so `is_dir` is false),
 * and not a file.
 */
export function classifyRoot(entries: readonly Entry[]): RootListing {
  const work: Place[] = [];
  const matches: Record<Role, string[]> = { context: [], wiki: [], definitions: [] };
  for (const entry of entries) {
    if (!entry.is_dir) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name.toLowerCase() === VIEWS_FOLDER) continue;
    const role = roleOf(entry.name);
    if (role) {
      matches[role].push(entry.name);
      continue;
    }
    work.push({ name: entry.name });
  }
  work.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
  const roles = {} as Record<Role, RoleState>;
  for (const { role } of ROLES) {
    const names = matches[role];
    roles[role] =
      names.length === 0 ? { kind: "missing" } : names.length === 1 ? { kind: "present", name: names[0] } : { kind: "conflict", names };
  }
  return { work, roles };
}

/** Root-relative path of a place's Visual View file, `views/<place>/map.svg`. */
export function visualViewPath(place: string): string {
  return `${VIEWS_FOLDER}/${place}/${VIEW_FILE}`;
}

/** Root-relative path of the root Visual View file, `views/.root/map.svg`. */
export function rootViewPath(): string {
  return `${VIEWS_FOLDER}/${ROOT_VIEW_DIR}/${VIEW_FILE}`;
}

/** Root-relative path of the root Visual View's checked facts, `views/.root/view.json`. */
export function rootViewJsonPath(): string {
  return `${VIEWS_FOLDER}/${ROOT_VIEW_DIR}/view.json`;
}

/** Root-relative path of a place's checked facts, `views/<place>/view.json`, written beside a built map. */
export function placeViewJsonPath(place: string): string {
  return `${VIEWS_FOLDER}/${place}/view.json`;
}

/** The place a Visual View path belongs to (`views/<place>/...` gives `<place>`), or null for any other path. */
export function viewPlaceOf(relPath: string): string | null {
  const parts = relPath.split("/");
  if (parts.length < 3 || parts[0].toLowerCase() !== VIEWS_FOLDER || !isPlaceName(parts[1])) return null;
  return parts[1];
}

/** A scope key as shared by disk and memory. */
export type ScopeKey = "home" | `work:${string}` | `know:${string}`;

export const HOME_KEY: ScopeKey = "home";

export function workKey(place: string): ScopeKey {
  return `work:${place}`;
}

export function knowKey(role: Role): ScopeKey {
  return `know:${role}`;
}

/** The label shown for a knowledge role (`Wiki`), and its default folder name. */
export function roleInfo(role: Role): { folder: string; label: string } {
  const row = ROLES.find((r) => r.role === role);
  return row ? { folder: row.folder, label: row.label } : { folder: role, label: role };
}

/** True for a well-formed scope key: `home`, `work:<name>` or `know:<role>` with a single-component name. */
export function isScopeKey(text: string): text is ScopeKey {
  if (text === HOME_KEY) return true;
  const i = text.indexOf(":");
  if (i < 0) return false;
  const kind = text.slice(0, i);
  const rest = text.slice(i + 1);
  if (kind === "work") return isPlaceName(rest);
  if (kind === "know") return ROLES.some((r) => r.role === rest);
  return false;
}

/** True for a name that can be one root child: one non-empty path component that is not `.` or `..`. */
export function isPlaceName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

/**
 * Which place owns a root-relative path. `views/<place>/**` belongs
 * exclusively to `<place>`; a path under a work place belongs to it; a path
 * under a knowledge-role folder belongs to that role. Anything else (a root
 * file, `views/` itself, a view for a folder that is not a place, a
 * dot-folder) belongs to no place.
 */
export function ownerOfPath(relPath: string, listing: RootListing): ScopeKey | null {
  const parts = relPath.split("/");
  const first = parts[0] ?? "";
  if (first === "" || parts.some((p) => p === "" || p === "." || p === "..")) return null;
  if (first.toLowerCase() === VIEWS_FOLDER) {
    const place = parts[1];
    if (parts.length < 3 || !place) return null;
    return listing.work.some((w) => w.name === place) ? workKey(place) : null;
  }
  if (listing.work.some((w) => w.name === first)) return workKey(first);
  for (const { role } of ROLES) {
    const state = listing.roles[role];
    if (state.kind === "present" && state.name === first) return knowKey(role);
  }
  return null;
}

/** The path shown for a root-relative path inside a place: relative to the place's own folder. */
export function displayPath(relPath: string, prefix: string): string {
  if (prefix && (relPath === prefix || relPath.startsWith(prefix + "/"))) return relPath.slice(prefix.length + 1);
  return relPath;
}
