// @ts-expect-error type error without @types/node package, as in vite.config.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { modelMissingText, parseCreature, RAVEN } from "./creatures";

// Creatures: the one creature file loads into the app with its name, its
// job and its model; the model is named there and nowhere else; and a file
// that is not that small contract does not load.

const ravenText = () => readFileSync(new URL("../creatures/raven/CREATURE.md", import.meta.url), "utf8");

function fileWith(block: string): string {
  return `# Something\n\nProse.\n\n\`\`\`creature\n${block}\n\`\`\`\n\n## More prose\n`;
}

const GOOD = ["name: Raven", "job: Survey.", "model: some-model:9b"].join("\n");

describe("creature definition loading", () => {
  it("Raven loads from creatures/raven/CREATURE.md with its name, its job and its model", () => {
    const parsed = parseCreature(ravenText());
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.creature).toEqual(RAVEN);
    expect(RAVEN.name).toBe("Raven");
    expect(RAVEN.job).toBe("Understand the selected work folder and create or rebuild its factual Visual View.");
    // The default creature model, named in the creature's file and nowhere in alabs source.
    expect(RAVEN.model).toBe("qwen3.5:9b");
  });

  it("the file states the whole contract for people: job, model, workflow, capabilities, scope, output and limits; the README names no model", () => {
    const text = ravenText();
    for (const section of ["## Job", "## Model", "## Workflow", "## Capabilities", "## Scope", "## Output", "## Limits"]) expect(text).toContain(section);
    expect(text.split(RAVEN.model)).toHaveLength(2);
    const readme = readFileSync(new URL("../creatures/README.md", import.meta.url), "utf8");
    expect(readme).not.toContain(RAVEN.model);
  });

  it("a well-formed block parses; the model line alone chooses the model", () => {
    const parsed = parseCreature(fileWith(GOOD));
    expect(parsed).toEqual({ kind: "ok", creature: { name: "Raven", job: "Survey.", model: "some-model:9b" } });
    expect(parseCreature(fileWith(GOOD.replace("some-model:9b", "other")))).toMatchObject({ kind: "ok", creature: { model: "other" } });
  });

  it("refuses a missing block or key, an unknown or repeated key, a bad model name, or a line that is not key: value", () => {
    const invalid = (text: string) => {
      const parsed = parseCreature(text);
      expect(parsed.kind, text).toBe("invalid");
      return parsed.kind === "invalid" ? parsed.reason : "";
    };
    expect(invalid("# Raven\n\nno block\n")).toBe("no creature block");
    expect(invalid(fileWith(GOOD.replace("model: some-model:9b", "")))).toBe("missing model");
    expect(invalid(fileWith(GOOD.replace("job: Survey.", "job: ")))).toBe("missing job");
    expect(invalid(fileWith(GOOD + "\nschedule: nightly"))).toBe("unknown key schedule");
    expect(invalid(fileWith(GOOD + "\nreads: everything"))).toBe("unknown key reads");
    expect(invalid(fileWith(GOOD + "\nmodel: again"))).toBe("repeated key model");
    expect(invalid(fileWith(GOOD.replace("model: some-model:9b", "model: http://x/y")))).toBe("model is not an Ollama model name");
    expect(invalid(fileWith(GOOD.replace("model: some-model:9b", "model: a b")))).toBe("model is not an Ollama model name");
    expect(invalid(fileWith(GOOD + "\njust words"))).toMatch(/^not a key: value line/);
  });

  it("names the missing model in the creature's words", () => {
    expect(modelMissingText({ ...RAVEN, model: "some-model:1b" })).toEqual({ text: "Raven needs some-model:1b.", hint: "Install it in Ollama, then run Raven again." });
  });
});
