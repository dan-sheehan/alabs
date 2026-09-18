import { describe, expect, it, vi } from "vitest";
import { buildRootView, ROOT_BUILD_KEY, type RootBuildIo } from "./rootBuild";
import { ROOT_INSTRUCTION } from "./rootEvidence";
import { MAX_ROOT_PLACES, readSavedRootMap } from "./rootMap";
import { classifyRoot, placeViewJsonPath } from "./places";
import type { HomeData } from "./launch";
import type { Entry, LocalModelResult } from "./subject";

// The root pipeline end to end over fakes: one model call with exactly the
// bounded evidence, the write only after every check, every failure kind
// with nothing written, a dropped highlight still written, the timings,
// and the queue key that can never be a place.

const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });

const CHILD_VIEW = JSON.stringify({
  version: 1,
  place: "defiance",
  title: "Defiance",
  summary: "A source-backed corpus for one season.",
  groups: [{ id: "query", label: "Query path", note: "" }],
  landmarks: [
    { id: "cli", groupId: "query", label: "CLI", note: "", paths: ["src/cli.py"] },
    { id: "web-ui", groupId: "query", label: "Web UI", note: "", paths: ["src/web.py"] },
  ],
  connections: [],
});

function home(): HomeData {
  return {
    listing: classifyRoot([dir("defiance"), dir("notes"), dir("context"), dir("wiki"), dir("views")]),
    views: new Set(["defiance"]),
    git: new Map([["defiance", "repo"]]),
    rootView: { exists: false, saved: null },
  };
}

const GOOD = JSON.stringify({
  version: 1,
  title: "alabs root",
  places: [
    { placeId: "defiance", description: "A corpus with a CLI.", highlightIds: ["cli", "web-ui"] },
    { placeId: "notes", description: "Plain notes.", highlightIds: [] },
  ],
  knowledge: [{ role: "Context" }, { role: "Wiki" }],
});

function fakeIo(answer: LocalModelResult | (() => Promise<LocalModelResult>), over: Partial<RootBuildIo> = {}) {
  const io: RootBuildIo = {
    readFile: vi.fn(async (rel: string) => {
      if (rel === placeViewJsonPath("defiance")) return { content: CHILD_VIEW };
      if (rel === "notes/README.md") return { content: "# Notes\n\nPlain notes." };
      throw `cannot read ${rel}: No such file or directory (os error 2)`;
    }),
    listDir: vi.fn(async (rel: string) => (rel === "notes" ? [{ name: "README.md", rel_path: "notes/README.md", is_dir: false }] : [])),
    generate: vi.fn(typeof answer === "function" ? answer : async () => answer),
    writeRootViewFiles: vi.fn(async () => {}),
    checkSvg: vi.fn((svg: string) => ({ kind: "ok" as const, landmarks: (svg.match(/data-landmark=/g) ?? []).length })),
    ...over,
  };
  return io;
}

const job = (replace = false) => ({ root: "/root", model: "chosen", replace, home: home() });

describe("a successful build", () => {
  it("makes one model call with the fixed instruction and the bounded evidence, then writes both files after every check", async () => {
    const io = fakeIo({ kind: "answer", text: GOOD, model: "chosen" });
    let clock = 0;
    const outcome = await buildRootView(io, job(), () => (clock += 10));
    expect(outcome.kind).toBe("built");
    if (outcome.kind !== "built") return;
    expect(io.generate).toHaveBeenCalledTimes(1);
    const [model, system, prompt] = vi.mocked(io.generate).mock.calls[0];
    expect(model).toBe("chosen");
    expect(system).toBe(ROOT_INSTRUCTION);
    expect(prompt).toContain("=== ALABS ROOT ===");
    expect(prompt).toContain("=== WORK PLACE defiance ===");
    expect(prompt).toContain("- cli · landmark · CLI");
    expect(prompt).toContain("=== WORK PLACE notes ===");
    expect(prompt).toContain("title: Notes");
    expect(prompt).toContain("- Context");
    // The prompt holds facts, never a repository's contents.
    expect(prompt).not.toContain("src/cli.py");
    expect(io.checkSvg).toHaveBeenCalledTimes(1);
    expect(io.writeRootViewFiles).toHaveBeenCalledTimes(1);
    const [root, json, svg, replace] = vi.mocked(io.writeRootViewFiles).mock.calls[0];
    expect(root).toBe("/root");
    expect(replace).toBe(false);
    expect(readSavedRootMap(json)).toEqual(outcome.map);
    expect(svg).toContain('data-landmark="defiance"');
    expect(svg).toContain('data-landmark="notes"');
    expect(svg).toContain('data-landmark="Context"');
    expect(svg).toContain("▪ CLI · Web UI");
    expect(outcome.places).toBe(2);
    expect(outcome.map.places.map((p) => [p.placeId, p.kind, p.description])).toEqual([
      ["defiance", "repo", "A corpus with a CLI."],
      ["notes", "none", "Plain notes."],
    ]);
    expect(outcome.timings).toEqual({ evidence: 10, model: 10, validate: 10, render: 10, total: 80 });
  });

  it("passes the Rebuild flag through and still writes a map that lost an unsupported highlight", async () => {
    const dropped = GOOD.replace('"highlightIds":["cli","web-ui"]', '"highlightIds":["cli","invented"]');
    const io = fakeIo({ kind: "answer", text: dropped, model: "chosen" });
    const outcome = await buildRootView(io, job(true));
    expect(outcome.kind).toBe("built");
    if (outcome.kind !== "built") return;
    expect(outcome.dropped.highlights).toBe(1);
    expect(outcome.map.places[0].highlights.map((h) => h.id)).toEqual(["cli"]);
    expect(vi.mocked(io.writeRootViewFiles).mock.calls[0][3]).toBe(true);
  });
});

describe("every failure leaves nothing written", () => {
  it.each([
    [{ kind: "unavailable" } as LocalModelResult, "unavailable"],
    [{ kind: "timeout" } as LocalModelResult, "timeout"],
    [{ kind: "not_installed", model: "chosen" } as LocalModelResult, "not_installed"],
    [{ kind: "failed", reason: "500" } as LocalModelResult, "model"],
  ])("a model result %o fails as %s", async (result, reason) => {
    const io = fakeIo(result);
    const outcome = await buildRootView(io, job());
    expect(outcome).toMatchObject({ kind: "failed", reason });
    expect(io.writeRootViewFiles).not.toHaveBeenCalled();
    expect(io.checkSvg).not.toHaveBeenCalled();
  });

  it("an answer that cannot be validated safely fails as invalid with the category", async () => {
    const io = fakeIo({ kind: "answer", text: GOOD.replace('{"placeId":"notes","description":"Plain notes.","highlightIds":[]}', ""), model: "chosen" });
    const outcome = await buildRootView(io, job());
    expect(outcome).toMatchObject({ kind: "failed", reason: "invalid", detail: "not JSON" });
    const missing = fakeIo({ kind: "answer", text: JSON.stringify({ version: 1, places: [{ placeId: "defiance" }], knowledge: [{ role: "Context" }, { role: "Wiki" }] }), model: "chosen" });
    expect(await buildRootView(missing, job())).toMatchObject({ kind: "failed", reason: "invalid", detail: "missing place" });
    expect(io.writeRootViewFiles).not.toHaveBeenCalled();
    expect(missing.writeRootViewFiles).not.toHaveBeenCalled();
  });

  it("a rendering the sanitizer refuses, or that lost a landmark, fails as render", async () => {
    const refused = fakeIo({ kind: "answer", text: GOOD, model: "chosen" }, { checkSvg: () => ({ kind: "invalid", reason: "no SVG drawing was found in it" }) });
    expect(await buildRootView(refused, job())).toMatchObject({ kind: "failed", reason: "render" });
    const short = fakeIo({ kind: "answer", text: GOOD, model: "chosen" }, { checkSvg: () => ({ kind: "ok", landmarks: 1 }) });
    expect(await buildRootView(short, job())).toMatchObject({ kind: "failed", reason: "render" });
    expect(refused.writeRootViewFiles).not.toHaveBeenCalled();
    expect(short.writeRootViewFiles).not.toHaveBeenCalled();
  });

  it("a refused write names a changed root or a write failure", async () => {
    const changed = fakeIo({ kind: "answer", text: GOOD, model: "chosen" }, { writeRootViewFiles: vi.fn(async () => { throw "the alabs root changed while the view was being built"; }) });
    expect(await buildRootView(changed, job())).toMatchObject({ kind: "failed", reason: "root_changed" });
    const denied = fakeIo({ kind: "answer", text: GOOD, model: "chosen" }, { writeRootViewFiles: vi.fn(async () => { throw "cannot write views/.root/map.svg: Permission denied"; }) });
    expect(await buildRootView(denied, job())).toMatchObject({ kind: "failed", reason: "write" });
  });

  it("a root over the place bound fails at evidence time, before any model call", async () => {
    const io = fakeIo({ kind: "answer", text: GOOD, model: "chosen" });
    const big = { ...job(), home: { ...home(), listing: classifyRoot(Array.from({ length: MAX_ROOT_PLACES + 1 }, (_, i) => dir(`p${i}`))) } };
    expect(await buildRootView(io, big)).toMatchObject({ kind: "failed", reason: "evidence", detail: "too many places" });
    expect(io.generate).not.toHaveBeenCalled();
  });

  it("a throwing model call is a model failure, and nothing is written", async () => {
    const io = fakeIo(async () => {
      throw new Error("bridge down");
    });
    await expect(buildRootView(io, job())).rejects.toThrow("bridge down");
    expect(io.writeRootViewFiles).not.toHaveBeenCalled();
  });
});

describe("the queue key", () => {
  it("is a dot name, so the places rule can never list it as a work place and no place's view folder can collide with it", () => {
    expect(ROOT_BUILD_KEY).toBe(".root");
    expect(classifyRoot([dir(".root"), dir("defiance")]).work.map((p) => p.name)).toEqual(["defiance"]);
  });
});

describe("the malformed knowledge answer observed from local Ollama", () => {
  const strings = JSON.stringify({ ...JSON.parse(GOOD), knowledge: ["Context", "Wiki"] });
  it("requests one correction and validates it before writing", async () => {
    const io = fakeIo({ kind: "answer", text: GOOD, model: "chosen" });
    vi.mocked(io.generate).mockResolvedValueOnce({ kind: "answer", text: strings, model: "chosen" });
    const result = await buildRootView(io, job());
    expect(result.kind).toBe("built");
    expect(io.generate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(io.generate).mock.calls[1][2]).toContain('"knowledge":[{"role":"Context"},{"role":"Wiki"}]');
    expect(io.writeRootViewFiles).toHaveBeenCalledTimes(1);
    expect(readSavedRootMap(vi.mocked(io.writeRootViewFiles).mock.calls[0][1])?.knowledge.map((k) => k.role)).toEqual(["context", "wiki"]);
  });
  it("stops after one correction, preserving the old files if it is still malformed", async () => {
    const io = fakeIo({ kind: "answer", text: strings, model: "chosen" });
    expect(await buildRootView(io, job(true))).toMatchObject({ kind: "failed", reason: "invalid", detail: "missing knowledge" });
    expect(io.generate).toHaveBeenCalledTimes(2);
    expect(io.writeRootViewFiles).not.toHaveBeenCalled();
  });
  it("does not relax any other validation on the corrected answer", async () => {
    const io = fakeIo({ kind: "answer", text: GOOD.replace('"placeId":"notes"', '"placeId":"invented"'), model: "chosen" });
    vi.mocked(io.generate).mockResolvedValueOnce({ kind: "answer", text: strings, model: "chosen" });
    expect(await buildRootView(io, job(true))).toMatchObject({ kind: "failed", reason: "invalid" });
    expect(io.generate).toHaveBeenCalledTimes(2);
    expect(io.writeRootViewFiles).not.toHaveBeenCalled();
  });
  it("surfaces a failed correction without retrying or writing", async () => {
    const io = fakeIo({ kind: "timeout" });
    vi.mocked(io.generate).mockResolvedValueOnce({ kind: "answer", text: strings, model: "chosen" });
    expect(await buildRootView(io, job(true))).toMatchObject({ kind: "failed", reason: "timeout" });
    expect(io.generate).toHaveBeenCalledTimes(2);
    expect(io.writeRootViewFiles).not.toHaveBeenCalled();
  });
});
