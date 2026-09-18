import { describe, expect, it } from "vitest";
import { addScope, freshScopes, knowScope, workScope, type Scope, type Scopes } from "./scopeState";
import { openTab, type Tab } from "./tabs";
import { contextCandidates, copyBlocker, EMPTY_DRAFT, selectedContext, taskPacket } from "./task";

// The Task tab's pure logic (DESIGN.md 6.10): which open tabs may be
// context, in which order, what blocks Copy, and the packet text.

const stamp = { identity: "1:2", mtime_secs: 0, mtime_nanos: 0, len: 0 };
const loaded = (relPath: string, dirty = false): Tab => ({ kind: "loaded", relPath, name: relPath.split("/").pop()!, stamp, savedVersion: 1, dirty, disk: "ok" });
const markdown = (relPath: string): Tab => ({ kind: "markdown", relPath, name: relPath.split("/").pop()! });
const unsupported = (relPath: string): Tab => ({ kind: "unsupported", relPath, name: relPath, message: "not a UTF-8 text file" });

function withTabs(scope: Scope, ...tabs: Tab[]): Scope {
  let state = scope.tabs;
  for (const tab of tabs) state = openTab(state, tab);
  return { ...scope, tabs: state };
}

function scopes(): Scopes {
  let s = freshScopes();
  s = addScope(
    s,
    withTabs(
      workScope("work:defiance", "defiance", []),
      loaded("defiance/src/b.py"),
      { kind: "task", relPath: "defiance", name: "Task" },
      markdown("defiance/README.md"),
      { kind: "changes", relPath: "defiance", name: "Changes" },
      { kind: "view", relPath: "views/defiance/map.svg", name: "defiance" },
      loaded("defiance/README.md", true),
      loaded("defiance/src/a.py"),
      unsupported("defiance/big.bin"),
    ),
  );
  s = addScope(s, withTabs(workScope("work:cockpit", "cockpit", []), loaded("cockpit/notes.txt")));
  s = addScope(s, withTabs(knowScope("know:definitions", "definitions", "Definitions", "definitions", []), loaded("definitions/git.md")));
  s = addScope(s, withTabs(knowScope("know:wiki", "wiki", "Wiki", "wiki", []), markdown("wiki/monaco.md"), loaded("wiki/tauri.md", true)));
  return s;
}

describe("contextCandidates", () => {
  it("lists file-backed tabs of the work place then Context, Wiki, Definitions in strip order, one row per path, never a surface or another work place", () => {
    const rows = contextCandidates(scopes(), "work:defiance");
    expect(rows.map((r) => r.relPath)).toEqual([
      "defiance/src/b.py",
      "defiance/README.md",
      "defiance/src/a.py",
      "wiki/monaco.md",
      "wiki/tauri.md",
      "definitions/git.md",
    ]);
    expect(rows.map((r) => r.relPath)).not.toContain("cockpit/notes.txt");
    expect(rows.map((r) => r.relPath)).not.toContain("views/defiance/map.svg");
    expect(rows.map((r) => r.relPath)).not.toContain("defiance");
    expect(rows.map((r) => r.relPath)).not.toContain("defiance/big.bin");
  });

  it("marks a path dirty when its Editor tab has unsaved edits, even when its rendered tab came first", () => {
    const rows = contextCandidates(scopes(), "work:defiance");
    const dirty = rows.filter((r) => r.dirty).map((r) => r.relPath);
    expect(dirty).toEqual(["defiance/README.md", "wiki/tauri.md"]);
  });

  it("a work key without a live scope still lists the knowledge tabs, and nothing else", () => {
    expect(contextCandidates(scopes(), "work:nowhere").map((r) => r.relPath)).toEqual(["wiki/monaco.md", "wiki/tauri.md", "definitions/git.md"]);
  });
});

describe("selectedContext and copyBlocker", () => {
  const rows = contextCandidates(scopes(), "work:defiance");

  it("keeps only ticked paths that are still candidates, in candidate order", () => {
    const chosen = selectedContext(rows, new Set(["definitions/git.md", "defiance/src/a.py", "cockpit/notes.txt", "gone.md"]));
    expect(chosen.map((c) => c.relPath)).toEqual(["defiance/src/a.py", "definitions/git.md"]);
  });

  it("an empty or space-only task blocks; a dirty ticked file blocks and names the first one; otherwise nothing blocks", () => {
    expect(copyBlocker("", [])).toEqual({ kind: "empty" });
    expect(copyBlocker(" \n\t ", [])).toEqual({ kind: "empty" });
    expect(copyBlocker("x", selectedContext(rows, new Set(["defiance/src/a.py"])))).toBeNull();
    expect(copyBlocker("x", selectedContext(rows, new Set(["defiance/src/a.py", "wiki/tauri.md", "defiance/README.md"])))).toEqual({
      kind: "dirty",
      relPath: "defiance/README.md",
    });
    // A dirty file that is not ticked never blocks.
    expect(copyBlocker("x", selectedContext(rows, new Set(["wiki/monaco.md"])))).toBeNull();
    // An empty task outranks a dirty file.
    expect(copyBlocker("", selectedContext(rows, new Set(["wiki/tauri.md"])))).toEqual({ kind: "empty" });
  });
});

describe("taskPacket", () => {
  it("has the five headings, the folder, the root, the task, one context path per line and the constraints", () => {
    const text = taskPacket({
      place: "defiance",
      rootPath: "/Users/me/alabs",
      task: "  Add a validation rule for empty corpora.\nKeep the CLI unchanged.  ",
      context: ["defiance/src/defiance/corpus.py", "context/notes.md"],
      constraints: "Do not touch data/.",
    });
    expect(text).toBe(
      [
        "Work folder: defiance",
        "Root: /Users/me/alabs",
        "",
        "Task:",
        "Add a validation rule for empty corpora.\nKeep the CLI unchanged.",
        "",
        "Context:",
        "defiance/src/defiance/corpus.py",
        "context/notes.md",
        "",
        "Constraints:",
        "Do not touch data/.",
        "",
      ].join("\n"),
    );
  });

  it("keeps every heading when context and constraints are empty, reading none", () => {
    const text = taskPacket({ place: "cockpit", rootPath: "/r", task: "x", context: [], constraints: "  " });
    expect(text).toContain("Context:\nnone\n");
    expect(text).toContain("Constraints:\nnone\n");
    expect(text.startsWith("Work folder: cockpit\nRoot: /r\n\nTask:\nx\n")).toBe(true);
  });

  it("the empty draft has nothing ticked and no fallback", () => {
    expect(EMPTY_DRAFT).toEqual({ text: "", constraints: "", selected: new Set(), fallback: null });
  });
});
