![Creature: the drawn heading of the Creatures folder, in the alabs wordmark style, its letters filled with a deer, feathers, a whale tail, a paw print and a fish on a dark field](../assets/supporting-assets/creature-wording.jpg)

A creature is a named, local-model-powered workflow that uses existing
alabs capabilities to do one specific job. Creatures exist so that useful
AI work can run on this Mac with a local model.

A creature is not a model, not a security system, and not the only way an
agent can reach a repository: Claude Code, Codex or any other agent can
still be run directly against a whole repository whenever wanted. A
creature is an optional, focused workflow.

The rest of alabs works without a model. Files, the editor, Visual Views,
Git information, Definitions, the wiki and Context are ordinary local
files that open with nothing running. A creature is the one kind of alabs
work that needs a model, because its job is to read and reason.

## Files

```text
creatures/
  README.md            this file
  raven/
    CREATURE.md        Raven: the only creature today
```

Each creature is one folder with one `CREATURE.md`, written for people
first. Near the top it carries one fenced `creature` block that alabs
reads:

```text
name:   what the creature is called
job:    one sentence
model:  the Ollama model it uses, for example a name:tag
```

The rest of the file states the creature's contract in prose, under fixed
headings:

| section | meaning |
| --- | --- |
| Job | what it produces, in one paragraph |
| Model | which local model, and that Ollama on this Mac is the only route |
| Workflow | what happens, step by step, when it runs |
| Capabilities | the existing alabs capabilities the workflow uses |
| Scope | what it works on: the selected repository or folder |
| Output | the one artifact the job ends with |
| Limits | what the workflow does not do |

## Running

A creature runs only when you start it. Nothing schedules one, nothing
runs in the background, nothing retries on its own. One creature run at a
time; navigation never waits for it. Refresh never runs a creature.

A run needs its model installed in Ollama and Ollama running. Without
them, the run says so and nothing else changes.

## Output

A creature must produce exactly the artifact its job names, in the format
alabs already uses for it, through the same checks and the same write path
alabs already has for it. What it cannot verify it leaves out. A plain
result that is true is a success; a polished result that guesses is a
failure.

## Names

Creatures are named after animals whose real behaviour matches the job.
The name should tell you what the creature does before you read its file.
