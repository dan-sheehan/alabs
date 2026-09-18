/**
 * The notice boundary: every reason that reaches the notice line passes
 * through here. Known Rust reason prefixes are rewritten into the design
 * copy; anything else gets a plain-language line and the technical text is
 * handed back for the log. Foundation Rust error strings are not renamed.
 */

export interface Notice {
  /** What the user sees. */
  text: string;
  error: boolean;
  /** Technical text for `alabs.log` when the shown text does not carry it. */
  log: string | null;
}

/**
 * Drop the ` (os error N)` suffix Rust appends to io errors (the words before
 * it already say what happened) and rewrite the foundation's word for the
 * root, which never appears on screen.
 */
function plainReason(reason: string): string {
  return reason
    .replace(/\s*\(os error \d+\)/g, "")
    .replace(/^no subject is open$/, "No alabs root is open. Choose your alabs root folder")
    .replace(/the subject folder/g, "the root folder")
    .trim();
}

/** Failure of opening a folder as the root, with the real path the user chose. */
export function rootOpenNotice(path: string, reason: string): Notice {
  const raw = String(reason);
  if (raw.includes("overlaps the alabs application data folder")) {
    return { text: "This folder overlaps alabs' own settings folder. Choose another root.", error: true, log: raw };
  }
  // Rust says `cannot open <path>: <why>` or `not a folder: <path>`; keep only the why.
  let why = plainReason(raw);
  const colon = why.indexOf(`${path}: `);
  if (why.startsWith("cannot open ") && colon >= 0) why = why.slice(colon + path.length + 2);
  else if (why.startsWith("not a folder")) why = "not a folder";
  return { text: `Could not open ${path}: ${why}.`, error: true, log: raw };
}

/** A failed file action inside the root, e.g. a refused open, save, create, move or Trash. */
export function failureNotice(reason: unknown): Notice {
  const raw = String(reason);
  const outside = raw.match(/^path is outside the subject: (.*)$/);
  if (outside) return { text: `This file is not inside any alabs place: ${outside[1]}.`, error: true, log: raw };
  const outsidePlace = raw.match(/^path is outside the scope (.*?): (.*)$/);
  if (outsidePlace) return outsidePlaceNotice(outsidePlace[1], raw);
  const exists = raw.match(/^already exists: (.*)$/);
  if (exists) return { text: `A folder named ${exists[1].split("/").pop()} already exists.`, error: true, log: null };
  return { text: `${plainReason(raw)}.`.replace(/\.\.$/, "."), error: true, log: raw };
}

/** A rename or move whose destination leaves the place that owns the item. */
export function outsidePlaceNotice(placeName: string, log: string | null = null): Notice {
  return { text: `Destination is outside ${placeName}. Use Finder, then Refresh.`, error: true, log };
}

/** The live-model cap is reached; nothing was opened and nothing was closed. */
export function tooManyOpenFilesNotice(): Notice {
  return { text: "Too many open files across places. Close some tabs and try again.", error: true, log: "open refused: live model cap reached" };
}

/** The place's folder is not in the root right now. Its buffers stay in memory. */
export function placeMissingText(placeName: string, rootPath: string): string {
  return `${placeName} is not in ${rootPath} right now. Your open files and unsaved edits are still here. Put the folder back, then Refresh.`;
}

export function placeMissingNotice(placeName: string, rootPath: string): Notice {
  return { text: placeMissingText(placeName, rootPath), error: true, log: `${placeName} is missing from the root` };
}

/** Two folders match one knowledge role. */
export function roleConflictText(label: string, names: readonly string[]): string {
  return `Two folders match ${label}: ${names.join(" and ")}. Rename one in Finder, then Refresh.`;
}

/**
 * The Refresh summary across every place: what changed on disk under an open
 * tab, what is missing, how many places were checked. Buffers reloaded in
 * place count as changed on disk; a tab whose check failed is named.
 */
export function refreshNotice(counts: { changed: number; missing: number; failed: number; places: number }): Notice {
  const parts = [
    counts.changed > 0 && `${counts.changed} ${counts.changed === 1 ? "file" : "files"} changed on disk`,
    counts.missing > 0 && `${counts.missing} missing`,
    counts.failed > 0 && `${counts.failed} could not be checked`,
  ].filter((p): p is string => typeof p === "string");
  if (parts.length === 0) return { text: "Refresh: nothing changed.", error: false, log: "Refresh: nothing changed" };
  const text = `Refresh: ${parts.join(", ")}, across ${counts.places} ${counts.places === 1 ? "place" : "places"}.`;
  return { text, error: false, log: text };
}

/** The saved layout could not be used and alabs started fresh. */
export function stateFallbackNotice(reason: string): Notice {
  return {
    text: "alabs could not read its saved layout, so it starts fresh. Your files are untouched.",
    error: true,
    log: reason,
  };
}

/** A task packet reached the clipboard (DESIGN.md 6.10). */
export function taskCopiedNotice(contextFiles: number): Notice {
  const text = `Task packet copied · ${contextFiles} context ${contextFiles === 1 ? "file" : "files"}`;
  return { text, error: false, log: text };
}

/** Copy is blocked while a ticked context file has unsaved edits; `relPath` is the first such file. */
export function taskBlockedNotice(relPath: string): Notice {
  return { text: `Save ${relPath} before copying the task packet.`, error: false, log: null };
}

/** True for the notice `taskBlockedNotice` produces, so it can be cleared when the block lifts. */
export function isTaskBlockedNotice(notice: Notice): boolean {
  return notice.text.startsWith("Save ") && notice.text.endsWith(" before copying the task packet.");
}

/** The clipboard refused the packet; it is shown for manual copy instead. */
export function copyFailedNotice(reason: string): Notice {
  return { text: "Copy failed. Task packet shown for manual copy.", error: true, log: `clipboard copy failed: ${reason}` };
}

/** Terminal.app could not be opened at the place. */
export function terminalFailedNotice(placeName: string, reason: string): Notice {
  return { text: `Unable to open Terminal for ${placeName}.`, error: true, log: `open Terminal for ${placeName} failed: ${reason}` };
}

/**
 * Another alabs window is editing this root now, so this one cannot change
 * files. Not a failure of what was asked: the window simply is not the one
 * that writes.
 */
export function notEditingNotice(): Notice {
  return {
    text: "Another alabs window is editing this root. This window is read-only until you take over editing.",
    error: false,
    log: "refused: another window is editing",
  };
}

/** This window took editing over, or gave it up. */
export function editingHereNotice(here: boolean): Notice {
  const text = here
    ? "This window is editing now. Any other alabs window on this root is read-only."
    : "This window is read-only. Take over editing to change files here.";
  return { text, error: false, log: text };
}

/**
 * What alabs found when it went back to the disk after a save it never got an
 * answer to. The point of every one of these is the same: nothing is tried
 * again on a guess, and the user is told exactly what is known.
 */
export type AfterSilence =
  /** The file is byte for byte what it was, so the save never reached it. */
  | "untouched"
  /** The file is different now. It may be this save, or it may be something else. */
  | "changed"
  /** Nothing is at that path any more. */
  | "gone"
  /** alabs could not look: it still cannot reach the file. */
  | "unknown";

export function uncertainSaveNotice(path: string, found: AfterSilence): Notice {
  const text = {
    untouched: `alabs did not hear back from that save, and ${path} is unchanged on disk, so nothing was written. Your edits are kept in the tab. Save again when you are ready.`,
    changed: `alabs did not hear back from that save, and ${path} has changed on disk since. Your edits are kept in the tab. Refresh to see what is there before saving again.`,
    gone: `alabs did not hear back from that save, and nothing is at ${path} on disk now. Your edits are kept in the tab.`,
    unknown: `alabs did not hear back from that save and cannot reach ${path} to check. Your edits are kept in the tab. Nothing will be written until you say so.`,
  }[found];
  return { text, error: true, log: `save result unknown for ${path}: ${found}` };
}

/** Unsaved work from before is waiting to be looked at. */
export function draftsWaitingNotice(count: number, unreadable: number): Notice {
  const kept = `alabs kept unsaved work for ${count} ${count === 1 ? "file" : "files"} from before. Nothing has been written to your files.`;
  const broken = unreadable > 0 ? ` ${unreadable} kept ${unreadable === 1 ? "file" : "files"} could not be read and ${unreadable === 1 ? "was" : "were"} left alone.` : "";
  return { text: kept + broken, error: false, log: `recovery: ${count} drafts, ${unreadable} unreadable` };
}

/**
 * alabs could not keep a draft anywhere. Said plainly, because the alternative
 * — letting it look kept — is the one thing recovery must never do.
 */
export function draftNotKeptNotice(path: string, reason: string): Notice {
  return {
    text: `alabs could not keep your unsaved work for ${path} anywhere. The text is still in the tab. Save it, or copy it out, before closing this window.`,
    error: true,
    log: `recovery failed for ${path}: ${reason}`,
  };
}

/** A summary that is not a failure. */
export function summaryNotice(text: string): Notice {
  return { text, error: false, log: null };
}

/**
 * Words that never appear on screen (DESIGN.md section 7). A test checks
 * every notice this module can produce against them.
 */
export const NEVER_ON_SCREEN = [
  "scope",
  "prefix",
  "HEAD",
  "porcelain",
  "blob",
  "unborn",
  "working tree",
  "stdout",
  "stderr",
  "role",
  "model",
  "URI",
  "stat",
  "baseline",
  "handle",
  "spawn",
  "mount",
  "frame",
  "CSP",
  "cap-std",
  "Monaco",
  "subject",
] as const;
