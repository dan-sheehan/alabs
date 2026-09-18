import { describe, expect, it, vi } from "vitest";
import { materialize, MAX_LIVE_MODELS, type MaterializeDeps } from "./openPath";
import type { FileContent } from "./subject";

const file = (relPath: string): FileContent => ({
  name: relPath.split("/").pop() ?? relPath,
  content: "text",
  stamp: { identity: "1:1", mtime_secs: 0, mtime_nanos: 0, len: 4 },
});

function deps(overrides: Partial<MaterializeDeps> = {}) {
  const d = {
    readFile: vi.fn(async (relPath: string) => file(relPath)),
    liveModelCount: vi.fn(() => 0),
    createModel: vi.fn(() => 7),
    stillLive: vi.fn(() => true),
    ...overrides,
  };
  return d;
}

describe("materialize", () => {
  it("reads the file, creates its model once and describes it as a clean loaded tab", async () => {
    const d = deps();
    const result = await materialize(d, "defiance/a.py");
    expect(result).toEqual({
      kind: "tab",
      tab: { kind: "loaded", relPath: "defiance/a.py", name: "a.py", stamp: file("x").stamp, savedVersion: 7, dirty: false, disk: "ok" },
    });
    expect(d.createModel).toHaveBeenCalledTimes(1);
    expect(d.createModel).toHaveBeenCalledWith("defiance/a.py", file("defiance/a.py"));
  });

  it("refuses the next open at the cap without reading, creating or evicting anything", async () => {
    const d = deps({ liveModelCount: vi.fn(() => MAX_LIVE_MODELS) });
    expect(await materialize(d, "defiance/a.py")).toEqual({ kind: "refused", reason: "too many open files" });
    expect(d.readFile).not.toHaveBeenCalled();
    expect(d.createModel).not.toHaveBeenCalled();
    // One below the cap still opens.
    const under = deps({ liveModelCount: vi.fn(() => MAX_LIVE_MODELS - 1) });
    expect((await materialize(under, "defiance/a.py")).kind).toBe("tab");
  });

  it("re-checks the cap after the read, so two opens in flight cannot both pass it", async () => {
    let count = MAX_LIVE_MODELS - 1;
    const d = deps({
      liveModelCount: vi.fn(() => count),
      readFile: vi.fn(async (relPath: string) => {
        // Another open landed while this read was in flight.
        count = MAX_LIVE_MODELS;
        return file(relPath);
      }),
    });
    expect(await materialize(d, "defiance/a.py")).toEqual({ kind: "refused", reason: "too many open files" });
    expect(d.createModel).not.toHaveBeenCalled();
  });

  it("a file that cannot be read is a named failure and creates no model", async () => {
    const d = deps({ readFile: vi.fn(async () => Promise.reject("cannot access defiance/a.py: No such file or directory")) });
    expect(await materialize(d, "defiance/a.py")).toEqual({ kind: "failed", reason: "cannot access defiance/a.py: No such file or directory" });
    expect(d.createModel).not.toHaveBeenCalled();
  });

  it("a completion whose scope is gone is stale: no model, no tab, no failure", async () => {
    const d = deps({ stillLive: vi.fn(() => false) });
    expect(await materialize(d, "defiance/a.py")).toEqual({ kind: "stale" });
    expect(d.createModel).not.toHaveBeenCalled();
    const failing = deps({ stillLive: vi.fn(() => false), readFile: vi.fn(async () => Promise.reject("gone")) });
    expect(await materialize(failing, "defiance/a.py")).toEqual({ kind: "stale" });
  });
});
