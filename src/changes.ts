/**
 * The Changes tab's pure logic (DESIGN.md 6.9, BUILD_PLAN Step 6): parsing
 * the NUL-delimited listings git wrote, which modes a handoff baseline
 * offers, what each pane of a comparison is, and the final copy for every
 * state. Nothing here runs Git; `Changes.tsx` asks through `gitQuery`.
 *
 * Every mode enumerates files from the endpoints it claims:
 *
 *   Not yet committed          status --porcelain=v1 -z -uall --no-renames
 *   Commits since task started diff --name-status -z --no-renames <baseline>..HEAD
 *   Since task started         diff --name-status -z --no-renames <baseline>
 *                              plus ls-files --others --exclude-standard -z
 */
import type { GitQueryResult } from "./subject";
import type { Baseline } from "./uiState";

/** The plain state of one changed file. `nested` is an untracked repository inside the place: listed, no comparison. */
export type ChangeState = "changed" | "added" | "deleted" | "conflict" | "nested";

export interface ChangeRow {
  /** Place-relative path, as git listed it (a nested repository ends with `/`). */
  path: string;
  state: ChangeState;
}

export type ChangesMode = "status" | "since" | "committed";

export const MODE_LABEL: Record<ChangesMode, string> = {
  status: "Not yet committed",
  since: "Since task started",
  committed: "Commits since task started",
};

export const DIRTY_AT_HANDOFF = "Task started with existing changes. alabs cannot separate earlier edits from changes made after the handoff.";
export const BASELINE_GONE = "Task start is no longer available.";
export const NOT_GIT = "This folder is not a Git repository. Open tabs still show a mark when a file changed on disk.";
export const SELECT_PROMPT = "Select a file to see what changed.";
export const FILE_GONE = "File no longer exists.";
export const BINARY = "Not a text file, so no comparison.";
export const DIRTY_NOTE = "Unsaved edits exist in the editor. This comparison shows the saved file on disk.";
export const READING = "Reading changes…";

/** Split NUL-delimited text into its non-empty records. */
function records(text: string): string[] {
  return text.split("\0").filter((r) => r.length > 0);
}

/** The state of one `status --porcelain=v1` entry from its two status letters. */
export function stateOfStatus(xy: string, path: string): ChangeState {
  if (xy === "??") return path.endsWith("/") ? "nested" : "added";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "conflict";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  return "changed";
}

/**
 * `status --porcelain=v1 -z -uall --no-renames`: one `XY path` record per
 * file, NUL-terminated; paths are written raw, so spaces, quotes and
 * Unicode arrive as they are. Ignored files are not listed. With
 * `--no-renames` there is never a second path.
 */
export function parseStatus(text: string): ChangeRow[] {
  const out: ChangeRow[] = [];
  for (const record of records(text)) {
    if (record.length < 4 || record[2] !== " ") continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    if (path.length === 0) continue;
    out.push({ path, state: stateOfStatus(xy, path) });
  }
  return out;
}

/** The state of one `diff --name-status` letter. `U` is unmerged; `T` (type change) is a change. */
export function stateOfNameStatus(letter: string): ChangeState {
  switch (letter[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "U":
      return "conflict";
    default:
      return "changed";
  }
}

/** `diff --name-status -z --no-renames`: alternating `X` and `path` records. */
export function parseNameStatus(text: string): ChangeRow[] {
  const parts = records(text);
  const out: ChangeRow[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    out.push({ path: parts[i + 1], state: stateOfNameStatus(parts[i]) });
  }
  return out;
}

/** `ls-files --others --exclude-standard -z`: every untracked file is fully added; a nested repository ends with `/`. */
export function parseUntracked(text: string): ChangeRow[] {
  return records(text).map((path) => ({ path, state: path.endsWith("/") ? "nested" : "added" }));
}

/** Rows from two listings, one per path (the first listing wins), in path order. */
export function mergeRows(first: readonly ChangeRow[], second: readonly ChangeRow[]): ChangeRow[] {
  const byPath = new Map<string, ChangeRow>();
  for (const row of [...first, ...second]) if (!byPath.has(row.path)) byPath.set(row.path, row);
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The rows a listing answer holds for `mode`, or null when the answer is not a listing. */
export function rowsOf(mode: ChangesMode, result: GitQueryResult): ChangeRow[] | null {
  if (result.kind === "files") return mode === "status" ? parseStatus(result.text) : parseNameStatus(result.text);
  if (result.kind === "since") return mergeRows(parseNameStatus(result.diff), parseUntracked(result.untracked));
  return null;
}

/** What the header offers for a place's baseline: the mode chips, the sentence under them, and the mode shown first. */
export interface ModeOffer {
  modes: ChangesMode[];
  note: string | null;
  initial: ChangesMode;
}

/**
 * Clean at handoff: `Since task started` compares the baseline with the
 * repository now, committed and uncommitted work alike. Dirty at handoff:
 * alabs cannot separate earlier edits from later ones, so it offers the
 * committed range and the uncommitted listing separately and says so. No
 * baseline: the uncommitted listing only.
 */
export function offerModes(baseline: Baseline | null): ModeOffer {
  if (baseline === null) return { modes: ["status"], note: null, initial: "status" };
  if (baseline.clean) return { modes: ["since", "status"], note: null, initial: "since" };
  return { modes: ["committed", "status"], note: DIRTY_AT_HANDOFF, initial: "status" };
}

/** The pane titles by mode: what the left and the right of the comparison are. */
export function paneTitles(mode: ChangesMode): { left: string; right: string } {
  switch (mode) {
    case "status":
      return { left: "Last commit", right: "On disk" };
    case "since":
      return { left: "Task start", right: "On disk" };
    case "committed":
      return { left: "Task start", right: "Last commit" };
  }
}

export function emptyText(mode: ChangesMode): string {
  return mode === "status" ? "No changed files." : "Nothing has changed since the task started.";
}

/** One pane of a comparison: nothing (an added file), a file in a revision, the file on disk, or a file that is gone. */
export type Side = { kind: "empty" } | { kind: "rev"; rev: string } | { kind: "disk" } | { kind: "gone" };

/** The two panes for `row` in `mode`; null for a nested repository, which has no comparison. */
export function sidesOf(mode: ChangesMode, row: ChangeRow, baseline: Baseline | null): { left: Side; right: Side } | null {
  if (row.state === "nested") return null;
  const start: Side = mode === "status" || baseline === null ? { kind: "rev", rev: "HEAD" } : { kind: "rev", rev: baseline.commit };
  const left: Side = row.state === "added" ? { kind: "empty" } : start;
  const right: Side = row.state === "deleted" ? { kind: "gone" } : mode === "committed" ? { kind: "rev", rev: "HEAD" } : { kind: "disk" };
  return { left, right };
}

/** `changed · src/ingest.py`, `nested repository · sub/` */
export function rowText(row: ChangeRow): string {
  return `${row.state === "nested" ? "nested repository" : row.state} · ${row.path}`;
}

/** The DESIGN.md 6.9 copy for an answer that is not a listing or a blob, or null when it is one. */
export function queryFailureText(result: GitQueryResult): string | null {
  switch (result.kind) {
    case "none":
      return NOT_GIT;
    case "linked":
      return "Linked Git directory · not supported yet";
    case "unavailable":
      return "Git is unavailable on this Mac.";
    case "timeout":
      return "Git took too long.";
    case "too_large":
      return "Git returned too much to show.";
    case "refused":
    case "failed":
      return `Git could not read this folder: ${result.reason}`;
    case "error":
      return `Git could not read this folder: ${result.reason.replace(/\s*\(os error \d+\)/g, "").replace(/outside the subject/g, "outside the root")}`;
    default:
      return null;
  }
}
