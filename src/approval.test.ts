import { describe, expect, it } from "vitest";
import { approvalHolds, cleanApproval, discardApproval, unapproved } from "./approval";

describe("approvalHolds", () => {
  it("holds only for the exact approved version", () => {
    expect(approvalHolds({ version: 7 }, 7)).toBe(true);
    expect(approvalHolds({ version: 7 }, 8)).toBe(false);
    expect(approvalHolds({ version: 7 }, 6)).toBe(false);
  });

  it("never holds without an approval", () => {
    expect(approvalHolds(null, 7)).toBe(false);
    expect(approvalHolds(undefined, 7)).toBe(false);
  });

  it("holds when there is no live model to lose", () => {
    expect(approvalHolds(null, null)).toBe(true);
    expect(approvalHolds({ version: 1 }, null)).toBe(true);
  });
});

describe("cleanApproval", () => {
  it("approves a buffer whose live version is the saved one", () => {
    expect(cleanApproval(3, 3)).toEqual({ version: 3 });
  });

  it("refuses a dirty buffer", () => {
    expect(cleanApproval(3, 4)).toBeNull();
    expect(cleanApproval(0, 1)).toBeNull();
  });

  it("approves when no model exists", () => {
    expect(cleanApproval(3, null)).toEqual({ version: 3 });
  });
});

describe("save then edit", () => {
  it("a save approves only the version it wrote; a later edit voids it", () => {
    const savedVersion = 10;
    const approval = { version: savedVersion };
    expect(approvalHolds(approval, 10)).toBe(true);
    // The user types during or after the save: version 11 is dirty again.
    expect(approvalHolds(approval, 11)).toBe(false);
    expect(cleanApproval(savedVersion, 11)).toBeNull();
  });

  it("discard approves the version shown when Discard was chosen", () => {
    const approval = discardApproval(5);
    expect(approvalHolds(approval, 5)).toBe(true);
    expect(approvalHolds(approval, 6)).toBe(false);
  });
});

describe("unapproved", () => {
  const versions = (table: Record<string, { saved: number; live: number | null }>) => (path: string) =>
    table[path] ?? null;

  it("covers clean buffers implicitly and approved buffers explicitly", () => {
    const approvals = new Map([["b.md", { version: 4 }]]);
    const table = { "a.md": { saved: 1, live: 1 }, "b.md": { saved: 2, live: 4 } };
    expect(unapproved(["a.md", "b.md"], approvals, versions(table))).toEqual([]);
  });

  it("reports a dirty buffer without approval and an approval that no longer holds", () => {
    const approvals = new Map([["b.md", { version: 4 }]]);
    const table = { "a.md": { saved: 1, live: 2 }, "b.md": { saved: 2, live: 5 }, "c.md": { saved: 1, live: 1 } };
    expect(unapproved(["a.md", "b.md", "c.md"], approvals, versions(table))).toEqual(["a.md", "b.md"]);
  });

  it("ignores paths with no buffer", () => {
    expect(unapproved(["gone.md"], new Map(), versions({}))).toEqual([]);
  });
});
