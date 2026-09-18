import { describe, expect, it } from "vitest";
import {
  EMPTY_LAYOUT,
  EMPTY_STATE,
  MAX_EXPANDED,
  MAX_SCOPES,
  MAX_TABS,
  parseState,
  parseTabId,
  scopeLayout,
  serializeState,
  setActiveWork,
  setRoot,
  setScopeLayout,
  tabId,
  type UiState,
} from "./uiState";

const layout = {
  expanded: ["defiance/src", "defiance/src/lib"],
  tabs: ["editor:defiance/README.md", "editor:defiance/src/a.ts"],
  active: "editor:defiance/src/a.ts",
  views: { "editor:defiance/src/a.ts": { line: 12, column: 4, scrollTop: 240 } },
  visited: 1000,
};

function full(): UiState {
  let state = setRoot(EMPTY_STATE, "/root");
  state = setActiveWork(state, "defiance");
  state = setScopeLayout(state, "work:defiance", layout);
  state = setScopeLayout(state, "home", { ...EMPTY_LAYOUT, visited: 5 });
  return { ...state, baselines: { defiance: { commit: "abc123", at: 1700000000000, clean: true } }, localModel: "small:1b" };
}

describe("parseState version 2", () => {
  it("a missing file is a silent fresh start", () => {
    expect(parseState(null)).toEqual({ state: EMPTY_STATE, fallback: null });
    expect(parseState(undefined)).toEqual({ state: EMPTY_STATE, fallback: null });
  });

  it("round-trips the full shape: root, activeWork, scopes, baselines", () => {
    const state = full();
    const parsed = parseState(serializeState(state));
    expect(parsed).toEqual({ state, fallback: null });
    expect(parsed.state.version).toBe(2);
    expect(parsed.state.root).toBe("/root");
    expect(parsed.state.activeWork).toBe("defiance");
    expect(parsed.state.scopes["work:defiance"]).toEqual(layout);
    expect(parsed.state.baselines.defiance).toEqual({ commit: "abc123", at: 1700000000000, clean: true });
    expect(parsed.state.localModel).toBe("small:1b");
  });

  it("the remembered local model survives a restart as the name only, is null when absent or blank, and is kept across roots", () => {
    expect(parseState(JSON.stringify({ version: 2, root: "/root", scopes: {}, baselines: {} })).state.localModel).toBeNull();
    expect(parseState(JSON.stringify({ version: 2, root: "/root", localModel: "  " })).state.localModel).toBeNull();
    expect(parseState(JSON.stringify({ version: 2, root: "/root", localModel: 3 })).state.localModel).toBeNull();
    expect(parseState(JSON.stringify({ version: 2, root: null, localModel: "small:1b" })).state.localModel).toBe("small:1b");
    const text = serializeState(full());
    expect(JSON.parse(text).localModel).toBe("small:1b");
    expect(text).not.toContain("prompt");
    expect(setRoot(full(), "/elsewhere").localModel).toBe("small:1b");
  });

  it("a version 1 file falls back to the empty state and names why", () => {
    const v1 = JSON.stringify({ version: 1, recent: ["/old"], subjects: { "/old": { tabs: ["x.md"] } } });
    const parsed = parseState(v1);
    expect(parsed.state).toEqual(EMPTY_STATE);
    expect(parsed.fallback).toMatch(/version 1/);
    expect(parsed.state.root).toBeNull();
    expect(Object.keys(parsed.state.scopes)).toEqual([]);
  });

  it("invalid text, a non-object and an unknown version fall back with a reason", () => {
    expect(parseState("{not json").fallback).toMatch(/not valid JSON/);
    expect(parseState("[]").fallback).toMatch(/not an object/);
    expect(parseState('{"version":99}').fallback).toMatch(/version 99/);
    for (const text of ["{not json", "[]", '{"version":99}']) expect(parseState(text).state).toEqual(EMPTY_STATE);
  });

  it("a load error reaches the fallback path with its reason", () => {
    const parsed = parseState(null, "cannot read ui state: larger than 1 MB");
    expect(parsed.state).toEqual(EMPTY_STATE);
    expect(parsed.fallback).toBe("saved layout could not be read: cannot read ui state: larger than 1 MB");
    // The error wins even when text was also handed over.
    expect(parseState(serializeState(full()), "boom").state).toEqual(EMPTY_STATE);
  });

  it("drops tabs of unknown kinds and malformed ids, keeps editor, markdown, view, task and changes tabs", () => {
    const text = JSON.stringify({
      version: 2,
      root: "/root",
      activeWork: null,
      scopes: {
        "work:defiance": {
          tabs: ["editor:defiance/a.ts", "markdown:defiance/README.md", "view:views/defiance/map.svg", "task:defiance", "changes:defiance", "terminal:defiance", "nokind", ":x", "editor:", "editor:defiance/a.ts"],
          active: "markdown:defiance/README.md",
          views: { "markdown:defiance/README.md": { line: 1, column: 1, scrollTop: 0 } },
        },
      },
      baselines: {},
    });
    const { state, fallback } = parseState(text);
    expect(fallback).toBeNull();
    expect(state.scopes["work:defiance"].tabs).toEqual([
      "editor:defiance/a.ts",
      "markdown:defiance/README.md",
      "view:views/defiance/map.svg",
      "task:defiance",
      "changes:defiance",
    ]);
    expect(state.scopes["work:defiance"].active).toBe("markdown:defiance/README.md");
    // A cursor stored under a Markdown tab means nothing and is dropped.
    expect(state.scopes["work:defiance"].views).toEqual({});
    expect(state.scopes["work:defiance"].tabs).not.toContain("terminal:defiance");
  });

  it("drops scopes with invalid keys and baselines that are not for a place", () => {
    const text = JSON.stringify({
      version: 2,
      root: "/root",
      activeWork: "bad/name",
      scopes: { home: {}, "work:defiance": {}, "work:": {}, "know:nope": {}, "views": {}, "work:a/b": {} },
      baselines: { defiance: { commit: "x", at: 1, clean: false }, "a/b": { commit: "x", at: 1, clean: true }, cockpit: { commit: "", at: 1, clean: true } },
    });
    const { state } = parseState(text);
    expect(Object.keys(state.scopes).sort()).toEqual(["home", "work:defiance"]);
    expect(Object.keys(state.baselines)).toEqual(["defiance"]);
    expect(state.activeWork).toBeNull();
  });

  it("caps tabs and expanded per scope", () => {
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    const text = JSON.stringify({
      version: 2,
      root: "/root",
      activeWork: null,
      scopes: { "work:p": { tabs: many(MAX_TABS + 5, "editor:p/t"), expanded: many(MAX_EXPANDED + 5, "p/d") } },
      baselines: {},
    });
    const { state } = parseState(text);
    expect(state.scopes["work:p"].tabs).toHaveLength(MAX_TABS);
    expect(state.scopes["work:p"].expanded).toHaveLength(MAX_EXPANDED);
    expect(state.scopes["work:p"].tabs.length).not.toBe(MAX_TABS + 5);
  });

  it("keeps at most 40 scope layouts, the most recently visited, and always Home", () => {
    const scopes: Record<string, unknown> = { home: { visited: 0 } };
    for (let i = 0; i < MAX_SCOPES + 10; i++) scopes[`work:p${i}`] = { visited: i };
    const { state } = parseState(JSON.stringify({ version: 2, root: "/root", activeWork: null, scopes, baselines: {} }));
    const keys = Object.keys(state.scopes);
    expect(keys).toHaveLength(MAX_SCOPES);
    expect(keys).toContain("home");
    expect(keys).toContain(`work:p${MAX_SCOPES + 9}`);
    expect(keys).not.toContain("work:p0");
    expect(keys).not.toContain("work:p10");
  });

  it("without a root nothing else is kept", () => {
    const { state } = parseState(JSON.stringify({ version: 2, root: null, activeWork: "x", scopes: { home: {} }, baselines: {} }));
    expect(state).toEqual(EMPTY_STATE);
    const relative = parseState(JSON.stringify({ version: 2, root: "relative", activeWork: null, scopes: {}, baselines: {} }));
    expect(relative.state.root).toBeNull();
  });

  it("repairs an active tab that is not open and views for unknown tabs", () => {
    const text = JSON.stringify({
      version: 2,
      root: "/root",
      activeWork: null,
      scopes: {
        "work:a": {
          tabs: ["editor:a/x.md"],
          active: "editor:a/y.md",
          views: { "editor:a/x.md": { line: 0, column: -2, scrollTop: "far" }, "editor:a/y.md": { line: 1, column: 1, scrollTop: 0 } },
        },
      },
      baselines: {},
    });
    expect(parseState(text).state.scopes["work:a"]).toEqual({ expanded: [], tabs: ["editor:a/x.md"], active: "editor:a/x.md", views: {}, visited: 0 });
  });
});

describe("setScopeLayout and friends", () => {
  it("caps tabs, drops views for closed tabs and unknown kinds, clears an active tab that is not open", () => {
    const tabs = Array.from({ length: MAX_TABS + 3 }, (_, i) => `editor:a/t${i}.md`);
    const state = setScopeLayout(setRoot(EMPTY_STATE, "/r"), "work:a", {
      expanded: [],
      tabs: [...tabs, "markdown:a/README.md"],
      active: `editor:a/t${MAX_TABS + 1}.md`,
      views: { "editor:a/t0.md": layout.views["editor:defiance/src/a.ts"], "editor:a/t99.md": layout.views["editor:defiance/src/a.ts"] },
      visited: 3,
    });
    const saved = state.scopes["work:a"];
    expect(saved.tabs).toHaveLength(MAX_TABS);
    expect(saved.tabs).not.toContain("markdown:a/README.md");
    expect(saved.active).toBeNull();
    expect(Object.keys(saved.views)).toEqual(["editor:a/t0.md"]);
    expect(scopeLayout(state, "work:missing")).toEqual(EMPTY_LAYOUT);
  });

  it("a different root forgets the old root's layouts, the same root keeps them", () => {
    const state = full();
    expect(setRoot(state, "/root")).toBe(state);
    const moved = setRoot(state, "/other");
    expect(moved.root).toBe("/other");
    expect(moved.scopes).toEqual({});
    expect(moved.activeWork).toBeNull();
    expect(moved.baselines).toEqual({});
  });

  it("tab ids are kind:path", () => {
    expect(tabId("editor", "a/b.ts")).toBe("editor:a/b.ts");
    expect(parseTabId("editor:a/b:c.ts")).toEqual({ kind: "editor", path: "a/b:c.ts" });
    expect(parseTabId("view:views/a/map.svg")).toEqual({ kind: "view", path: "views/a/map.svg" });
    expect(parseTabId("terminal:a")).toBeNull();
    expect(parseTabId("editor:")).toBeNull();
  });
});

describe("setBaseline", () => {
  it("records a place's handoff baseline, replaces an earlier one for the same place, keeps other places, and never task text", async () => {
    const { setBaseline } = await import("./uiState");
    let state = setRoot(EMPTY_STATE, "/root");
    state = setBaseline(state, "defiance", { commit: "a".repeat(40), at: 10, clean: true });
    state = setBaseline(state, "cockpit", { commit: "b".repeat(40), at: 11, clean: false });
    state = setBaseline(state, "defiance", { commit: "c".repeat(40), at: 12, clean: false });
    expect(state.baselines).toEqual({
      defiance: { commit: "c".repeat(40), at: 12, clean: false },
      cockpit: { commit: "b".repeat(40), at: 11, clean: false },
    });
    const text = serializeState(state);
    expect(JSON.parse(text).baselines.defiance.commit).toBe("c".repeat(40));
    expect(Object.keys(JSON.parse(text).baselines.defiance)).toEqual(["commit", "at", "clean"]);
    // A new root starts with no baselines.
    expect(setRoot(state, "/elsewhere").baselines).toEqual({});
  });
});

describe("setLocalModel", () => {
  it("remembers a choice, clears it with null, and changes nothing else", async () => {
    const { setLocalModel } = await import("./uiState");
    const state = setRoot(EMPTY_STATE, "/root");
    const chosen = setLocalModel(state, "small:1b");
    expect(chosen.localModel).toBe("small:1b");
    expect({ ...chosen, localModel: null }).toEqual(state);
    expect(setLocalModel(chosen, "small:1b")).toBe(chosen);
    expect(setLocalModel(chosen, null).localModel).toBeNull();
  });
});
