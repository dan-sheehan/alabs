/**
 * Pure helpers for the Overview sheet (DESIGN.md 6.5): the README excerpt
 * and the TOP LEVEL rows. Facts from one listing and one file only; nothing
 * here infers anything from names.
 */
import { knownLanguageForFile } from "./language";
import type { Entry, GitInspection, GitOutcome } from "./subject";

/** Drop the ` (os error N)` suffix and the foundation's word for the root, as the notice boundary does. */
function plainReason(reason: string): string {
  return reason
    .replace(/\s*\(os error \d+\)/g, "")
    .replace(/the subject folder/g, "the root folder")
    .replace(/outside the subject/g, "outside the root")
    .trim();
}

/** The excerpt stops at the first paragraph or this many characters, whichever ends first. */
export const EXCERPT_CHARS = 400;
/** TOP LEVEL shows at most this many rows, then one row pointing at the tree. */
export const TOP_LEVEL_ROWS = 40;

/** The README entry of a listing: `README.md` in any letter case, first in listing order; null when there is none. */
export function findReadme(entries: readonly Entry[]): Entry | null {
  return entries.find((e) => !e.is_dir && e.name.toLowerCase() === "readme.md") ?? null;
}

/**
 * The first prose paragraph of a README, cut at `EXCERPT_CHARS` with an
 * ellipsis. Heading lines at the top are skipped so the excerpt is the
 * sentence under the title, not the title. Markdown is left as written; the
 * Markdown tab is a later step.
 */
export function readmeExcerpt(text: string): string {
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const prose = blocks.find((b) => !b.split("\n").every((line) => line.startsWith("#"))) ?? blocks[0] ?? "";
  const oneLine = prose.replace(/\s*\n\s*/g, " ");
  return oneLine.length > EXCERPT_CHARS ? `${oneLine.slice(0, EXCERPT_CHARS).trimEnd()}…` : oneLine;
}

export interface TopLevelRow {
  entry: Entry;
  /** `folder`, or the file type word. */
  kind: string;
}

/** A name-based KIND hint, not proof of readable content. Unknown names are simply files. */
export function fileKind(name: string): string {
  const language = knownLanguageForFile(name);
  return language === null ? "file" : language === "plaintext" ? "text" : language;
}

/** The TOP LEVEL rows in listing order (folders first, as listed), capped, plus how many rows the cap hid. */
export function topLevelRows(entries: readonly Entry[]): { rows: TopLevelRow[]; more: number } {
  const rows = entries.slice(0, TOP_LEVEL_ROWS).map((entry) => ({ entry, kind: entry.is_dir ? "folder" : fileKind(entry.name) }));
  return { rows, more: Math.max(0, entries.length - TOP_LEVEL_ROWS) };
}

/** `3 folders · 2 files` */
export function topLevelSummary(entries: readonly Entry[]): string {
  const folders = entries.filter((e) => e.is_dir).length;
  const files = entries.length - folders;
  return `${folders} ${folders === 1 ? "folder" : "folders"} · ${files} ${files === 1 ? "file" : "files"}`;
}

/** What THIS PLACE shows for KIND (DESIGN.md 6.5), from Home's `.git` check. */
export type PlaceKind = "repo" | "linked" | "none";

export const KIND_TEXT: Record<PlaceKind, string> = {
  repo: "git repository",
  linked: "Linked Git directory · not supported yet",
  none: "folder",
};

/** The DESIGN.md 6.9 copy for a Git fact that is not available, in place of the fact. */
export function gitOutcomeText(outcome: Exclude<GitOutcome<unknown>, { kind: "ok" }>): string {
  switch (outcome.kind) {
    case "timeout":
      return "Git took too long";
    case "too_large":
      return "Git returned too much to show";
    case "failed":
      return `Git could not read this folder: ${outcome.reason}`;
  }
}

/** The text for a whole inspection that yields no facts, or null when it has facts. */
export function gitInspectionText(git: GitInspection): string | null {
  switch (git.kind) {
    case "facts":
      return null;
    case "none":
      return null;
    case "linked":
      return KIND_TEXT.linked;
    case "unavailable":
      return "Git is unavailable on this Mac.";
    case "refused":
      return `Git could not read this folder: ${git.reason}`;
    case "error":
      return `Git could not read this folder: ${plainReason(git.reason)}`;
  }
}

/** The BRANCH cell: the branch name, `detached` when there is none, or the named failure. */
export function branchText(git: GitInspection): string {
  if (git.kind !== "facts") return gitInspectionText(git) ?? "";
  if (git.branch.kind !== "ok") return gitOutcomeText(git.branch);
  return git.branch.value === "" ? "detached" : git.branch.value;
}

/** The LAST cell: `"subject" · 2 days ago`, `no commits yet`, or the named failure. */
export function lastCommitText(git: GitInspection, nowSecs: number): string {
  if (git.kind !== "facts") return gitInspectionText(git) ?? "";
  if (git.last.kind !== "ok") return gitOutcomeText(git.last);
  const commit = git.last.value;
  if (commit === null) return "no commits yet";
  return `"${commit.subject}" · ${relativeTime(commit.time, nowSecs)}`;
}

/** The where-strip readout for a git place: `git · main · 2 days ago`, with only the parts that are known. */
export function whereGitText(git: GitInspection | null, nowSecs: number): string | null {
  if (git === null) return null;
  // A linked .git is not supported yet and a plain folder is not git: the strip says nothing.
  if (git.kind === "none" || git.kind === "error" || git.kind === "linked") return null;
  if (git.kind !== "facts") return "git";
  const parts = ["git"];
  if (git.branch.kind === "ok") parts.push(git.branch.value === "" ? "detached" : git.branch.value);
  if (git.last.kind === "ok" && git.last.value !== null) parts.push(relativeTime(git.last.value.time, nowSecs));
  return parts.join(" · ");
}

/**
 * A spelled-out relative time, never abbreviated (DESIGN.md 6.3): `just
 * now`, `5 minutes ago`, `2 days ago`, `3 weeks ago`, `4 months ago`,
 * `2 years ago`. A time in the future reads `just now`.
 */
export function relativeTime(thenSecs: number, nowSecs: number): string {
  const diff = Math.max(0, Math.floor(nowSecs - thenSecs));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (diff < 60) return "just now";
  if (diff < 3600) return unit(Math.floor(diff / 60), "minute");
  if (diff < 86400) return unit(Math.floor(diff / 3600), "hour");
  if (diff < 14 * 86400) return unit(Math.floor(diff / 86400), "day");
  if (diff < 70 * 86400) return unit(Math.floor(diff / (7 * 86400)), "week");
  if (diff < 365 * 86400) return unit(Math.max(2, Math.floor(diff / (30 * 86400))), "month");
  return unit(Math.floor(diff / (365 * 86400)), "year");
}

/** `3:42 pm`, for the `as of` readout. */
export function clockTime(date: Date): string {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const h = hours % 12 === 0 ? 12 : hours % 12;
  return `${h}:${minutes < 10 ? "0" : ""}${minutes} ${hours < 12 ? "am" : "pm"}`;
}

/** What one Overview read produced: the listing and the README, from one listing and one bounded read. */
export interface OverviewSheet {
  entries: Entry[];
  /** The README entry and its text, or null when there is none; `text` is null when it could not be read. */
  readme: { name: string; relPath: string; text: string | null } | null;
  /** When the listing landed, for the `as of` readout. */
  readAt: Date;
}

export interface OverviewIo {
  listDir: (relPath: string) => Promise<Entry[]>;
  readFile: (relPath: string) => Promise<{ content: string }>;
}

/**
 * Read one place's sheet: one top-level listing and, when a README is
 * listed, one bounded read of it. Nothing else is read and nothing is
 * scanned. Rejects only when the listing fails; a README that cannot be
 * read is reported with `text: null`.
 */
export async function readOverview(io: OverviewIo, prefix: string): Promise<OverviewSheet> {
  const entries = await io.listDir(prefix);
  const readAt = new Date();
  const entry = findReadme(entries);
  if (!entry) return { entries, readme: null, readAt };
  let text: string | null;
  try {
    text = (await io.readFile(entry.rel_path)).content;
  } catch {
    text = null;
  }
  return { entries, readme: { name: entry.name, relPath: entry.rel_path, text }, readAt };
}
