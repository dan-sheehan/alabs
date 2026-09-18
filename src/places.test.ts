import { describe, expect, it } from "vitest";
import { classifyRoot, displayPath, EMPTY_LISTING, isScopeKey, ownerOfPath, visualViewPath, workKey } from "./places";
import type { Entry } from "./subject";

const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });
const file = (name: string): Entry => ({ name, rel_path: name, is_dir: false });
/** How `list_dir` reports a symlink: by its own type, so never a folder. */
const link = (name: string): Entry => ({ name, rel_path: name, is_dir: false });

describe("classifyRoot: the places rule", () => {
  it("lists eligible child folders as work, alphabetical case-insensitive", () => {
    const listing = classifyRoot([dir("Defiance"), dir("cockpit"), dir("job-hunt")]);
    expect(listing.work.map((p) => p.name)).toEqual(["cockpit", "Defiance", "job-hunt"]);
  });

  it("excludes views/ in any spelling", () => {
    const listing = classifyRoot([dir("views"), dir("Views"), dir("defiance")]);
    expect(listing.work.map((p) => p.name)).toEqual(["defiance"]);
    expect(listing.work.map((p) => p.name)).not.toContain("views");
  });

  it("excludes knowledge-role folders and maps them to roles by case-insensitive match", () => {
    const listing = classifyRoot([dir("Context"), dir("wiki"), dir("defiance")]);
    expect(listing.work.map((p) => p.name)).toEqual(["defiance"]);
    expect(listing.roles.context).toEqual({ kind: "present", name: "Context" });
    expect(listing.roles.wiki).toEqual({ kind: "present", name: "wiki" });
    expect(listing.roles.definitions).toEqual({ kind: "missing" });
  });

  it("names two matches for one role as a conflict", () => {
    const listing = classifyRoot([dir("Context"), dir("context"), dir("defiance")]);
    expect(listing.roles.context).toEqual({ kind: "conflict", names: ["Context", "context"] });
    expect(listing.work.map((p) => p.name)).toEqual(["defiance"]);
  });

  it("excludes dot-prefixed folders", () => {
    const listing = classifyRoot([dir(".git"), dir(".hidden"), dir("defiance")]);
    expect(listing.work.map((p) => p.name)).toEqual(["defiance"]);
  });

  it("excludes symlinks, which the listing reports as non-folders", () => {
    const listing = classifyRoot([link("elsewhere"), dir("defiance")]);
    expect(listing.work.map((p) => p.name)).toEqual(["defiance"]);
    expect(listing.work.map((p) => p.name)).not.toContain("elsewhere");
  });

  it("excludes files", () => {
    const listing = classifyRoot([file("README.md"), file("notes.txt"), dir("defiance")]);
    expect(listing.work.map((p) => p.name)).toEqual(["defiance"]);
  });

  it("an empty root has no work and three missing roles", () => {
    expect(classifyRoot([])).toEqual(EMPTY_LISTING);
  });
});

describe("ownerOfPath: views/<place>/** belongs to <place>", () => {
  const listing = classifyRoot([dir("defiance"), dir("cockpit"), dir("views"), dir("wiki")]);

  it("routes a view file to its place and never to a views scope", () => {
    expect(ownerOfPath("views/defiance/index.html", listing)).toBe(workKey("defiance"));
    expect(ownerOfPath("views/defiance/assets/map.svg", listing)).toBe(workKey("defiance"));
    expect(ownerOfPath("views/defiance/index.html", listing)).not.toBe("work:views");
  });

  it("gives a view for a folder that is not a place, and views/ itself, no owner", () => {
    expect(ownerOfPath("views/other/index.html", listing)).toBeNull();
    expect(ownerOfPath("views/defiance", listing)).toBeNull();
    expect(ownerOfPath("views", listing)).toBeNull();
  });

  it("routes place files to the place, knowledge files to the role, root files to nobody", () => {
    expect(ownerOfPath("defiance/src/ingest.py", listing)).toBe(workKey("defiance"));
    expect(ownerOfPath("cockpit/README.md", listing)).toBe(workKey("cockpit"));
    expect(ownerOfPath("wiki/git.md", listing)).toBe("know:wiki");
    expect(ownerOfPath("README.md", listing)).toBeNull();
    expect(ownerOfPath("definitions/x.md", listing)).toBeNull();
    expect(ownerOfPath("../defiance/x", listing)).toBeNull();
    expect(ownerOfPath("defiance/../cockpit/x", listing)).toBeNull();
  });

  it("uses exact on-disk spelling for place names", () => {
    expect(ownerOfPath("Defiance/x.py", listing)).toBeNull();
  });
});

describe("helpers", () => {
  it("builds the visual view path and scope keys", () => {
    expect(visualViewPath("defiance")).toBe("views/defiance/map.svg");
    expect(isScopeKey("home")).toBe(true);
    expect(isScopeKey("work:defiance")).toBe(true);
    expect(isScopeKey("know:wiki")).toBe(true);
    expect(isScopeKey("know:other")).toBe(false);
    expect(isScopeKey("work:")).toBe(false);
    expect(isScopeKey("work:a/b")).toBe(false);
    expect(isScopeKey("views")).toBe(false);
  });

  it("shows paths relative to the place", () => {
    expect(displayPath("defiance/src/x.py", "defiance")).toBe("src/x.py");
    expect(displayPath("views/defiance/index.html", "defiance")).toBe("views/defiance/index.html");
    expect(displayPath("defiance", "defiance")).toBe("");
  });
});
