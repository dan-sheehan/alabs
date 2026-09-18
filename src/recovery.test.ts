import { describe, expect, it, vi } from "vitest";
import { mergeDrafts, Recorder, type Draft, type DraftListing, type DraftStore } from "./recovery";
import type { FileStamp } from "./subject";

/**
 * The ordering rules unsaved work depends on, checked without a browser, a
 * server or a disk: a revision is only ever acknowledged by the write that
 * actually stored it, a write that finishes late never speaks for newer text,
 * and a draft is forgotten only once its exact revision has been dealt with.
 */

const STAMP: FileStamp = { identity: "1:2", mtime_secs: 100, mtime_nanos: 0, len: 4 };

/** A store whose every call can be held open and released by the test. */
function heldStore() {
  const kept = new Map<string, Draft>();
  const waiting: Array<{ resolve: () => void; reject: (why: unknown) => void; draft: Draft }> = [];
  let hold = false;
  const store: DraftStore = {
    put(draft) {
      if (!hold) {
        const had = kept.get(draft.relPath);
        if (had && had.revision > draft.revision) return Promise.reject(new Error("newer draft kept"));
        kept.set(draft.relPath, draft);
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        waiting.push({
          draft,
          resolve: () => {
            kept.set(draft.relPath, draft);
            resolve();
          },
          reject,
        });
      });
    },
    list: async () => ({ drafts: [...kept.values()], unreadable: [] }),
    async drop(_root, relPath, revision) {
      const had = kept.get(relPath);
      if (had && had.revision > revision) throw new Error("newer draft kept");
      kept.delete(relPath);
    },
  };
  return {
    store,
    kept,
    waiting,
    holdWrites() {
      hold = true;
    },
    releaseWrites() {
      hold = false;
    },
  };
}

/** A store that never accepts anything. */
function brokenStore(reason: string): DraftStore {
  return {
    put: () => Promise.reject(new Error(reason)),
    list: async () => ({ drafts: [], unreadable: [] }),
    drop: () => Promise.reject(new Error(reason)),
  };
}

function plainStore(): DraftStore & { kept: Map<string, Draft> } {
  const kept = new Map<string, Draft>();
  return {
    kept,
    async put(draft) {
      kept.set(draft.relPath, draft);
    },
    list: async () => ({ drafts: [...kept.values()], unreadable: [] }),
    async drop(_root, relPath) {
      kept.delete(relPath);
    },
  };
}

function recorder(browser: DraftStore, disk: DraftStore, now = () => 1000) {
  return new Recorder({ root: "/root", serverId: "server-one", sessionId: "tab-one", browser, disk, now });
}

/** Let every already-resolved promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("how far a revision has got", () => {
  it("is pending until a store has actually accepted it, not when it was asked to", async () => {
    const browser = heldStore();
    const disk = heldStore();
    browser.holdWrites();
    disk.holdWrites();
    const rec = recorder(browser.store, disk.store);

    const revision = rec.note("a.md", "typed", STAMP);
    expect(rec.state("a.md")).toEqual({ revision, kept: "pending", trouble: null });

    browser.waiting[0].resolve();
    await settle();
    expect(rec.state("a.md")?.kept).toBe("browser");

    disk.waiting[0].resolve();
    await settle();
    expect(rec.state("a.md")?.kept).toBe("disk");
  });

  it("goes back to pending the moment newer text is typed", async () => {
    const rec = recorder(plainStore(), plainStore());
    rec.note("a.md", "one", STAMP);
    await settle();
    expect(rec.state("a.md")?.kept).toBe("disk");
    rec.note("a.md", "two", STAMP);
    expect(rec.state("a.md")?.kept).toBe("pending");
  });

  it("does not renumber text that is already exactly what is kept", async () => {
    const rec = recorder(plainStore(), plainStore());
    const first = rec.note("a.md", "same", STAMP);
    await settle();
    expect(rec.note("a.md", "same", STAMP)).toBe(first);
    expect(rec.state("a.md")).toEqual({ revision: first, kept: "disk", trouble: null });
  });
});

describe("a write that finishes late", () => {
  it("acknowledges its own revision and never the text typed after it", async () => {
    const browser = heldStore();
    const disk = heldStore();
    browser.holdWrites();
    disk.holdWrites();
    const rec = recorder(browser.store, disk.store);

    const first = rec.note("a.md", "one", STAMP);
    // Typed twice more while the first write is still in flight.
    rec.note("a.md", "two", STAMP);
    const third = rec.note("a.md", "three", STAMP);
    expect(third).toBeGreaterThan(first);

    // The first write lands at last. It stored "one", so it may only speak
    // for "one" — and the buffer holds "three".
    browser.waiting[0].resolve();
    await settle();
    expect(rec.state("a.md")).toEqual({ revision: third, kept: "pending", trouble: null });

    // The same for the durable copy: a disk write that finishes late must not
    // make the newest text look as though it is on the disk.
    disk.waiting[0].resolve();
    await settle();
    expect(rec.state("a.md")).toEqual({ revision: third, kept: "pending", trouble: null });

    // Only the writes that carried "three" acknowledge "three".
    browser.waiting[1].resolve();
    await settle();
    expect(rec.state("a.md")?.kept).toBe("browser");
    disk.waiting[1].resolve();
    await settle();
    expect(rec.state("a.md")?.kept).toBe("disk");
    expect(browser.kept.get("a.md")?.contents).toBe("three");
    expect(disk.kept.get("a.md")?.contents).toBe("three");
  });

  it("stores the newest text rather than every keystroke on the way to it", async () => {
    const browser = plainStore();
    const disk = plainStore();
    const writes = vi.spyOn(disk, "put");
    const rec = recorder(browser, disk);
    for (const text of ["a", "ab", "abc", "abcd", "abcde"]) rec.note("a.md", text, STAMP);
    await settle();
    await settle();
    expect(disk.kept.get("a.md")?.contents).toBe("abcde");
    // One write in flight and one waiting: a burst of typing does not become
    // a burst of writes, and the last one always wins.
    expect(writes.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("storage that fails", () => {
  it("says so, keeps the live text in hand, and still writes the durable copy", async () => {
    const disk = plainStore();
    const rec = recorder(brokenStore("this browser will not keep drafts"), disk);
    rec.note("a.md", "unsaved work", STAMP);
    await settle();

    const state = rec.state("a.md");
    expect(state?.kept).toBe("disk");
    expect(state?.trouble).toEqual({ where: "browser", reason: expect.stringContaining("will not keep drafts") });
    // The text is still here to be handed to the user.
    expect(rec.text("a.md")).toBe("unsaved work");
    expect(disk.kept.get("a.md")?.contents).toBe("unsaved work");
  });

  it("when nowhere will keep it, nothing claims it is kept and the text is still there", async () => {
    const rec = recorder(brokenStore("no browser storage"), brokenStore("the recovery folder is full"));
    rec.note("a.md", "the only copy", STAMP);
    await settle();

    const state = rec.state("a.md");
    expect(state?.kept).toBe("pending");
    expect(state?.trouble).toEqual({ where: "disk", reason: expect.stringContaining("recovery folder is full") });
    expect(rec.text("a.md")).toBe("the only copy");
    expect(rec.paths()).toEqual(["a.md"]);
  });

  it("clears the trouble once a revision is kept again", async () => {
    let broken = true;
    const disk: DraftStore = {
      put: () => (broken ? Promise.reject(new Error("full")) : Promise.resolve()),
      list: async () => ({ drafts: [], unreadable: [] }),
      drop: async () => {},
    };
    const rec = recorder(plainStore(), disk);
    rec.note("a.md", "one", STAMP);
    await settle();
    expect(rec.state("a.md")?.trouble).not.toBeNull();
    broken = false;
    rec.note("a.md", "two", STAMP);
    await settle();
    expect(rec.state("a.md")).toEqual({ revision: 2, kept: "disk", trouble: null });
  });
});

describe("forgetting a draft", () => {
  it("only happens for the revision that was actually dealt with", async () => {
    const browser = plainStore();
    const disk = plainStore();
    const rec = recorder(browser, disk);
    const saved = rec.note("a.md", "saved text", STAMP);
    await settle();

    await rec.settle("a.md", saved);
    expect(browser.kept.has("a.md")).toBe(false);
    expect(disk.kept.has("a.md")).toBe(false);
    expect(rec.state("a.md")).toBeNull();
    expect(rec.paths()).toEqual([]);
  });

  it("keeps the draft when the file has been typed in again since", async () => {
    const browser = plainStore();
    const disk = plainStore();
    const rec = recorder(browser, disk);
    const saved = rec.note("a.md", "what was saved", STAMP);
    await settle();
    // The user kept typing while the save was running.
    rec.note("a.md", "what was typed after", STAMP);
    await settle();

    await rec.settle("a.md", saved);
    expect(disk.kept.get("a.md")?.contents).toBe("what was typed after");
    expect(rec.state("a.md")?.revision).toBeGreaterThan(saved);
    expect(rec.text("a.md")).toBe("what was typed after");
  });

  it("does not put back a draft that was thrown away while a write was on its way", async () => {
    const browser = heldStore();
    const disk = heldStore();
    browser.holdWrites();
    const rec = recorder(browser.store, disk.store);

    const revision = rec.note("a.md", "about to be discarded", STAMP);
    // The user chooses Discard while the first write is still in flight.
    const settling = rec.settle("a.md", revision);
    browser.releaseWrites();
    browser.waiting[0].resolve();
    await settling;

    // The write landed, and the drop came after it rather than racing it.
    expect(browser.kept.has("a.md")).toBe(false);
    expect(disk.kept.has("a.md")).toBe(false);
    expect(rec.state("a.md")).toBeNull();
  });

  it("text typed while a draft is being forgotten is kept, and numbered above it", async () => {
    const browser = heldStore();
    const disk = heldStore();
    disk.holdWrites();
    const rec = recorder(browser.store, disk.store);
    const saved = rec.note("a.md", "what was saved", STAMP);
    await settle();
    disk.waiting[0].resolve();
    await settle();
    expect(rec.state("a.md")?.kept).toBe("disk");

    const settling = rec.settle("a.md", saved);
    // The user types while the stores are being asked to forget it.
    const after = rec.note("a.md", "typed during the save", STAMP);
    expect(after).toBeGreaterThan(saved);
    await settling;

    // The newer text is still unsaved work, and is still being kept.
    expect(rec.state("a.md")?.revision).toBe(after);
    expect(rec.text("a.md")).toBe("typed during the save");
    await settle();
    disk.waiting[1].resolve();
    await settle();
    expect(disk.kept.get("a.md")?.contents).toBe("typed during the save");
  });

  it("a store that refuses to forget it does not make alabs claim unsaved work that is saved", async () => {
    const rec = recorder(plainStore(), brokenStore("cannot remove a recovery file"));
    const saved = rec.note("a.md", "saved", STAMP);
    await settle();
    await rec.settle("a.md", saved);
    // The buffer really is saved, so nothing is unsaved. The record left
    // behind is offered for review at the next launch like any other.
    expect(rec.state("a.md")).toBeNull();
  });
});

describe("revisions only ever go forward", () => {
  it("a file edited again after being saved is numbered above what was saved", async () => {
    const browser = plainStore();
    const disk = plainStore();
    const rec = recorder(browser, disk);
    const first = rec.note("a.md", "one", STAMP);
    await settle();
    await rec.settle("a.md", first);
    expect(rec.state("a.md")).toBeNull();

    const second = rec.note("a.md", "two", STAMP);
    expect(second).toBeGreaterThan(first);
  });

  it("keeps clearing the floor even when a store would not forget the old draft", async () => {
    const browser = plainStore();
    // A store that keeps what it has and refuses to drop it — an unwritable
    // recovery folder, say. The next edit must still be acceptable to it.
    const stuck = new Map<string, Draft>();
    const disk: DraftStore = {
      async put(draft) {
        const had = stuck.get(draft.relPath);
        if (had && had.revision > draft.revision) throw new Error("a newer draft is already kept");
        stuck.set(draft.relPath, draft);
      },
      list: async () => ({ drafts: [...stuck.values()], unreadable: [] }),
      drop: () => Promise.reject(new Error("cannot remove a recovery file")),
    };
    const rec = recorder(browser, disk);
    const saved = rec.note("a.md", "saved text", STAMP);
    await settle();
    await rec.settle("a.md", saved);

    // Edited again. Numbered above the record the store still holds, so the
    // store takes it rather than refusing it as older, for ever.
    rec.note("a.md", "edited again", STAMP);
    await settle();
    expect(rec.state("a.md")?.trouble).toBeNull();
    expect(stuck.get("a.md")?.contents).toBe("edited again");
  });
});

describe("continuing after a restore", () => {
  it("numbers the next edit above the draft that was restored", async () => {
    const browser = heldStore();
    const disk = heldStore();
    const rec = recorder(browser.store, disk.store);
    // A draft from an earlier alabs window, already in both stores.
    rec.seed("a.md", 12, "browser");
    rec.seed("a.md", 12, "disk");
    expect(rec.state("a.md")).toEqual({ revision: 12, kept: "disk", trouble: null });

    const next = rec.note("a.md", "edited after the restore", STAMP);
    expect(next).toBe(13);
    await settle();
    // Numbered 13, it is not older than what is kept, so it is accepted.
    expect(disk.kept.get("a.md")?.revision).toBe(13);
  });

  it("acknowledges only the store and revision actually found at launch", () => {
    const rec = recorder(heldStore().store, heldStore().store);
    rec.seed("a.md", 12, "browser");
    rec.seed("a.md", 7, "disk");
    expect(rec.state("a.md")).toEqual({ revision: 12, kept: "browser", trouble: null });
    rec.seed("a.md", 12, "disk");
    expect(rec.state("a.md")?.kept).toBe("disk");
  });
});

describe("what to offer at launch", () => {
  const draft = (relPath: string, revision: number, contents: string, updatedAt: number): Draft => ({
    root: "/root",
    relPath,
    stamp: null,
    contents,
    revision,
    serverId: "s",
    sessionId: "t",
    updatedAt,
  });
  const listing = (drafts: Draft[], unreadable: string[] = []): DraftListing => ({ drafts, unreadable });

  it("takes the higher revision when both stores hold the same file", () => {
    // Browser ahead: the disk write was the one that failed.
    const ahead = mergeDrafts(listing([draft("a.md", 9, "newer", 2)]), listing([draft("a.md", 4, "older", 1)]));
    expect(ahead.drafts).toEqual([draft("a.md", 9, "newer", 2)]);
    // Disk ahead: the browser's data was cleared and restored from nothing.
    const behind = mergeDrafts(listing([draft("a.md", 2, "older", 1)]), listing([draft("a.md", 6, "newer", 2)]));
    expect(behind.drafts).toEqual([draft("a.md", 6, "newer", 2)]);
  });

  it("offers newest first and reports every record that could not be read", () => {
    const merged = mergeDrafts(
      listing([draft("a.md", 1, "a", 10)], ["broken-in-the-browser"]),
      listing([draft("b.md", 1, "b", 30)], ["broken-on-disk", "broken-in-the-browser"]),
    );
    expect(merged.drafts.map((d) => d.relPath)).toEqual(["b.md", "a.md"]);
    expect(merged.unreadable).toEqual(["broken-in-the-browser", "broken-on-disk"]);
  });
});
