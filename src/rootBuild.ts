/**
 * The root Visual View pipeline (the Home map), one build at a time on the
 * same queue as the place views:
 *
 * ```text
 * Home data (listing, kinds, existing views)
 *   → bounded root evidence            collectRootEvidence (rootEvidence.ts): saved child views, else Overview facts
 *   → selected local Ollama model       generate, JSON shape; one call plus one bounded knowledge-shape correction
 *   → structured JSON root map          the model's answer
 *   → structural validation             validateRootMap (rootMap.ts): every place once, only supplied ids
 *   → deterministic SVG renderer        renderRootSvg (rootRender.ts)
 *   → sanitizer                         the Stage 5 parseView, injected (it needs a DOM)
 *   → views/.root/view.json + map.svg   writeRootViewFiles: staged, then renamed into place
 * ```
 *
 * Nothing partial is ever written: a failure at any step leaves
 * `views/.root/` exactly as it was. An automatic build never replaces a map
 * that exists; a Rebuild replaces the old files only after the new map
 * passed every check. The model is whatever name the caller passes.
 */
import type { HomeData } from "./launch";
import type { LocalModelResult } from "./subject";
import { ROOT_VIEW_DIR } from "./places";
import { collectRootEvidence, roleFolders, ROOT_INSTRUCTION, rootPrompt, type RootEvidenceIo } from "./rootEvidence";
import { serializeRootMap, validateRootMap, type RootDropped, type RootMap } from "./rootMap";
import { renderRootSvg } from "./rootRender";
import type { BuildFailure } from "./viewBuild";

/** The key the root build takes on the one Visual View queue: a dot name, so it can never be a place. */
export const ROOT_BUILD_KEY = ROOT_VIEW_DIR;

/** Every call the pipeline makes, injectable for tests. Production binds the root-bounded bridge and the Stage 5 sanitizer. */
export interface RootBuildIo extends RootEvidenceIo {
  generate: (model: string, system: string, prompt: string) => Promise<LocalModelResult>;
  writeRootViewFiles: (expectedRoot: string, viewJson: string, mapSvg: string, replace: boolean) => Promise<void>;
  /** The existing sanitizer over the rendered text: how many landmarks survive it, or why it is not a usable map. */
  checkSvg: (svg: string) => { kind: "ok"; landmarks: number } | { kind: "invalid"; reason: string };
}

export interface RootBuildJob {
  /** The root the build started in; the write refuses another. */
  root: string;
  model: string;
  /** True for an explicit Rebuild: the existing map may be replaced. */
  replace: boolean;
  /** Home's data when the build's turn came: the current places, kinds and existing views. */
  home: HomeData;
}

/** Milliseconds per phase; a phase that did not run is null. */
export interface RootTimings {
  evidence: number | null;
  model: number | null;
  validate: number | null;
  render: number | null;
  total: number;
}

export type RootBuildOutcome =
  | { kind: "built"; map: RootMap; places: number; dropped: RootDropped; timings: RootTimings }
  /** `detail` is the validation category for `invalid`, or the evidence bound for `evidence`: one short fixed phrase, never content. */
  | { kind: "failed"; reason: BuildFailure; detail?: string; timings: RootTimings };

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

/** Run the whole pipeline once. Never rejects. */
export async function buildRootView(io: RootBuildIo, job: RootBuildJob, now: () => number = () => Date.now()): Promise<RootBuildOutcome> {
  const start = now();
  const timings: RootTimings = { evidence: null, model: null, validate: null, render: null, total: 0 };
  const fail = (reason: BuildFailure, detail?: string): RootBuildOutcome => {
    timings.total = now() - start;
    return detail === undefined ? { kind: "failed", reason, timings } : { kind: "failed", reason, detail, timings };
  };

  // Evidence: what alabs already knows, bounded.
  let evidence;
  try {
    evidence = await collectRootEvidence(io, job.home);
  } catch (err) {
    return fail("evidence", /too many places/.test(String(err)) ? "too many places" : undefined);
  }
  timings.evidence = now() - start;

  // The model call. A malformed knowledge shape gets one correction below.
  const modelAt = now();
  const answer = await io.generate(job.model, ROOT_INSTRUCTION, rootPrompt(evidence));
  timings.model = now() - modelAt;
  if (answer.kind !== "answer") return fail(modelFailure(answer));

  // Validation: the inventory must be exactly the root's; unsupported extras are dropped.
  const validateAt = now();
  let validation = validateRootMap(answer.text, evidence, roleFolders(job.home));
  timings.validate = now() - validateAt;
  // A model can return role names as strings despite the requested object shape.
  // Correct that specific observed failure once; never accept it, relax the
  // validator, retry transport failures, or write a partial answer.
  if (validation.kind === "rejected" && validation.reason === "missing knowledge") {
    const correctionAt = now();
    const corrected = await io.generate(job.model, ROOT_INSTRUCTION,
      `${rootPrompt(evidence)}\n\nThe previous answer had an invalid knowledge field. Return the complete root map again with the exact knowledge objects above.`);
    timings.model += now() - correctionAt;
    if (corrected.kind !== "answer") return fail(modelFailure(corrected));
    const checkAt = now();
    validation = validateRootMap(corrected.text, evidence, roleFolders(job.home));
    timings.validate += now() - checkAt;
  }
  if (validation.kind === "rejected") return fail("invalid", validation.reason);

  // Rendering, then the same sanitizer the surface uses.
  const renderAt = now();
  const svg = renderRootSvg(validation.map);
  const check = io.checkSvg(svg);
  timings.render = now() - renderAt;
  const expected = validation.map.places.length + validation.map.knowledge.length;
  if (check.kind !== "ok" || check.landmarks !== expected) return fail("render");

  // Only now do the files land.
  try {
    await io.writeRootViewFiles(job.root, serializeRootMap(validation.map), svg, job.replace);
  } catch (err) {
    return fail(/root changed/.test(String(err)) ? "root_changed" : "write");
  }
  timings.total = now() - start;
  return { kind: "built", map: validation.map, places: validation.map.places.length, dropped: validation.dropped, timings };
}
