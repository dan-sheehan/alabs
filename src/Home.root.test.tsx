import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HomeBody, HomeSidebar } from "./Home";
import { classifyRoot } from "./places";
import type { HomeData } from "./launch";
import type { Entry } from "./subject";

// The Home layout: the middle column holds the root controls and every
// current place; the main canvas is the root Visual View and no longer the
// folder listing.

vi.mock("./subject", () => ({ readFile: vi.fn(), appendLog: vi.fn(async () => {}) }));

const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });
const root = { path: "/root", name: "root" };

function home(entries: Entry[] = [dir("defiance"), dir("cockpit"), dir("Zed"), dir("views"), dir("context"), dir("wiki"), dir(".git")]): HomeData {
  return { listing: classifyRoot(entries), views: new Set(["defiance"]), git: new Map([["defiance", "repo"]]), rootView: { exists: true, saved: null } };
}

/** Rendered HTML without the text-node comments the server renderer puts between expressions. */
const flat = (page: string) => page.replace(/<!-- -->/g, "");

function sidebar(data: HomeData | null = home(), over: Partial<Parameters<typeof HomeSidebar>[0]> = {}) {
  return flat(renderToString(
    <HomeSidebar
      root={root}
      home={data}
      locked={false}
      activeWork={null}
      liveRoles={new Set()}
      builds={new Map()}
      onRefresh={vi.fn()}
      onOpenPlace={vi.fn()}
      onOpenView={vi.fn()}
      onOpenRole={vi.fn()}
      onNewFolder={vi.fn()}
      onCreateRole={vi.fn()}
      {...over}
    />,
  ));
}

function body(data: HomeData | null = home(), over: Partial<Parameters<typeof HomeBody>[0]> = {}) {
  return flat(renderToString(
    <HomeBody
      root={root}
      home={data}
      loading={false}
      activeWork={null}
      activeCounts={null}
      locked={false}
      rootBuild={null}
      rootReload={0}
      onOpenPlace={vi.fn()}
      onOpenView={vi.fn()}
      onOpenRole={vi.fn()}
      onRebuildRoot={vi.fn()}
      onRefresh={vi.fn()}
      {...over}
    />,
  ));
}

const rows = (page: string) => Array.from(page.matchAll(/class="side-row[^"]*"[^>]*title="([^"]+)"/g), (m) => m[1]);

describe("the middle column", () => {
  it("holds alabs root with Refresh, the counts, WORK with every current place in listing order, New folder, and KNOWLEDGE with the three roles", () => {
    const page = sidebar();
    expect(page).toContain("alabs root");
    expect(page).toContain(">Refresh<");
    expect(page).toContain("3 work folders · 2 of 3 knowledge folders");
    expect(page).toContain(">WORK<");
    expect(page).toContain(">KNOWLEDGE<");
    expect(rows(page)).toEqual(["cockpit", "defiance", "Zed", "context", "wiki", "Definitions is not created. Click to create definitions/ inside the root."]);
    expect(page).toContain("+ New folder");
    expect(page).toContain("create →");
    expect(page).toContain("Bring work in with Finder, Terminal, or a clone, then Refresh.");
    // Kind swatches and the Visual View mark, nothing card-like.
    expect(page).toContain("swatch swatch-git");
    // Every repository row, and only a repository row, carries the same GIT tag the root map prints.
    expect(page.match(/kind-tag">git</g)?.length).toBe(page.match(/swatch swatch-git/g)?.length);
    expect(page).toContain("swatch swatch-know");
    expect(page).toContain("◫ view");
    expect(page).not.toContain('class="node');
  });

  it("marks the active work place, a conflicted role and an enterable conflict", () => {
    const page = sidebar(home([dir("defiance"), dir("context"), dir("Context"), dir("wiki")]), { activeWork: "defiance" });
    expect(page).toContain('title="active work"');
    expect(page).toContain(">conflict<");
    expect(page).toContain("Two folders match Context");
    const live = sidebar(home([dir("defiance"), dir("context"), dir("Context"), dir("wiki")]), { liveRoles: new Set(["context"]) });
    expect(live).toContain("side-row side-conflict");
    expect(live).not.toContain("side-row side-conflict side-inert");
  });

  it("an empty root says where to bring work, and no root says nothing but the header and hint", () => {
    const page = sidebar(home([dir("views")]));
    expect(page).toContain("No work here yet. Move, copy, or clone folders into /root, then Refresh.");
    expect(rows(page)).toEqual(["Context is not created. Click to create context/ inside the root.", "Wiki is not created. Click to create wiki/ inside the root.", "Definitions is not created. Click to create definitions/ inside the root."]);
    const none = sidebar(null);
    expect(none).toContain("alabs root");
    expect(none).not.toContain(">WORK<");
  });
});

describe("the main canvas", () => {
  it("is the root Visual View surface and no longer the place listing", () => {
    const page = body();
    expect(page).toContain("root-view");
    expect(page).toContain("views/.root/map.svg");
    expect(page).toContain("Run Raven");
    expect(page).toContain("Opening root view…");
    expect(page).toContain("Select a place to see what it holds.");
    for (const old of ['class="diagram"', 'class="root-node"', "group-work", "group-know", 'class="legend', 'class="nodes"', "+ New folder", ">cockpit<", ">Zed<"]) {
      expect(page, old).not.toContain(old);
    }
  });

  it("keeps the ACTIVE WORK row above the map, and the reading state before the root is listed", () => {
    const page = body(home(), { activeWork: "defiance", activeCounts: { tabs: 3, unsaved: 1 } });
    expect(page).toContain("ACTIVE WORK");
    expect(page).toContain("3 tabs · 1 unsaved");
    expect(page).toContain("Return to defiance");
    expect(page).toContain("root-view");
    expect(body(null, { loading: true })).toContain("Reading /root…");
    expect(body(null, { loading: true })).not.toContain("root-view");
  });
});
