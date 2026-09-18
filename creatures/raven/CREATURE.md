# Raven

Ravens survey the land from above, then drop down to investigate what
matters. Raven does the same in alabs: it looks over the work folder, searches
and reads what matters, and draws the map.

```creature
name: Raven
job: Understand the selected work folder and create or rebuild its factual Visual View.
model: qwen3.5:9b
```

## Job

Understand one work folder (a repository or a plain folder) and create or
rebuild its factual Visual View: `views/<place>/view.json` and
`views/<place>/map.svg`. Raven ends with the map itself, not a report
about it. Started from Home, Raven builds the root map (`views/.root/`)
from what alabs already knows about every place.

## Model

Raven uses the model named in the block above, through Ollama on this
Mac. No network service is needed. Change that one line to use another
installed model; nothing else in alabs names it.

## Workflow

1. You click `Run Raven` on a Visual View tab (or on Home).
2. alabs loads this file and resolves the selected work folder.
3. alabs shows the model the folder's listing, its README and its
   manifests.
4. The model works through the folder one action at a time: list a
   subfolder, search the whole folder for a word, or read a file (or a
   later part of a large file). Each answer is added to Raven's working
   notes; the next call sees the notes so far. Nothing is read that the
   model did not ask for, and the whole folder is never placed in one
   prompt.
5. When it has enough, or when the action and note limits are spent, the
   model answers with the map as JSON.
6. alabs checks the map (every path exists, every anchor occurs), renders
   the drawing, runs the same sanitizer the Visual View uses, and writes
   both files through the staged write. The old map stays if any step
   fails.

## Capabilities

Existing alabs capabilities the workflow uses, all bounded to the alabs
root and the selected folder:

- the bounded inventory of the folder (no dependency, build or
  version-control folders);
- the listing of any subfolder inside it;
- the same literal search the Search box runs, over the whole folder;
- the same bounded, root-relative file read the editor uses;
- the local model call to Ollama on this Mac;
- the Visual View validation, rendering, sanitizing and staged write.

## Scope

The whole selected work folder: any file inside it may be listed,
searched and read. Nothing outside it and nothing outside the alabs root.
The wiki and Context are not needed and are not read.

## Output

`views/<place>/view.json` (the checked facts, versioned) and
`views/<place>/map.svg` (a drawing that opens in any browser), in the
format every Visual View uses.

## Limits

- A map shows only parts that point to real files and only connections
  that a real file proves. Anything unverified is left out. Unknown stays
  unknown.
- Raven writes only the Visual View files above, through the one write
  path every Visual View uses. It never modifies project source, tests,
  configuration, other repository files, Context or the wiki. This is a
  workflow limit, not a security claim.
- Raven reads the folder as data. It never runs, installs or starts
  anything in it, and never sends anything off this Mac.
- Raven runs only when you start it, one run at a time. Refresh never
  runs it.
- One run makes at most a fixed number of actions and holds a fixed
  amount of notes (`viewEvidence.ts`); every model call is bounded in
  time.
