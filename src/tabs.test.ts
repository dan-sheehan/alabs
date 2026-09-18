import { describe, expect, it } from "vitest";
import {
  activateTab,
  closeTab,
  closeTabsUnder,
  destinationCollision,
  dirtyTabs,
  editorId,
  EMPTY_TABS,
  findEditorTab,
  findTab,
  idOf,
  isAtOrUnder,
  markdownId,
  movedPath,
  moveTabs,
  openTab,
  parseId,
  reconcileOutcome,
  stampsEqual,
  updateTab,
  type Tab,
} from "./tabs";

const stamp = { identity: "1:2", mtime_secs: 0, mtime_nanos: 0, len: 0 };

function loaded(relPath: string, dirty = false): Tab {
  return { kind: "loaded", relPath, name: relPath.split("/").pop()!, stamp, savedVersion: 1, dirty, disk: "ok" };
}

function unsupported(relPath: string): Tab {
  return { kind: "unsupported", relPath, name: relPath, message: "not a UTF-8 text file: " + relPath };
}

function markdown(relPath: string): Tab {
  return { kind: "markdown", relPath, name: relPath.split("/").pop()! };
}

describe("openTab", () => {
  it("appends a new tab and activates it", () => {
    const state = openTab(openTab(EMPTY_TABS, loaded("a.md")), loaded("b.md"));
    expect(state.tabs.map((t) => t.relPath)).toEqual(["a.md", "b.md"]);
    expect(state.active).toBe(editorId("b.md"));
  });

  it("activates an existing tab instead of duplicating it", () => {
    const state = openTab(openTab(EMPTY_TABS, loaded("a.md")), loaded("b.md"));
    const again = openTab(state, loaded("a.md", true));
    expect(again.tabs).toEqual(state.tabs);
    expect(again.active).toBe(editorId("a.md"));
  });

  it("accepts unsupported tabs", () => {
    const state = openTab(EMPTY_TABS, unsupported("blob.bin"));
    expect(state.tabs[0].kind).toBe("unsupported");
    expect(state.active).toBe(editorId("blob.bin"));
  });
});

describe("activateTab", () => {
  it("ignores unknown ids", () => {
    const state = openTab(EMPTY_TABS, loaded("a.md"));
    expect(activateTab(state, editorId("missing.md"))).toBe(state);
  });
});

describe("closeTab", () => {
  const three = openTab(openTab(openTab(EMPTY_TABS, loaded("a.md")), loaded("b.md")), loaded("c.md"));

  it("keeps the active tab when closing another", () => {
    const state = closeTab(activateTab(three, editorId("a.md")), editorId("c.md"));
    expect(state.tabs.map((t) => t.relPath)).toEqual(["a.md", "b.md"]);
    expect(state.active).toBe(editorId("a.md"));
  });

  it("activates the left neighbour when closing the active tab", () => {
    const state = closeTab(activateTab(three, editorId("b.md")), editorId("b.md"));
    expect(state.active).toBe(editorId("a.md"));
  });

  it("activates the right neighbour when closing the first active tab", () => {
    const state = closeTab(activateTab(three, editorId("a.md")), editorId("a.md"));
    expect(state.active).toBe(editorId("b.md"));
  });

  it("clears the active path when closing the last tab", () => {
    const state = closeTab(openTab(EMPTY_TABS, loaded("a.md")), editorId("a.md"));
    expect(state).toEqual(EMPTY_TABS);
  });

  it("ignores unknown paths", () => {
    expect(closeTab(three, editorId("missing.md"))).toBe(three);
  });
});

describe("updateTab and dirtyTabs", () => {
  it("marks one tab dirty without touching the others", () => {
    const state = openTab(openTab(EMPTY_TABS, loaded("a.md")), loaded("b.md"));
    const next = updateTab(state, editorId("a.md"), (tab) => (tab.kind === "loaded" ? { ...tab, dirty: true } : tab));
    expect(dirtyTabs(next).map((t) => t.relPath)).toEqual(["a.md"]);
    expect(next.tabs[1]).toBe(state.tabs[1]);
  });

  it("never reports unsupported tabs as dirty", () => {
    const state = openTab(EMPTY_TABS, unsupported("blob.bin"));
    expect(dirtyTabs(state)).toEqual([]);
  });
});

describe("movedPath", () => {
  it("maps the item itself and its descendants", () => {
    expect(movedPath("a.md", "a.md", "b.md")).toBe("b.md");
    expect(movedPath("docs/x/y.md", "docs", "notes")).toBe("notes/x/y.md");
    expect(movedPath("docs/x/y.md", "docs", "archive/docs")).toBe("archive/docs/x/y.md");
  });

  it("leaves unrelated and prefix-similar paths alone", () => {
    expect(movedPath("other.md", "a.md", "b.md")).toBeNull();
    expect(movedPath("docs2/y.md", "docs", "notes")).toBeNull();
    expect(movedPath("doc", "docs", "notes")).toBeNull();
  });
});

describe("moveTabs", () => {
  it("renames a file tab and keeps it active and dirty", () => {
    const state = openTab(openTab(EMPTY_TABS, loaded("a.md", true)), loaded("b.md"));
    const next = moveTabs(activateTab(state, editorId("a.md")), "a.md", "src/c.md");
    expect(next.tabs.map((t) => t.relPath)).toEqual(["src/c.md", "b.md"]);
    expect(next.tabs[0]).toMatchObject({ name: "c.md", dirty: true, savedVersion: 1 });
    expect(next.tabs[1]).toBe(state.tabs[1]);
    expect(next.active).toBe(editorId("src/c.md"));
  });

  it("leaves kept tabs at their old path", () => {
    const state = openTab(openTab(EMPTY_TABS, loaded("docs/a.md", true)), loaded("docs/b.md"));
    const next = moveTabs(activateTab(state, editorId("docs/a.md")), "docs", "notes", new Set(["docs/a.md"]));
    expect(next.tabs.map((t) => t.relPath)).toEqual(["docs/a.md", "notes/b.md"]);
    expect(next.tabs[0]).toBe(state.tabs[0]);
    expect(next.active).toBe(editorId("docs/a.md"));
  });

  it("re-keys every tab under a moved folder", () => {
    const state = openTab(
      openTab(openTab(EMPTY_TABS, loaded("docs/a.md")), unsupported("docs/img/b.png")),
      loaded("x.md"),
    );
    const next = moveTabs(state, "docs", "old/docs");
    expect(next.tabs.map((t) => t.relPath)).toEqual(["old/docs/a.md", "old/docs/img/b.png", "x.md"]);
    expect(next.tabs[1].name).toBe("b.png");
    expect(next.active).toBe(editorId("x.md"));
  });
});

describe("isAtOrUnder", () => {
  it("matches the path itself and its descendants only", () => {
    expect(isAtOrUnder("src", "src")).toBe(true);
    expect(isAtOrUnder("src/a.ts", "src")).toBe(true);
    expect(isAtOrUnder("src/deep/a.ts", "src")).toBe(true);
    expect(isAtOrUnder("src2/a.ts", "src")).toBe(false);
    expect(isAtOrUnder("a.ts", "src")).toBe(false);
  });
});

describe("destinationCollision", () => {
  it("is free when nothing is open at the destination", () => {
    expect(destinationCollision(["a.md", "docs/b.md"], "a.md", "c.md")).toBeNull();
    expect(destinationCollision([], "a.md", "c.md")).toBeNull();
  });

  it("reports a file open at the destination, even if its disk file is gone", () => {
    expect(destinationCollision(["a.md", "c.md"], "a.md", "c.md")).toBe("c.md");
  });

  it("reports a tab inside a folder that a folder move would land on", () => {
    expect(destinationCollision(["old/docs/x.md"], "docs", "old/docs")).toBe("old/docs/x.md");
    expect(destinationCollision(["archive/docs/deep/y.md"], "docs", "archive/docs")).toBe("archive/docs/deep/y.md");
  });

  it("reports a tab at a destination folder path itself", () => {
    expect(destinationCollision(["notes"], "docs", "notes")).toBe("notes");
  });

  it("lets tabs that move along pass and ignores prefix-similar paths", () => {
    expect(destinationCollision(["docs/a.md", "docs/img/b.png"], "docs", "notes")).toBeNull();
    expect(destinationCollision(["notes2/a.md", "note"], "docs", "notes")).toBeNull();
    // A rename that changes only case keeps the moved tab out of the check.
    expect(destinationCollision(["readme.md"], "readme.md", "README.md")).toBeNull();
  });
});

describe("closeTabsUnder", () => {
  const four = [loaded("a.md"), loaded("src/b.ts", true), loaded("src/deep/c.ts"), loaded("d.md")];

  it("closes a single file tab and activates the one to its left", () => {
    const state = { tabs: four, active: editorId("src/b.ts") };
    const next = closeTabsUnder(state, "src/b.ts");
    expect(next.tabs.map((t) => t.relPath)).toEqual(["a.md", "src/deep/c.ts", "d.md"]);
    expect(next.active).toBe(editorId("a.md"));
  });

  it("closes every tab under a folder, skipping removed tabs when choosing the next active one", () => {
    const state = { tabs: four, active: editorId("src/b.ts") };
    const next = closeTabsUnder(state, "src");
    expect(next.tabs.map((t) => t.relPath)).toEqual(["a.md", "d.md"]);
    expect(next.active).toBe(editorId("a.md"));
  });

  it("falls back to the right when nothing survives on the left", () => {
    const state = { tabs: [loaded("src/b.ts"), loaded("src/c.ts"), loaded("d.md")], active: editorId("src/b.ts") };
    const next = closeTabsUnder(state, "src");
    expect(next.tabs.map((t) => t.relPath)).toEqual(["d.md"]);
    expect(next.active).toBe(editorId("d.md"));
  });

  it("keeps the active tab when it is unaffected", () => {
    const state = { tabs: four, active: editorId("d.md") };
    expect(closeTabsUnder(state, "src").active).toBe(editorId("d.md"));
  });

  it("leaves no active tab when every tab is closed", () => {
    const state = { tabs: [loaded("src/b.ts")], active: editorId("src/b.ts") };
    expect(closeTabsUnder(state, "src")).toEqual(EMPTY_TABS);
  });

  it("does not touch sibling paths that merely share a prefix", () => {
    const state = { tabs: [loaded("src2/x.ts"), loaded("src/y.ts")], active: editorId("src2/x.ts") };
    const next = closeTabsUnder(state, "src");
    expect(next.tabs.map((t) => t.relPath)).toEqual(["src2/x.ts"]);
    expect(next.active).toBe(editorId("src2/x.ts"));
  });
});

describe("tab ids", () => {
  it("are kind:path, distinct per kind, and parse back", () => {
    expect(idOf(loaded("a.md"))).toBe("editor:a.md");
    expect(idOf(unsupported("a.md"))).toBe("editor:a.md");
    expect(idOf(markdown("a.md"))).toBe("markdown:a.md");
    expect(parseId("markdown:docs/x.md")).toEqual({ kind: "markdown", relPath: "docs/x.md" });
    expect(parseId("editor:a.md")).toEqual({ kind: "editor", relPath: "a.md" });
    expect(parseId("view:views/defiance/map.svg")).toEqual({ kind: "view", relPath: "views/defiance/map.svg" });
    expect(parseId("task:defiance")).toEqual({ kind: "task", relPath: "defiance" });
    expect(parseId("changes:defiance")).toEqual({ kind: "changes", relPath: "defiance" });
    expect(parseId("other:a.svg")).toBeNull();
    expect(parseId("editor:")).toBeNull();
    expect(parseId("a.md")).toBeNull();
  });

  it("a Markdown tab and an Editor tab for the same path are two tabs", () => {
    const state = openTab(openTab(EMPTY_TABS, markdown("README.md")), loaded("README.md", true));
    expect(state.tabs).toHaveLength(2);
    expect(state.active).toBe(editorId("README.md"));
    expect(findTab(state, markdownId("README.md"))?.kind).toBe("markdown");
    expect(findEditorTab(state, "README.md")?.kind).toBe("loaded");
    // Opening the rendered view again activates it, never a third tab.
    const again = openTab(state, markdown("README.md"));
    expect(again.tabs).toHaveLength(2);
    expect(again.active).toBe(markdownId("README.md"));
    // Closing one leaves the other; dirty tracking sees only the editor.
    const closed = closeTab(again, markdownId("README.md"));
    expect(closed.tabs.map(idOf)).toEqual([editorId("README.md")]);
    expect(closed.active).toBe(editorId("README.md"));
    expect(dirtyTabs(again).map(idOf)).toEqual([editorId("README.md")]);
  });

  it("Markdown tabs follow a rename and close with a trashed folder like editor tabs", () => {
    const state = openTab(openTab(EMPTY_TABS, markdown("docs/a.md")), loaded("docs/a.md"));
    const moved = moveTabs(activateTab(state, markdownId("docs/a.md")), "docs", "notes");
    expect(moved.tabs.map(idOf)).toEqual([markdownId("notes/a.md"), editorId("notes/a.md")]);
    expect(moved.active).toBe(markdownId("notes/a.md"));
    const gone = closeTabsUnder(openTab(moved, loaded("x.md")), "notes");
    expect(gone.tabs.map(idOf)).toEqual([editorId("x.md")]);
    expect(gone.active).toBe(editorId("x.md"));
    expect(reconcileOutcome(markdown("a.md"), null)).toBe("unchanged");
  });
});

describe("stampsEqual", () => {
  it("compares every field", () => {
    expect(stampsEqual(stamp, { ...stamp })).toBe(true);
    expect(stampsEqual(stamp, { ...stamp, identity: "1:3" })).toBe(false);
    expect(stampsEqual(stamp, { ...stamp, identity: "2:2" })).toBe(false);
    expect(stampsEqual(stamp, { ...stamp, mtime_secs: 1 })).toBe(false);
    expect(stampsEqual(stamp, { ...stamp, mtime_nanos: 1 })).toBe(false);
    expect(stampsEqual(stamp, { ...stamp, len: 1 })).toBe(false);
  });
});

describe("reconcileOutcome", () => {
  const changed = { ...stamp, mtime_secs: 5, len: 9 };

  it("leaves a tab alone when the disk stamp still matches", () => {
    expect(reconcileOutcome(loaded("a.md"), stamp)).toBe("unchanged");
    expect(reconcileOutcome(loaded("a.md", true), stamp)).toBe("unchanged");
  });

  it("reloads a clean tab whose file changed on disk", () => {
    expect(reconcileOutcome(loaded("a.md"), changed)).toBe("reload");
  });

  it("detects a replaced file even when its size and modification time match", () => {
    const replacement = { ...stamp, identity: "1:3" };
    expect(reconcileOutcome(loaded("a.md"), replacement)).toBe("reload");
    expect(reconcileOutcome(loaded("a.md", true), replacement)).toBe("conflict");
  });

  it("never reloads a dirty tab; it reports a conflict instead", () => {
    expect(reconcileOutcome(loaded("a.md", true), changed)).toBe("conflict");
  });

  it("reports a missing file for clean and dirty tabs alike", () => {
    expect(reconcileOutcome(loaded("a.md"), null)).toBe("missing");
    expect(reconcileOutcome(loaded("a.md", true), null)).toBe("missing");
  });

  it("ignores unsupported tabs", () => {
    expect(reconcileOutcome(unsupported("blob.bin"), null)).toBe("unchanged");
    expect(reconcileOutcome(unsupported("blob.bin"), changed)).toBe("unchanged");
  });
});
