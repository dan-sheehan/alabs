import { describe, expect, it, vi } from "vitest";
import { launch, readHome, type LaunchIo } from "./launch";
import { EMPTY_STATE, serializeState, setRoot, setScopeLayout } from "./uiState";
import type { Entry } from "./subject";

const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });

function io(overrides: Partial<LaunchIo> = {}): LaunchIo {
  return {
    bootstrap: vi.fn(async () => ({ root: null, canEdit: true, serverId: null })),
    loadUiState: vi.fn(async () => null),
    openRoot: vi.fn(async (path: string) => ({ path, name: path.split("/").pop() ?? path })),
    listDir: vi.fn(async () => [dir("defiance"), dir("cockpit"), dir("views"), dir("wiki")]),
    entryKind: vi.fn(async (rel: string) =>
      rel === "views/defiance/map.svg" ? ("file" as const) : rel === "defiance/.git" ? ("dir" as const) : rel === "cockpit/.git" ? ("file" as const) : ("none" as const),
    ),
    readFile: vi.fn(async (rel: string) => {
      throw `cannot read ${rel}: No such file or directory (os error 2)`;
    }),
    ...overrides,
  };
}

const remembered = serializeState(
  setScopeLayout(setRoot(EMPTY_STATE, "/root"), "work:defiance", {
    expanded: [],
    tabs: ["editor:defiance/a.py", "editor:defiance/b.py"],
    active: "editor:defiance/a.py",
    views: {},
    visited: 1,
  }),
);

describe("launch", () => {
  it("a remembered root opens to Home with one listing and no place tab read", async () => {
    const deps = io({ loadUiState: vi.fn(async () => remembered) });
    const result = await launch(deps);
    expect(deps.openRoot).toHaveBeenCalledWith("/root");
    expect(result.root).toEqual({ path: "/root", name: "root" });
    expect(result.rootFailure).toBeNull();
    expect(result.fallback).toBeNull();
    expect(deps.listDir).toHaveBeenCalledTimes(1);
    expect(deps.listDir).toHaveBeenCalledWith("");
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(result.home?.listing.work.map((p) => p.name)).toEqual(["cockpit", "defiance"]);
    expect(result.home?.views.has("defiance")).toBe(true);
    expect(result.home?.views.has("cockpit")).toBe(false);
    // One view check and one .git check per work place, plus one check for the root map; Git itself never runs here.
    expect(deps.entryKind).toHaveBeenCalledTimes(5);
    expect(deps.entryKind).toHaveBeenCalledWith("views/.root/map.svg");
    expect(result.home?.rootView).toEqual({ exists: false, saved: null });
    expect(deps.entryKind).toHaveBeenCalledWith("defiance/.git");
    expect(result.home?.git.get("defiance")).toBe("repo");
    expect(result.home?.git.get("cockpit")).toBe("linked");
    expect(result.home?.git.has("wiki")).toBe(false);
    // The remembered layout survives the launch untouched, for the place's first visit.
    expect(result.ui.scopes["work:defiance"].tabs).toHaveLength(2);
    expect(result.written).toBe(remembered);
  });

  it("a remembered root that fails shows the first-launch screen with the real path and reason", async () => {
    const deps = io({
      loadUiState: vi.fn(async () => remembered),
      openRoot: vi.fn(async () => {
        throw "cannot open /root: No such file or directory (os error 2)";
      }),
    });
    const result = await launch(deps);
    expect(result.root).toBeNull();
    expect(result.rootFailure).toEqual({ path: "/root", reason: "cannot open /root: No such file or directory (os error 2)" });
    expect(deps.listDir).not.toHaveBeenCalled();
    expect(deps.entryKind).not.toHaveBeenCalled();
    expect(deps.readFile).not.toHaveBeenCalled();
    // The remembered root is kept so the notice can name it and a retry is possible.
    expect(result.ui.root).toBe("/root");
  });

  it("no remembered root makes no filesystem call beyond the state file", async () => {
    const deps = io();
    const result = await launch(deps);
    expect(deps.loadUiState).toHaveBeenCalledTimes(1);
    expect(deps.openRoot).not.toHaveBeenCalled();
    expect(deps.listDir).not.toHaveBeenCalled();
    expect(deps.entryKind).not.toHaveBeenCalled();
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(result.root).toBeNull();
    expect(result.rootFailure).toBeNull();
    expect(result.fallback).toBeNull();
  });

  it("a named state load error reaches the fallback path and starts fresh", async () => {
    const deps = io({
      loadUiState: vi.fn(async () => {
        throw "cannot read ui state: larger than 1 MB";
      }),
    });
    const result = await launch(deps);
    expect(result.fallback).toBe("saved layout could not be read: cannot read ui state: larger than 1 MB");
    expect(result.ui).toEqual(EMPTY_STATE);
    expect(result.written).toBeNull();
    expect(deps.openRoot).not.toHaveBeenCalled();
  });

  it("a version 1 file starts fresh with a visible reason and opens no root", async () => {
    const deps = io({ loadUiState: vi.fn(async () => JSON.stringify({ version: 1, recent: ["/old"], subjects: {} })) });
    const result = await launch(deps);
    expect(result.fallback).toMatch(/version 1/);
    expect(deps.openRoot).not.toHaveBeenCalled();
    expect(result.root).toBeNull();
  });

  it("a failed listing is reported and the root stays open", async () => {
    const deps = io({
      loadUiState: vi.fn(async () => remembered),
      listDir: vi.fn(async () => {
        throw "cannot read : Permission denied (os error 13)";
      }),
    });
    const result = await launch(deps);
    expect(result.root).not.toBeNull();
    expect(result.home).toBeNull();
    expect(result.homeError).toContain("Permission denied");
  });

  // A runtime that owns its root (alabs in Chrome) is the only authority on
  // which folder is open. `browser-building.md` section 3: "The browser
  // obtains its authoritative root from server bootstrap. Remembered layout
  // state cannot select or replace that root."
  describe("a runtime that owns its root", () => {
    const owned = { path: "/served", name: "served" };

    it("uses its own root and never asks for the remembered one to be opened", async () => {
      const deps = io({
        bootstrap: vi.fn(async () => ({ root: owned, canEdit: false, serverId: null })),
        loadUiState: vi.fn(async () => remembered),
      });
      const result = await launch(deps);
      expect(result.root).toEqual(owned);
      // The one that matters: nothing in the state file can cause a root to
      // be opened, because nothing opens a root at all.
      expect(deps.openRoot).not.toHaveBeenCalled();
      expect(result.rootFailure).toBeNull();
      expect(result.ui.root).toBe("/served");
      expect(result.canEdit).toBe(false);
      // Home is still read, from the runtime's root.
      expect(deps.listDir).toHaveBeenCalledWith("");
    });

    it("drops a layout that belongs to a different root", async () => {
      const deps = io({
        bootstrap: vi.fn(async () => ({ root: owned, canEdit: false, serverId: null })),
        loadUiState: vi.fn(async () => remembered),
      });
      const result = await launch(deps);
      // `remembered` describes /root. It cannot describe /served, so the
      // tabs and baselines go rather than being applied to another folder.
      expect(result.ui.scopes).toEqual({});
      expect(result.ui.baselines).toEqual({});
      expect(result.ui.activeWork).toBeNull();
      // The stored text no longer matches what this version would write, so
      // it is not treated as already written.
      expect(result.written).toBeNull();
    });

    it("keeps the layout when the remembered root is the one it owns", async () => {
      const deps = io({
        bootstrap: vi.fn(async () => ({ root: { path: "/root", name: "root" }, canEdit: false, serverId: null })),
        loadUiState: vi.fn(async () => remembered),
      });
      const result = await launch(deps);
      expect(deps.openRoot).not.toHaveBeenCalled();
      expect(result.ui.scopes["work:defiance"].tabs).toHaveLength(2);
      expect(result.written).toBe(remembered);
    });

    it("a runtime that cannot be reached opens nothing and says why", async () => {
      const deps = io({
        bootstrap: vi.fn(async () => {
          throw "This page was not opened by alabs.";
        }),
        loadUiState: vi.fn(async () => remembered),
      });
      const result = await launch(deps);
      expect(result.bootstrapError).toContain("This page was not opened by alabs.");
      expect(result.root).toBeNull();
      // Not even the remembered root: an unreachable runtime is not a licence
      // to fall back to whatever the state file names.
      expect(deps.openRoot).not.toHaveBeenCalled();
      expect(deps.listDir).not.toHaveBeenCalled();
      expect(deps.entryKind).not.toHaveBeenCalled();
    });
  });

  it("readHome counts a failed view check as no view", async () => {
    const deps = io({
      entryKind: vi.fn(async () => {
        throw "path is outside the subject: views/x/index.html";
      }),
    });
    const home = await readHome(deps);
    expect(home.views.size).toBe(0);
    expect(home.listing.work).toHaveLength(2);
  });
});

it("corrupt persisted layout never opens a root or reads remembered files", async () => {
  const deps = io({ loadUiState: vi.fn(async () => '{"version":2,"root":"/root","scopes":') });
  const result = await launch(deps);
  expect(result.fallback).toBeTruthy();
  expect(result.root).toBeNull();
  expect(result.ui).toEqual(EMPTY_STATE);
  expect(deps.openRoot).not.toHaveBeenCalled();
  expect(deps.readFile).not.toHaveBeenCalled();
});

it("Unicode work and conflicting knowledge roles remain separate after restart", async () => {
  const name = "長い名前 résumé with spaces";
  const deps = io({
    loadUiState: vi.fn(async () => serializeState(setRoot(EMPTY_STATE, "/root"))),
    listDir: vi.fn(async () => [dir(name), dir("context"), dir("Wiki"), dir("wiki"), dir("views")]),
  });
  const result = await launch(deps);
  expect(result.home?.listing.work).toEqual([{ name }]);
  expect(result.home?.listing.roles).toEqual({
    context: { kind: "present", name: "context" }, wiki: { kind: "conflict", names: ["Wiki", "wiki"] }, definitions: { kind: "missing" },
  });
  expect(deps.entryKind).toHaveBeenCalledWith(`${name}/.git`);
  expect(deps.entryKind).toHaveBeenCalledWith(`views/${name}/map.svg`);
  expect(deps.readFile).not.toHaveBeenCalled();
});
