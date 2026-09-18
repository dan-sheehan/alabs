/**
 * Creatures: named local-model workflows that use existing alabs
 * capabilities to do one job (`creatures/README.md`). Raven is the only
 * one. A creature's `CREATURE.md` is bundled into the app and read here for
 * the three facts the code needs: its name, its job and its model. The rest
 * of the file (workflow, capabilities, scope, output, limits) is for people;
 * the workflow itself is the Visual View pipeline in `viewBuild.ts`.
 *
 * Nothing here calls a model, reads a file or keeps state.
 */
import RAVEN_TEXT from "../creatures/raven/CREATURE.md?raw";

export interface Creature {
  name: string;
  job: string;
  /** The Ollama model name the creature uses; the one place a model is named. */
  model: string;
}

/** An Ollama model name: `name` or `name:tag`, plain characters only. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9._-]+)?$/;

const KEYS = ["name", "job", "model"] as const;

/**
 * Read one `CREATURE.md`: the first fenced `creature` block, one `key: value`
 * per line, exactly `name`, `job` and `model`. Returns the creature or the
 * reason it does not load; never throws.
 */
export function parseCreature(text: string): { kind: "ok"; creature: Creature } | { kind: "invalid"; reason: string } {
  const match = /```creature[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(text);
  if (!match) return { kind: "invalid", reason: "no creature block" };
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const at = line.indexOf(":");
    if (at <= 0) return { kind: "invalid", reason: `not a key: value line: ${line.trim().slice(0, 40)}` };
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!(KEYS as readonly string[]).includes(key)) return { kind: "invalid", reason: `unknown key ${key}` };
    if (fields.has(key)) return { kind: "invalid", reason: `repeated key ${key}` };
    fields.set(key, value);
  }
  for (const key of KEYS) if (!fields.get(key)) return { kind: "invalid", reason: `missing ${key}` };
  const model = fields.get("model") ?? "";
  if (!MODEL_NAME.test(model)) return { kind: "invalid", reason: "model is not an Ollama model name" };
  return { kind: "ok", creature: { name: fields.get("name") ?? "", job: fields.get("job") ?? "", model } };
}

function mustParse(text: string, file: string): Creature {
  const parsed = parseCreature(text);
  if (parsed.kind === "invalid") throw new Error(`${file} does not load: ${parsed.reason}`);
  return parsed.creature;
}

/** Raven, from `creatures/raven/CREATURE.md`. The only creature. */
export const RAVEN: Creature = mustParse(RAVEN_TEXT, "creatures/raven/CREATURE.md");

/** The sentence shown when the creature's model is not installed in Ollama. */
export function modelMissingText(creature: Creature): { text: string; hint: string } {
  return { text: `${creature.name} needs ${creature.model}.`, hint: `Install it in Ollama, then run ${creature.name} again.` };
}
