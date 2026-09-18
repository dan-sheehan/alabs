/**
 * Raven's workflow for one work place (`creatures/raven/CREATURE.md`) and
 * the queue it runs on.
 *
 * ```text
 * work place
 *   → starting evidence               collectInventory + README and manifests (viewEvidence.ts)
 *   → the model works incrementally   generate, JSON shape; one call per action: list, search, read
 *   → structured JSON map             the model's answer when it has enough, or when the bounds are spent
 *   → factual validation              validateMap (viewMap.ts): paths exist, anchors occur
 *   → deterministic SVG renderer      renderMapSvg (viewRender.ts)
 *   → sanitizer                       the Stage 5 parseView, injected (it needs a DOM)
 *   → view.json + map.svg             writeViewFiles: staged, then renamed into place
 * ```
 *
 * The model reaches the whole place by asking: any subfolder can be
 * listed, the whole place searched, any file read from any line. Each
 * result is added to its working notes and the next call sees the notes
 * so far; the whole place is never placed in one prompt. `MAX_ACTIONS` and
 * `MAX_EVIDENCE_CHARS` bound a run. Every path the model names is checked
 * against what it was shown: the inventory, a listing, a search hit or a
 * read. A private environment file (`isPrivateEnvFile`: `.env`, `.env.*`,
 * `*.env`) is never read and never a search hit, so its contents reach no
 * prompt and no anchor check.
 *
 * Nothing partial is ever written: a failure at any step leaves the place's
 * `views/<place>/` exactly as it was; an existing map is replaced only after
 * the new one passed every check. The model is whatever name the caller
 * passes (Raven's, from its file); nothing here names one.
 *
 * The queue is one in-memory FIFO: one build at a time, the rest wait in
 * order, nothing persisted, nothing polled, nothing retried on its own. A
 * failure is remembered for the session so Home and the Visual View can
 * say so. When the local server cannot be reached the waiting places are
 * marked the same way and dropped, rather than each dialling a stopped
 * server in turn.
 */
import type { Entry, Inventory, LocalModelResult, SearchResult, SearchSummary } from "./subject";
import {
  alwaysFirst,
  candidates,
  fileExcerpt,
  isPrivateEnvFile,
  listText,
  looksBinary,
  MAP_INSTRUCTION,
  MAX_ACTIONS,
  MAX_EVIDENCE_CHARS,
  MAX_READ_BYTES,
  noteText,
  packetHead,
  parseAction,
  readPacket,
  searchText,
  stepPrompt,
} from "./viewEvidence";
import { serializeMap, validateMap, type MapDropped } from "./viewMap";
import { renderMapSvg } from "./viewRender";

/** Every call the workflow makes, injectable for tests. Production binds the root-bounded bridge and the Stage 5 sanitizer. */
export interface BuildIo {
  collectInventory: (place: string) => Promise<Inventory>;
  /** Root-relative listing through the bridge: the same one the file tree uses. */
  listDir: (relPath: string) => Promise<Entry[]>;
  /** Root-relative read through the bridge; rejects for binary, missing and oversized files. */
  readFile: (relPath: string) => Promise<{ content: string }>;
  /** The same literal search the Search box runs, over one place, collected. */
  search: (query: string, scope: string) => Promise<{ results: SearchResult[]; summary: SearchSummary }>;
  generate: (model: string, system: string, prompt: string) => Promise<LocalModelResult>;
  writeViewFiles: (place: string, expectedRoot: string, viewJson: string, mapSvg: string, replace: boolean) => Promise<void>;
  /** The existing sanitizer over the rendered text: how many landmarks survive it, or why it is not a usable map. */
  checkSvg: (svg: string) => { kind: "ok"; landmarks: number } | { kind: "invalid"; reason: string };
}

export interface BuildJob {
  place: string;
  /** The root the build started in; the write refuses another. */
  root: string;
  model: string;
  /** True when an existing map may be replaced. Raven always may: the old map stays only if the new one fails a check. */
  replace: boolean;
}

/** Why a build produced nothing. Short fixed categories, safe to log. */
export type BuildFailure =
  | "not_installed"
  | "unavailable"
  | "timeout"
  /** The model call was refused or answered unusably. */
  | "model"
  /** The place could not be listed. */
  | "evidence"
  /** The answer was not a valid factual map. */
  | "invalid"
  /** The rendered SVG did not pass the sanitizer. */
  | "render"
  | "write"
  | "root_changed";

/** Milliseconds per phase; a phase that did not run is null. `evidence` covers every read, listing and search; `model` every model call. */
export interface BuildTimings {
  evidence: number | null;
  model: number | null;
  validate: number | null;
  render: number | null;
  total: number;
}

export type BuildOutcome =
  | { kind: "built"; calls: number; files: number; landmarks: number; connections: number; dropped: MapDropped; timings: BuildTimings }
  /** `detail` is the validation category for `invalid`: one short fixed phrase, never content. */
  | { kind: "failed"; reason: BuildFailure; detail?: string; timings: BuildTimings };

function modelFailure(result: Exclude<LocalModelResult, { kind: "answer" }>): BuildFailure {
  switch (result.kind) {
    case "unavailable":
      return "unavailable";
    case "timeout":
      return "timeout";
    case "not_installed":
      return "not_installed";
    case "failed":
      return "model";
  }
}

/** Run the whole workflow for one place. Never rejects. */
export async function buildView(io: BuildIo, job: BuildJob, now: () => number = () => Date.now()): Promise<BuildOutcome> {
  const start = now();
  const timings: BuildTimings = { evidence: null, model: null, validate: null, render: null, total: 0 };
  const add = (phase: "evidence" | "model", from: number) => {
    timings[phase] = (timings[phase] ?? 0) + (now() - from);
  };
  const fail = (reason: BuildFailure, detail?: string): BuildOutcome => {
    timings.total = now() - start;
    return detail === undefined ? { kind: "failed", reason, timings } : { kind: "failed", reason, detail, timings };
  };

  // Starting evidence: the inventory, README and manifests.
  const evidenceAt = now();
  let inventory: Inventory;
  try {
    inventory = await io.collectInventory(job.place);
  } catch {
    return fail("evidence");
  }
  /** Every place-relative file path the model has been shown; the validator accepts no other. */
  const files = new Set<string>();
  for (const e of inventory.entries) if (!e.is_dir) files.add(e.path);
  const texts = new Map<string, string | null>();
  /** Reads one file of the place, once; null for binary, missing, unreadable, oversized or a private environment file, which is never asked of the bridge. */
  const readText = async (path: string): Promise<string | null> => {
    if (isPrivateEnvFile(path)) return null;
    if (texts.has(path)) return texts.get(path) ?? null;
    let result: string | null = null;
    try {
      const { content } = await io.readFile(`${job.place}/${path}`);
      result = looksBinary(content) || content.length > MAX_READ_BYTES ? null : content;
    } catch {
      result = null;
    }
    if (result !== null) files.add(path);
    texts.set(path, result);
    return result;
  };
  const head = packetHead(job.place, inventory);
  const starter = await readPacket(alwaysFirst(candidates(inventory)), readText, head.length);
  const notes: string[] = starter.text === "" ? [] : [starter.text];
  let chars = starter.chars;
  add("evidence", evidenceAt);

  // The model works: one call per action, then the map.
  let actions = MAX_ACTIONS;
  let calls = 0;
  let answer: string;
  for (;;) {
    const left = { actions, chars: MAX_EVIDENCE_CHARS - chars };
    const modelAt = now();
    const result = await io.generate(job.model, MAP_INSTRUCTION, stepPrompt(head, notes, left));
    add("model", modelAt);
    calls += 1;
    if (result.kind !== "answer") return fail(modelFailure(result));
    const action = parseAction(result.text);
    if (action.kind === "map" || left.actions <= 0 || left.chars <= 0) {
      answer = result.text;
      break;
    }
    actions -= 1;
    const actAt = now();
    let note: string;
    switch (action.kind) {
      case "none":
        note = noteText(action.reason);
        break;
      case "list": {
        try {
          const entries = await io.listDir(action.path === "" ? job.place : `${job.place}/${action.path}`);
          for (const e of entries) if (!e.is_dir && e.rel_path.startsWith(`${job.place}/`)) files.add(e.rel_path.slice(job.place.length + 1));
          note = listText(action.path, entries, job.place);
        } catch {
          note = noteText(`cannot list ${action.path === "" ? "." : action.path}`);
        }
        break;
      }
      case "search": {
        try {
          const found = await io.search(action.query, job.place);
          // A hit carries the matched line: a private environment file's lines are dropped here.
          const results = found.results.filter((r) => !isPrivateEnvFile(r.rel_path));
          for (const r of results) if (r.rel_path.startsWith(`${job.place}/`)) files.add(r.rel_path.slice(job.place.length + 1));
          note = searchText(action.query, results, { ...found.summary, results: found.summary.results - (found.results.length - results.length) }, job.place);
        } catch {
          note = noteText(`search failed for ${JSON.stringify(action.query)}`);
        }
        break;
      }
      case "read": {
        const text = await readText(action.path);
        note =
          text !== null
            ? fileExcerpt(action.path, text, action.from)
            : isPrivateEnvFile(action.path)
              ? noteText(`cannot read ${action.path}: a private environment file is never shown`)
              : noteText(`cannot read ${action.path}: not a text file inside the folder, or too large`);
        break;
      }
    }
    // The notes are bounded: a result that does not fit is cut, and the next call must produce the map.
    const room = MAX_EVIDENCE_CHARS - chars - 2;
    if (note.length > room) note = room > 0 ? `${note.slice(0, room)}\n=== CUT: the notes are full ===` : "=== CUT: the notes are full ===";
    notes.push(note);
    chars += note.length + 2;
    add("evidence", actAt);
  }

  // Validation: every path was shown, every anchor occurs.
  const read = [...texts.values()].filter((t) => t !== null).length;
  const validateAt = now();
  const validation = await validateMap(answer, { place: job.place, files, readText });
  timings.validate = now() - validateAt;
  if (validation.kind === "rejected") return fail("invalid", validation.reason);

  // Rendering, then the same sanitizer the surface uses.
  const renderAt = now();
  const svg = renderMapSvg(validation.map);
  const check = io.checkSvg(svg);
  timings.render = now() - renderAt;
  if (check.kind !== "ok" || check.landmarks !== validation.map.landmarks.length) return fail("render");

  // Only now do the files land.
  try {
    await io.writeViewFiles(job.place, job.root, serializeMap(validation.map), svg, job.replace);
  } catch (err) {
    return fail(/root changed/.test(String(err)) ? "root_changed" : "write");
  }
  timings.total = now() - start;
  return {
    kind: "built",
    calls,
    files: read,
    landmarks: validation.map.landmarks.length,
    connections: validation.map.connections.length,
    dropped: validation.dropped,
    timings,
  };
}

/** What the queue knows about one place this session. */
export type BuildState = { kind: "queued" } | { kind: "building" } | { kind: "built" } | { kind: "failed"; reason: BuildFailure };

/** What the queue needs of an outcome: built, or failed with a category. The place workflow's outcome and the root view's both satisfy it. */
export type QueueOutcome = { kind: "built" } | { kind: "failed"; reason: BuildFailure };

/** The outcome the queue records when a build throws instead of answering. */
const THROWN: BuildOutcome = { kind: "failed", reason: "model", timings: { evidence: null, model: null, validate: null, render: null, total: 0 } };

/**
 * The in-memory FIFO. `run` is the workflow bound to the bridge; `onChange`
 * is told of every state change, with the outcome when a build ended. The
 * in-flight operation may finish; `clear` (root change) invalidates the
 * running workflow's guard and forgets every waiting place and state.
 * The abandoned build's outcome is ignored.
 */
export class ViewQueue<O extends QueueOutcome = BuildOutcome> {
  private waiting: string[] = [];
  private running: string | null = null;
  private epoch = 0;
  private readonly states = new Map<string, BuildState>();

  /**
   * `run` is the workflow for one key (a place, or the root view's key);
   * `onChange` is told of every state change. The queue is generic over
   * the outcome only so the root view's richer outcome can ride the same
   * FIFO; `THROWN` is the place workflow's shape, which every outcome type
   * here extends.
   */
  constructor(
    private readonly run: (place: string, isCurrent: () => boolean) => Promise<O>,
    private readonly onChange: (place: string, state: BuildState, outcome: O | null) => void,
  ) {}

  /** The state of one place, or null when nothing is known this session. */
  stateOf(place: string): BuildState | null {
    return this.states.get(place) ?? null;
  }

  /** Every known state, by place. */
  snapshot(): ReadonlyMap<string, BuildState> {
    return new Map(this.states);
  }

  /** Places waiting, in order. */
  queued(): string[] {
    return [...this.waiting];
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** Add a place. False when it is already waiting or building: a place is never queued twice. */
  enqueue(place: string): boolean {
    if (this.running === place || this.waiting.includes(place)) return false;
    this.waiting.push(place);
    this.set(place, { kind: "queued" }, null);
    void this.pump();
    return true;
  }

  /** Forget every waiting place and every state; the running build's outcome is ignored. */
  clear(): void {
    this.epoch += 1;
    this.waiting = [];
    this.states.clear();
  }

  private set(place: string, state: BuildState, outcome: O | null) {
    this.states.set(place, state);
    this.onChange(place, state, outcome);
  }

  private async pump(): Promise<void> {
    if (this.running !== null) return;
    const next = this.waiting.shift();
    if (next === undefined) return;
    const epoch = this.epoch;
    this.running = next;
    this.set(next, { kind: "building" }, null);
    let outcome: O;
    try {
      outcome = await this.run(next, () => epoch === this.epoch);
    } catch {
      outcome = THROWN as unknown as O;
    }
    this.running = null;
    if (epoch === this.epoch) {
      this.set(next, outcome.kind === "built" ? { kind: "built" } : { kind: "failed", reason: outcome.reason }, outcome);
      if (outcome.kind === "failed" && outcome.reason === "unavailable") {
        const rest = this.waiting;
        this.waiting = [];
        for (const w of rest) this.set(w, { kind: "failed", reason: "unavailable" }, null);
      }
    }
    void this.pump();
  }
}
