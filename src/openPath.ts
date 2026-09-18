/**
 * The one way live editor state comes into being. `materialize` reads a real
 * file and creates its Monaco model, for a normal open and for a restore
 * alike. It owns the live-model cap, the missing-file outcome and the stale
 * completion check; the caller (App's `openPath` or its restore loop) owns
 * scope ownership and commits the resulting tab through the guarded scope
 * update. No surface creates a model any other way.
 *
 * Pure over injected dependencies so the decisions can be tested without
 * Monaco or Tauri.
 */
import type { FileContent, FileStamp } from "./subject";
import type { Tab, TabKind } from "./tabs";

/** At most this many live file models across every scope. The next open is refused; nothing is evicted. */
export const MAX_LIVE_MODELS = 200;

/** True for a file the Markdown tab renders: `.md` or `.markdown`, any letter case. */
export function isMarkdownPath(relPath: string): boolean {
  return /\.(md|markdown)$/i.test(relPath);
}

/**
 * The kind a surface opens a path as when it does not say (BUILD_PLAN Step
 * 3 item 20): a Markdown file opens rendered, everything else in the Editor.
 * "Open source" and a search hit with a line ask for the Editor explicitly.
 */
export function defaultTabKind(relPath: string): TabKind {
  return isMarkdownPath(relPath) ? "markdown" : "editor";
}

export interface MaterializeDeps {
  readFile: (relPath: string) => Promise<FileContent>;
  /** Live file models across every scope right now. */
  liveModelCount: () => number;
  /**
   * Create the model for `relPath` from the text given (replacing any leftover
   * model at that path, never reusing one) and return its version id, the
   * tab's saved version.
   */
  createModel: (relPath: string, file: FileContent) => number;
  /** False once the completion would be stale: the root changed or the scope is gone. */
  stillLive: () => boolean;
}

export type MaterializeResult =
  /** The file is live: its model exists and this tab describes it. */
  | { kind: "tab"; tab: Tab }
  /** The cap is reached; nothing was read or created. */
  | { kind: "refused"; reason: "too many open files" }
  /** The file could not be read (missing, too large, not text, refused); nothing was created. */
  | { kind: "failed"; reason: string }
  /** The completion arrived after the root changed or the scope went away; nothing was created. */
  | { kind: "stale" };

/**
 * Bring one real file to life for a scope that has already been checked to
 * own it. The cap is checked before the read and again before the model is
 * created, so two opens in flight cannot pass it together.
 */
export async function materialize(deps: MaterializeDeps, relPath: string): Promise<MaterializeResult> {
  if (deps.liveModelCount() >= MAX_LIVE_MODELS) return { kind: "refused", reason: "too many open files" };
  let file: FileContent;
  try {
    file = await deps.readFile(relPath);
  } catch (err) {
    if (!deps.stillLive()) return { kind: "stale" };
    return { kind: "failed", reason: String(err) };
  }
  if (!deps.stillLive()) return { kind: "stale" };
  if (deps.liveModelCount() >= MAX_LIVE_MODELS) return { kind: "refused", reason: "too many open files" };
  const savedVersion = deps.createModel(relPath, file);
  return {
    kind: "tab",
    tab: { kind: "loaded", relPath, name: file.name, stamp: file.stamp, savedVersion, dirty: false, disk: "ok" },
  };
}

/**
 * The stamp of a file that is not there. Nothing on disk can match it, so a
 * save against it is refused and reaches the explicit Recreate instead.
 */
export const NO_FILE_STAMP: FileStamp = { identity: "", mtime_secs: 0, mtime_nanos: 0, len: 0 };

/**
 * Bring a restored draft to life for a file that is no longer on disk.
 *
 * Nothing is read and nothing is written. The buffer holds the draft's own
 * text and the tab says the file is missing, so the only way that text reaches
 * the disk is the Recreate the user is explicitly offered when they save it.
 * Its saved version is 0 — a version no live model can hold — so the buffer
 * stays unsaved until it really is saved.
 *
 * The cap applies here as it does to a normal open: a restore never evicts
 * anything, it refuses and says so.
 */
export function materializeDraft(
  deps: Pick<MaterializeDeps, "liveModelCount" | "createModel" | "stillLive">,
  relPath: string,
  name: string,
  contents: string,
  stamp: FileStamp | null,
): MaterializeResult {
  if (deps.liveModelCount() >= MAX_LIVE_MODELS) return { kind: "refused", reason: "too many open files" };
  if (!deps.stillLive()) return { kind: "stale" };
  // The draft's own stamp when it has one: if the file comes back exactly as
  // it was, a save of this buffer is then the ordinary, safe one.
  const was = stamp ?? NO_FILE_STAMP;
  deps.createModel(relPath, { name, content: contents, stamp: was });
  return {
    kind: "tab",
    tab: { kind: "loaded", relPath, name, stamp: was, savedVersion: 0, dirty: true, disk: "missing" },
  };
}
