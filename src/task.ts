/**
 * The Task tab's pure logic (DESIGN.md 6.10, BUILD_PLAN Step 6): the draft
 * shape, which open tabs may be context, what blocks `Copy task packet`, and
 * the packet text itself. Nothing here touches the clipboard, the disk or
 * Git; App does the copy from the click and records the baseline.
 *
 * The draft is session memory only: it lives in the scope record, survives
 * place switches and tab closes, is never written to disk and is never
 * task history.
 */
import { knowKey, ROLES, type ScopeKey } from "./places";
import type { Scope, Scopes } from "./scopeState";

export interface TaskDraft {
  text: string;
  constraints: string;
  /** Root-relative paths ticked as context; only paths that are still candidates count. */
  selected: ReadonlySet<string>;
  /** The packet shown for manual copy after the clipboard refused it; null otherwise. */
  fallback: string | null;
}

export const EMPTY_DRAFT: TaskDraft = { text: "", constraints: "", selected: new Set(), fallback: null };

/** One open file-backed tab that may be ticked as context. */
export interface ContextCandidate {
  /** Root-relative path, shown as written. */
  relPath: string;
  /** True when an Editor tab for the path holds unsaved edits. */
  dirty: boolean;
}

/**
 * The tabs a task may name as context: every open file-backed tab (a loaded
 * Editor tab or a rendered Markdown tab) in the work place and in the three
 * knowledge places, in rail order (the work place, then Context, Wiki,
 * Definitions) then strip order, one row per path. Overview, Task, Changes
 * and Visual View surfaces are never candidates, and neither is a tab whose
 * file could not be read.
 */
export function contextCandidates(scopes: Scopes, work: ScopeKey): ContextCandidate[] {
  const out: ContextCandidate[] = [];
  const seen = new Set<string>();
  const add = (scope: Scope | undefined) => {
    if (!scope) return;
    const dirty = new Set(scope.tabs.tabs.filter((t) => t.kind === "loaded" && t.dirty).map((t) => t.relPath));
    for (const tab of scope.tabs.tabs) {
      if (tab.kind !== "loaded" && tab.kind !== "markdown") continue;
      if (seen.has(tab.relPath)) continue;
      seen.add(tab.relPath);
      out.push({ relPath: tab.relPath, dirty: dirty.has(tab.relPath) });
    }
  };
  add(scopes[work]);
  for (const { role } of ROLES) add(scopes[knowKey(role)]);
  return out;
}

/** The ticked candidates, in candidate order. A ticked path that is no longer open is not context. */
export function selectedContext(candidates: readonly ContextCandidate[], selected: ReadonlySet<string>): ContextCandidate[] {
  return candidates.filter((c) => selected.has(c.relPath));
}

export type CopyBlocker =
  /** The task has no non-space character yet. */
  | { kind: "empty" }
  /** A ticked context file has unsaved edits; `relPath` is the first one in list order. */
  | { kind: "dirty"; relPath: string };

/** Why `Copy task packet` is disabled right now, or null when it may run. Checked again at the click. */
export function copyBlocker(task: string, chosen: readonly ContextCandidate[]): CopyBlocker | null {
  if (task.trim() === "") return { kind: "empty" };
  const dirty = chosen.find((c) => c.dirty);
  if (dirty) return { kind: "dirty", relPath: dirty.relPath };
  return null;
}

export interface PacketInput {
  /** The work place's folder name. */
  place: string;
  /** The absolute root path. */
  rootPath: string;
  task: string;
  /** Root-relative context paths, one per line in the packet. */
  context: readonly string[];
  constraints: string;
}

/**
 * The plain-text task packet (BUILD_PLAN Step 6): work folder, root, task,
 * context paths, constraints. The five headings are always present; an
 * empty list or text reads `none`. Text is kept as typed apart from
 * trimming the ends.
 */
export function taskPacket(input: PacketInput): string {
  const block = (text: string) => (text.trim() === "" ? "none" : text.trim());
  const context = input.context.length === 0 ? "none" : input.context.join("\n");
  return [
    `Work folder: ${input.place}`,
    `Root: ${input.rootPath}`,
    "",
    "Task:",
    block(input.task),
    "",
    "Context:",
    context,
    "",
    "Constraints:",
    block(input.constraints),
    "",
  ].join("\n");
}
