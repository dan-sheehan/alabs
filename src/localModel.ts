/**
 * `Ask local model` (post-Stage-1 Wiki feature): the one transparent input
 * built for the local model, pure over injected reads. The material is the
 * top-level text and Markdown files of the `context/` and `wiki/` folders
 * the root listing resolved, read through the same root-bounded bridge as
 * everything else, so nothing outside the root and nothing from a work
 * place can enter. Nothing here retrieves, indexes, embeds or ranks: the
 * whole material goes in, or the ask fails visibly at the budget.
 */
import type { Entry } from "./subject";

/**
 * Total characters of file contents (Context plus Wiki) allowed into one
 * ask: about 6,000 tokens, sized for an 8,192-token context window on a
 * small local model with room for the instruction, the question and the
 * answer. Deliberately small; over it the ask fails and says so.
 */
export const INPUT_BUDGET_CHARS = 24_000;
/** Longest question accepted. */
export const QUESTION_MAX_CHARS = 2_000;

/** The fixed instruction sent as the model's system text. */
export const SYSTEM_INSTRUCTION = [
  "You answer questions for the owner of a small personal knowledge folder.",
  "The material below is the full contents of the text files in their context/ and wiki/ folders, each between FILE and END markers with its path.",
  "When the question depends on personal facts, plans, notes or anything about the owner, answer only from that material.",
  "When the material does not support an answer, say plainly that the local material does not cover it; do not guess.",
  "Never invent files, paths, names or facts that are not in the material.",
  "Keep the answer concise unless the question needs detail.",
].join(" ");

/** True for a top-level file the material may include: a plain text or Markdown file that is not hidden. */
export function isAskFile(entry: Entry): boolean {
  if (entry.is_dir || entry.name.startsWith(".")) return false;
  const lower = entry.name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt");
}

/** The folders the material comes from: the on-disk names the root listing resolved, or null when a role has no folder. */
export interface AskFolders {
  context: string | null;
  wiki: string | null;
}

export interface AskIo {
  listDir: (relPath: string) => Promise<Entry[]>;
  readFile: (relPath: string) => Promise<{ content: string }>;
}

export interface AskFile {
  relPath: string;
  chars: number;
}

/** What building one ask produced. */
export type AskInput =
  /** The input, ready to send; `files` lists what entered, in order. */
  | { kind: "ready"; system: string; prompt: string; files: AskFile[]; chars: number }
  /** The material is over the budget; nothing is sent. */
  | { kind: "too_large"; chars: number; budget: number }
  /** A listed file could not be read; nothing is sent. */
  | { kind: "unreadable"; relPath: string; reason: string }
  /** The question is empty or too long; nothing is read. */
  | { kind: "bad_question"; reason: string };

/**
 * Build the input for one question. Reads one listing per present folder
 * (Context first, then Wiki, in listing order) and one bounded read per
 * eligible file. A missing or empty folder contributes a line saying so.
 * Rejects only when a listing fails.
 */
export async function buildAsk(io: AskIo, folders: AskFolders, question: string): Promise<AskInput> {
  const trimmed = question.trim();
  if (trimmed.length === 0) return { kind: "bad_question", reason: "Type a question first." };
  if (trimmed.length > QUESTION_MAX_CHARS) {
    return { kind: "bad_question", reason: `Keep the question under ${QUESTION_MAX_CHARS.toLocaleString()} characters.` };
  }
  const parts: string[] = [];
  const files: AskFile[] = [];
  let chars = 0;
  for (const [label, folder] of [
    ["context", folders.context],
    ["wiki", folders.wiki],
  ] as const) {
    if (folder === null) {
      parts.push(`=== NO ${label.toUpperCase()} FOLDER ===`);
      continue;
    }
    const entries = (await io.listDir(folder)).filter(isAskFile);
    if (entries.length === 0) {
      parts.push(`=== ${folder}/ HAS NO TEXT FILES ===`);
      continue;
    }
    for (const entry of entries) {
      let content: string;
      try {
        content = (await io.readFile(entry.rel_path)).content;
      } catch (err) {
        return { kind: "unreadable", relPath: entry.rel_path, reason: String(err) };
      }
      chars += content.length;
      if (chars > INPUT_BUDGET_CHARS) return { kind: "too_large", chars, budget: INPUT_BUDGET_CHARS };
      files.push({ relPath: entry.rel_path, chars: content.length });
      parts.push(`=== FILE ${entry.rel_path} ===\n${content.replace(/\s+$/, "")}\n=== END ${entry.rel_path} ===`);
    }
  }
  parts.push(`=== QUESTION ===\n${trimmed}`);
  return { kind: "ready", system: SYSTEM_INSTRUCTION, prompt: parts.join("\n\n"), files, chars };
}

/** The sentence shown when an ask could not be built or answered. */
export function askFailureText(
  outcome:
    | Exclude<AskInput, { kind: "ready" }>
    | { kind: "not_installed"; model: string }
    | { kind: "unavailable" }
    | { kind: "timeout" }
    | { kind: "failed"; reason: string },
): string {
  switch (outcome.kind) {
    case "not_installed":
      return outcome.model === "" ? "Choose a local model." : `${outcome.model} is no longer installed. Choose a local model.`;
    case "bad_question":
      return outcome.reason;
    case "too_large":
      return `Context and Wiki hold ${outcome.chars.toLocaleString()} characters, over the ${outcome.budget.toLocaleString()} the local model is given. Trim them, then ask again.`;
    case "unreadable":
      return `Could not read ${outcome.relPath}: ${outcome.reason.replace(/\s*\(os error \d+\)/g, "")}.`;
    case "unavailable":
      return "Local model unavailable.";
    case "timeout":
      return "Local model took too long.";
    case "failed":
      return `Local model request failed: ${outcome.reason}.`;
  }
}
