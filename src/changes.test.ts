import { describe, expect, it } from "vitest";
import {
  BASELINE_GONE,
  DIRTY_AT_HANDOFF,
  emptyText,
  mergeRows,
  MODE_LABEL,
  offerModes,
  paneTitles,
  parseNameStatus,
  parseStatus,
  parseUntracked,
  queryFailureText,
  rowsOf,
  rowText,
  sidesOf,
  stateOfStatus,
} from "./changes";
import { NEVER_ON_SCREEN } from "./notices";

// The Changes tab's pure logic (DESIGN.md 6.9): the NUL-delimited parsers
// for every listing git can write, the modes a baseline offers, the panes
// of a comparison, and the copy for every state.

const NUL = "\0";
const base = { commit: "a".repeat(40), at: 1, clean: true };

describe("parseStatus (status --porcelain=v1 -z -uall --no-renames)", () => {
  it("keeps spaces, quotes and Unicode in paths and names every state plainly", () => {
    const text = [` M src/ingest.py`, `M  staged.py`, `MM both.py`, `A  src/new.py`, `AM added then edited.py`, ` D old.py`, `D  gone.py`, `UU x.py`, `AA both added.py`, `DD both gone.py`, `?? sp ace/ünï "q".txt`, `?? nested/`, ` T typed`].join(NUL) + NUL;
    expect(parseStatus(text)).toEqual([
      { path: "src/ingest.py", state: "changed" },
      { path: "staged.py", state: "changed" },
      { path: "both.py", state: "changed" },
      { path: "src/new.py", state: "added" },
      { path: "added then edited.py", state: "added" },
      { path: "old.py", state: "deleted" },
      { path: "gone.py", state: "deleted" },
      { path: "x.py", state: "conflict" },
      { path: "both added.py", state: "conflict" },
      { path: "both gone.py", state: "conflict" },
      { path: 'sp ace/ünï "q".txt', state: "added" },
      { path: "nested/", state: "nested" },
      { path: "typed", state: "changed" },
    ]);
  });

  it("an empty listing is no rows; malformed records are skipped, never guessed", () => {
    expect(parseStatus("")).toEqual([]);
    expect(parseStatus(NUL)).toEqual([]);
    expect(parseStatus(`M${NUL}?? ${NUL}bad`)).toEqual([]);
  });

  it("an unborn repository lists every file as added or untracked, never changed", () => {
    expect(parseStatus(`A  x.txt${NUL}?? y.txt${NUL}`)).toEqual([
      { path: "x.txt", state: "added" },
      { path: "y.txt", state: "added" },
    ]);
    expect(stateOfStatus("??", "dir/")).toBe("nested");
    expect(stateOfStatus("??", "file")).toBe("added");
  });
});

describe("parseNameStatus and parseUntracked", () => {
  it("reads alternating letter and path records, including T and U", () => {
    const text = `M${NUL}a.txt${NUL}A${NUL}sp ace.txt${NUL}D${NUL}old.txt${NUL}U${NUL}x.py${NUL}T${NUL}link${NUL}`;
    expect(parseNameStatus(text)).toEqual([
      { path: "a.txt", state: "changed" },
      { path: "sp ace.txt", state: "added" },
      { path: "old.txt", state: "deleted" },
      { path: "x.py", state: "conflict" },
      { path: "link", state: "changed" },
    ]);
    expect(parseNameStatus("")).toEqual([]);
    // A dangling letter without a path is ignored.
    expect(parseNameStatus(`M${NUL}`)).toEqual([]);
  });

  it("untracked files are fully added and a nested repository is named", () => {
    expect(parseUntracked(`b.txt${NUL}nested/${NUL}ünï "q".txt${NUL}`)).toEqual([
      { path: "b.txt", state: "added" },
      { path: "nested/", state: "nested" },
      { path: 'ünï "q".txt', state: "added" },
    ]);
    expect(parseUntracked("")).toEqual([]);
  });

  it("mergeRows keeps one row per path, the first listing winning, in path order", () => {
    const merged = mergeRows(
      [
        { path: "z.txt", state: "changed" },
        { path: "a.txt", state: "deleted" },
      ],
      [
        { path: "a.txt", state: "added" },
        { path: "m.txt", state: "added" },
      ],
    );
    expect(merged).toEqual([
      { path: "a.txt", state: "deleted" },
      { path: "m.txt", state: "added" },
      { path: "z.txt", state: "changed" },
    ]);
  });

  it("rowsOf reads the answer that matches the mode and nothing else", () => {
    expect(rowsOf("status", { kind: "files", text: `?? n.txt${NUL}` })).toEqual([{ path: "n.txt", state: "added" }]);
    expect(rowsOf("committed", { kind: "files", text: `M${NUL}a.txt${NUL}` })).toEqual([{ path: "a.txt", state: "changed" }]);
    expect(rowsOf("since", { kind: "since", diff: `D${NUL}old.txt${NUL}`, untracked: `b.txt${NUL}` })).toEqual([
      { path: "b.txt", state: "added" },
      { path: "old.txt", state: "deleted" },
    ]);
    expect(rowsOf("status", { kind: "baseline_missing" })).toBeNull();
    expect(rowsOf("since", { kind: "timeout" })).toBeNull();
  });
});

describe("modes, panes and copy", () => {
  it("no baseline offers Not yet committed; a clean baseline offers Since task started first; a dirty one offers the two separately with the sentence", () => {
    expect(offerModes(null)).toEqual({ modes: ["status"], note: null, initial: "status" });
    expect(offerModes(base)).toEqual({ modes: ["since", "status"], note: null, initial: "since" });
    expect(offerModes({ ...base, clean: false })).toEqual({ modes: ["committed", "status"], note: DIRTY_AT_HANDOFF, initial: "status" });
    expect(MODE_LABEL).toEqual({ status: "Not yet committed", since: "Since task started", committed: "Commits since task started" });
  });

  it("pane titles and empty text follow the mode", () => {
    expect(paneTitles("status")).toEqual({ left: "Last commit", right: "On disk" });
    expect(paneTitles("since")).toEqual({ left: "Task start", right: "On disk" });
    expect(paneTitles("committed")).toEqual({ left: "Task start", right: "Last commit" });
    expect(emptyText("status")).toBe("No changed files.");
    expect(emptyText("since")).toBe("Nothing has changed since the task started.");
    expect(emptyText("committed")).toBe("Nothing has changed since the task started.");
  });

  it("sides: added has an empty left, deleted a gone right, committed compares the baseline with the last commit, nested has none", () => {
    const changed = { path: "a.py", state: "changed" as const };
    expect(sidesOf("status", changed, null)).toEqual({ left: { kind: "rev", rev: "HEAD" }, right: { kind: "disk" } });
    expect(sidesOf("status", { path: "n.py", state: "added" }, base)).toEqual({ left: { kind: "empty" }, right: { kind: "disk" } });
    expect(sidesOf("status", { path: "o.py", state: "deleted" }, base)).toEqual({ left: { kind: "rev", rev: "HEAD" }, right: { kind: "gone" } });
    expect(sidesOf("status", { path: "c.py", state: "conflict" }, base)).toEqual({ left: { kind: "rev", rev: "HEAD" }, right: { kind: "disk" } });
    expect(sidesOf("since", changed, base)).toEqual({ left: { kind: "rev", rev: base.commit }, right: { kind: "disk" } });
    expect(sidesOf("committed", changed, base)).toEqual({ left: { kind: "rev", rev: base.commit }, right: { kind: "rev", rev: "HEAD" } });
    expect(sidesOf("committed", { path: "o.py", state: "deleted" }, base)).toEqual({ left: { kind: "rev", rev: base.commit }, right: { kind: "gone" } });
    expect(sidesOf("since", { path: "sub/", state: "nested" }, base)).toBeNull();
    // Without a baseline (it vanished) a baseline mode falls back to the last commit.
    expect(sidesOf("since", changed, null)).toEqual({ left: { kind: "rev", rev: "HEAD" }, right: { kind: "disk" } });
  });

  it("row text and failure copy never use implementation words", () => {
    const texts = [
      rowText({ path: "src/ingest.py", state: "changed" }),
      rowText({ path: "sub/", state: "nested" }),
      queryFailureText({ kind: "none" }),
      queryFailureText({ kind: "linked" }),
      queryFailureText({ kind: "unavailable" }),
      queryFailureText({ kind: "timeout" }),
      queryFailureText({ kind: "too_large" }),
      queryFailureText({ kind: "failed", reason: "bad object 0123" }),
      queryFailureText({ kind: "error", reason: "cannot access defiance: No such file or directory (os error 2)" }),
      BASELINE_GONE,
      DIRTY_AT_HANDOFF,
      ...Object.values(MODE_LABEL),
    ];
    expect(texts[0]).toBe("changed · src/ingest.py");
    expect(texts[1]).toBe("nested repository · sub/");
    expect(texts[2]).toBe("This folder is not a Git repository. Open tabs still show a mark when a file changed on disk.");
    expect(texts[4]).toBe("Git is unavailable on this Mac.");
    expect(texts[5]).toBe("Git took too long.");
    expect(texts[6]).toBe("Git returned too much to show.");
    expect(texts[8]).toBe("Git could not read this folder: cannot access defiance: No such file or directory");
    expect(queryFailureText({ kind: "files", text: "" })).toBeNull();
    expect(queryFailureText({ kind: "blob", text: "" })).toBeNull();
    for (const text of texts) {
      for (const word of NEVER_ON_SCREEN) {
        const found = word === word.toUpperCase() ? String(text).includes(word) : String(text).toLowerCase().includes(word.toLowerCase());
        expect(found, `"${text}" contains "${word}"`).toBe(false);
      }
    }
  });
});
