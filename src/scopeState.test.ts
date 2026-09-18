import { describe, expect, it } from "vitest";
import { addScope, allTabs, commit, freshScopes, knowScope, liveModelCount, placeStatus, scopeCounts, workScope } from "./scopeState";
import { closeTab, editorId, openTab, type Tab } from "./tabs";
import { classifyRoot, knowKey, workKey } from "./places";
import type { Entry } from "./subject";

const loaded = (relPath: string, dirty = false): Tab => ({
  kind: "loaded",
  relPath,
  name: relPath.split("/").pop() ?? relPath,
  stamp: { identity: "1:1", mtime_secs: 0, mtime_nanos: 0, len: 0 },
  savedVersion: 1,
  dirty,
  disk: "ok",
});

function twoScopes() {
  let scopes = addScope(freshScopes(), workScope(workKey("defiance"), "defiance", ["defiance/src"]));
  scopes = addScope(scopes, workScope(workKey("cockpit"), "cockpit", []));
  scopes = commit(scopes, workKey("defiance"), null, (s) => ({ ...s, tabs: openTab(s.tabs, loaded("defiance/a.py", true)) }));
  scopes = commit(scopes, workKey("cockpit"), null, (s) => ({ ...s, tabs: openTab(s.tabs, loaded("cockpit/b.md")) }));
  return scopes;
}

describe("commit", () => {
  it("updates only the named scope", () => {
    const before = twoScopes();
    const after = commit(before, workKey("defiance"), null, (s) => ({ ...s, selectedDir: "defiance/src" }));
    expect(after[workKey("defiance")].selectedDir).toBe("defiance/src");
    expect(after[workKey("cockpit")]).toBe(before[workKey("cockpit")]);
    expect(after.home).toBe(before.home);
  });

  it("a missing scope is stale: nothing changes and the same record is returned", () => {
    const before = twoScopes();
    let ran = false;
    const after = commit(before, workKey("gone"), null, (s) => {
      ran = true;
      return { ...s, selectedDir: "x" };
    });
    expect(after).toBe(before);
    expect(ran).toBe(false);
  });

  it("a target tab that is no longer open is stale: nothing changes", () => {
    const before = twoScopes();
    let ran = false;
    const after = commit(before, workKey("defiance"), editorId("defiance/closed.py"), (s) => {
      ran = true;
      return { ...s, selectedDir: "x" };
    });
    expect(after).toBe(before);
    expect(ran).toBe(false);
    // The same update with an open target lands.
    const landed = commit(before, workKey("defiance"), editorId("defiance/a.py"), (s) => ({ ...s, selectedDir: "x" }));
    expect(landed).not.toBe(before);
    expect(landed[workKey("defiance")].selectedDir).toBe("x");
  });

  it("a completion for a tab that was closed and never reopened cannot land in another scope", () => {
    const before = twoScopes();
    const after = commit(before, workKey("cockpit"), "defiance/a.py", (s) => ({ ...s, selectedDir: "wrong" }));
    expect(after).toBe(before);
    expect(after[workKey("cockpit")].selectedDir).toBe("cockpit");
  });

  it("an update that returns the same scope leaves the record identical", () => {
    const before = twoScopes();
    expect(commit(before, workKey("defiance"), null, (s) => s)).toBe(before);
  });
});

describe("scopes record", () => {
  it("fresh scopes hold Home only; addScope never replaces an existing scope", () => {
    const fresh = freshScopes();
    expect(Object.keys(fresh)).toEqual(["home"]);
    const scopes = twoScopes();
    const again = addScope(scopes, workScope(workKey("defiance"), "defiance", []));
    expect(again).toBe(scopes);
    expect(again[workKey("defiance")].tabs.tabs).toHaveLength(1);
  });

  it("lists every tab with its owner and counts unsaved per scope", () => {
    const scopes = twoScopes();
    expect(allTabs(scopes)).toEqual([
      { key: workKey("defiance"), relPath: "defiance/a.py" },
      { key: workKey("cockpit"), relPath: "cockpit/b.md" },
    ]);
    expect(scopeCounts(scopes[workKey("defiance")])).toEqual({ tabs: 1, unsaved: 1 });
    expect(scopeCounts(scopes[workKey("cockpit")])).toEqual({ tabs: 1, unsaved: 0 });
  });
});

const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });

describe("Step 3: knowledge scopes and place status", () => {
  it("a knowledge scope is bound to the folder it resolved and has its own tabs and search state", () => {
    const wiki = knowScope(knowKey("wiki"), "wiki", "Wiki", "Wiki", ["Wiki/notes"]);
    expect(wiki.kind).toBe("know");
    expect(wiki.name).toBe("Wiki");
    expect(wiki.prefix).toBe("Wiki");
    expect(wiki.role).toBe("wiki");
    expect(wiki.selectedDir).toBe("Wiki");
    expect(wiki.searching).toBe(false);
    expect(wiki.restored).toBe(false);
  });

  it("a work place is present under the same name only; another name is a different place", () => {
    const defiance = workScope(workKey("defiance"), "defiance", []);
    expect(placeStatus(defiance, classifyRoot([dir("defiance"), dir("cockpit")]))).toBe("present");
    expect(placeStatus(defiance, classifyRoot([dir("cockpit")]))).toBe("missing");
    expect(placeStatus(defiance, classifyRoot([dir("defiance2"), dir("Defiance")]))).toBe("missing");
    // Until the first listing exists nothing is missing, and Home never is.
    expect(placeStatus(defiance, null)).toBe("present");
    expect(placeStatus(freshScopes().home, classifyRoot([]))).toBe("present");
  });

  it("a live knowledge scope stays enterable through a conflict and is missing when its folder is gone or the role resolves elsewhere", () => {
    const wiki = knowScope(knowKey("wiki"), "wiki", "Wiki", "wiki", []);
    expect(placeStatus(wiki, classifyRoot([dir("wiki")]))).toBe("present");
    expect(placeStatus(wiki, classifyRoot([dir("wiki"), dir("Wiki")]))).toBe("conflict");
    expect(placeStatus(wiki, classifyRoot([dir("defiance")]))).toBe("missing");
    expect(placeStatus(wiki, classifyRoot([dir("Wiki")]))).toBe("missing");
    expect(placeStatus(wiki, classifyRoot([dir("Wiki"), dir("WIKI")]))).toBe("missing");
  });

  it("dirty buffers live in several scopes at once, and closing one scope's tab leaves the others untouched", () => {
    let scopes = twoScopes();
    scopes = addScope(scopes, knowScope(knowKey("wiki"), "wiki", "Wiki", "wiki", []));
    scopes = commit(scopes, knowKey("wiki"), null, (s) => ({ ...s, tabs: openTab(s.tabs, loaded("wiki/w.md", true)) }));
    scopes = commit(scopes, workKey("cockpit"), null, (s) => ({ ...s, tabs: openTab(s.tabs, loaded("cockpit/c.md", true)) }));
    expect(scopeCounts(scopes[workKey("defiance")]).unsaved).toBe(1);
    expect(scopeCounts(scopes[workKey("cockpit")]).unsaved).toBe(1);
    expect(scopeCounts(scopes[knowKey("wiki")]).unsaved).toBe(1);
    expect(liveModelCount(scopes)).toBe(4);
    const before = scopes;
    scopes = commit(scopes, workKey("cockpit"), editorId("cockpit/c.md"), (s) => ({ ...s, tabs: closeTab(s.tabs, editorId("cockpit/c.md")) }));
    expect(scopes[workKey("cockpit")].tabs.tabs.map((t) => t.relPath)).toEqual(["cockpit/b.md"]);
    expect(scopes[workKey("defiance")]).toBe(before[workKey("defiance")]);
    expect(scopes[knowKey("wiki")]).toBe(before[knowKey("wiki")]);
    expect(liveModelCount(scopes)).toBe(3);
    // Closing a path the scope does not hold is stale and changes nothing anywhere.
    expect(commit(scopes, workKey("cockpit"), "defiance/a.py", (s) => ({ ...s, tabs: closeTab(s.tabs, "defiance/a.py") }))).toBe(scopes);
  });
});
