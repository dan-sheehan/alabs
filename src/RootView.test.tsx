// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRootNode, rootBuildCopy, RootView } from "./RootView";
import { renderRootSvg } from "./rootRender";
import { classifyRoot, rootViewPath } from "./places";
import { appendLog, readFile } from "./subject";
import type { Entry, FileContent } from "./subject";
import type { RootMap } from "./rootMap";
import type { BuildState } from "./viewBuild";
import { RAVEN } from "./creatures";

// The Home canvas rendered for real in jsdom: the read and check of the
// root map, node selection, the inspector's facts and its three actions
// (enter a place, open its Visual View, open a knowledge place), the named
// build states in place of a missing map, the readout over a kept drawing,
// the stale state, and that selecting a node opens nothing by itself.

vi.mock("./subject", () => ({ readFile: vi.fn(), appendLog: vi.fn(async () => {}) }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });
const LISTING = classifyRoot([dir("defiance"), dir("notes"), dir("context"), dir("wiki"), dir("views")]);

const SAVED: RootMap = {
  version: 1,
  title: "alabs root",
  places: [
    {
      placeId: "defiance",
      kind: "repo",
      description: "A source-backed corpus for one season.",
      highlights: [
        { id: "cli", label: "CLI" },
        { id: "web-ui", label: "Web UI" },
      ],
    },
    { placeId: "notes", kind: "none", description: "", highlights: [] },
  ],
  knowledge: [
    { role: "context", label: "Context", folder: "context" },
    { role: "wiki", label: "Wiki", folder: "wiki" },
  ],
};
const MAP = renderRootSvg(SAVED);

const file = (content: string): FileContent => ({ name: "map.svg", content, stamp: { identity: "1:1", mtime_secs: 0, mtime_nanos: 0, len: content.length } });
const missing = () => {
  throw "cannot read views/.root/map.svg: No such file or directory (os error 2)";
};

let container: HTMLDivElement;
let root: Root;
const handlers = { onOpenPlace: vi.fn(), onOpenView: vi.fn(), onOpenRole: vi.fn(), onRebuild: vi.fn(), onRefresh: vi.fn() };

function render(props: Partial<{ saved: RootMap | null; reload: number; locked: boolean; build: BuildState | null; views: Set<string>; listing: typeof LISTING }> = {}) {
  act(() => {
    root.render(
      <RootView listing={LISTING} git={new Map([["defiance", "repo"]])} views={new Set(["defiance"])} saved={SAVED} reload={0} locked={false} build={null} {...handlers} {...props} />,
    );
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const text = () => container.textContent ?? "";
const svg = () => container.querySelector(".view-canvas svg");
const group = (name: string) => Array.from(container.querySelectorAll("[data-landmark]")).find((g) => g.getAttribute("data-landmark") === name) ?? null;
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element, key: string) => act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const inspector = () => container.querySelector(".view-inspector") as HTMLElement;
const chips = () => Array.from(inspector().querySelectorAll("button.chip")) as HTMLButtonElement[];
const chip = (label: string) => chips().find((c) => c.textContent === label) ?? null;
const header = () => container.querySelector(".surface-header") as HTMLElement;
const rebuild = () => Array.from(header().querySelectorAll("button.chip")).find((c) => c.textContent === "Run Raven") as HTMLButtonElement;
const readout = () => header().querySelector(".view-build-status")?.textContent ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readFile).mockResolvedValue(file(MAP));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("open", () => {
  it("reads the root map once, shows the drawing with every place and knowledge folder as a target, and the empty inspector prompt", async () => {
    render();
    expect(text()).toContain("Opening root view…");
    await settle();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(rootViewPath());
    expect(svg()).not.toBeNull();
    expect(group("defiance")?.getAttribute("role")).toBe("button");
    expect(group("Wiki")?.getAttribute("tabindex")).toBe("0");
    expect(inspector().textContent).toBe("Select a place to see what it holds.");
    expect(header().textContent).toContain(rootViewPath());
    expect(readout()).toBeNull();
    expect(rebuild().disabled).toBe(false);
    expect(handlers.onOpenPlace).not.toHaveBeenCalled();
  });

  it("re-reads on a reload bump and sanitizes a hostile file before it enters the DOM", async () => {
    render();
    await settle();
    vi.mocked(readFile).mockResolvedValue(file(MAP.replace("</svg>", '<script>window.x=1</script><image href="http://evil/a.png"/></svg>')));
    render({ reload: 1 });
    await settle();
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("image")).toBeNull();
    expect(svg()).not.toBeNull();
  });
});

describe("selection and the inspector", () => {
  it("a work node shows its kind, description and highlights from the saved facts, with Enter place and Open visual view; selecting opens nothing", async () => {
    render();
    await settle();
    click(group("defiance")!);
    expect(group("defiance")?.getAttribute("data-selected")).toBe("true");
    expect(inspector().textContent).toContain("defiance");
    expect(inspector().textContent).toContain("git repository");
    expect(inspector().textContent).toContain("A source-backed corpus for one season.");
    expect(inspector().textContent).toContain("HIGHLIGHTS");
    expect(inspector().textContent).toContain("▪ CLI");
    expect(inspector().textContent).toContain("▪ Web UI");
    expect(chips().map((c) => c.textContent)).toEqual(["Enter place", "Open visual view"]);
    expect(handlers.onOpenPlace).not.toHaveBeenCalled();
    expect(handlers.onOpenView).not.toHaveBeenCalled();
    click(chip("Enter place")!);
    expect(handlers.onOpenPlace).toHaveBeenCalledWith("defiance");
    click(chip("Open visual view")!);
    expect(handlers.onOpenView).toHaveBeenCalledWith("defiance");
    expect(handlers.onOpenRole).not.toHaveBeenCalled();
  });

  it("a work node without a Visual View offers Enter place only, and one without saved facts falls back to the drawing's note", async () => {
    render({ saved: null });
    await settle();
    press(group("notes")!, "Enter");
    expect(inspector().textContent).toContain("notes");
    expect(inspector().textContent).toContain("folder");
    expect(inspector().textContent).not.toContain("HIGHLIGHTS");
    expect(chips().map((c) => c.textContent)).toEqual(["Enter place"]);
    click(group("defiance")!);
    expect(inspector().textContent).toContain("A source-backed corpus for one season.");
    expect(inspector().textContent).not.toContain("HIGHLIGHTS");
  });

  it("a knowledge node offers Open, which enters the role through the callback", async () => {
    render();
    await settle();
    click(group("Wiki")!);
    expect(inspector().textContent).toContain("Wiki");
    expect(inspector().textContent).toContain("knowledge place");
    expect(chips().map((c) => c.textContent)).toEqual(["Open"]);
    click(chip("Open")!);
    expect(handlers.onOpenRole).toHaveBeenCalledWith("wiki");
    expect(handlers.onOpenPlace).not.toHaveBeenCalled();
  });

  it("a node whose place is no longer in the root says so and offers nothing", async () => {
    render({ listing: classifyRoot([dir("notes"), dir("context"), dir("wiki")]) });
    await settle();
    click(group("defiance")!);
    expect(inspector().textContent).toContain("defiance is not in the root right now.");
    expect(chips()).toEqual([]);
    expect(resolveRootNode({ name: "defiance", note: "", paths: ["defiance"], badPaths: [] }, LISTING)).toEqual({ kind: "work", name: "defiance" });
    expect(resolveRootNode({ name: "Context", note: "", paths: ["Context"], badPaths: [] }, LISTING)).toEqual({ kind: "know", role: "context", label: "Context" });
    expect(resolveRootNode({ name: "Definitions", note: "", paths: ["definitions"], badPaths: [] }, LISTING)).toEqual({ kind: "gone", name: "Definitions" });
    expect(resolveRootNode({ name: "x", note: "", paths: [], badPaths: ["/abs"] }, LISTING)).toEqual({ kind: "gone", name: "x" });
  });

  it("does nothing under the lock", async () => {
    render({ locked: true });
    await settle();
    click(group("defiance")!);
    expect(inspector().textContent).toBe("Select a place to see what it holds.");
    expect(rebuild().disabled).toBe(true);
  });
});

describe("a missing map", () => {
  it("says what it needs: to run Raven, or that it is building, failed, unavailable, or missing Raven's model", async () => {
    vi.mocked(readFile).mockImplementation(async () => missing());
    render();
    await settle();
    expect(text()).toContain("No root view yet. Run Raven to build one.");
    expect(svg()).toBeNull();
    // Run Raven needs no model chosen in alabs: Raven brings its own.
    expect(rebuild().disabled).toBe(false);
    expect(rebuild().title).toBe(RAVEN.job);
    render({ build: { kind: "queued" } });
    expect(text()).toContain("Building root visual view…");
    expect(rebuild().disabled).toBe(true);
    expect(container.querySelector(".view-state button.chip")).toBeNull();
    render({ build: { kind: "building" } });
    expect(text()).toContain("Building root visual view…");
    render({ build: { kind: "failed", reason: "invalid" } });
    expect(text()).toContain("Root visual view could not be built.");
    expect(rebuild().disabled).toBe(false);
    render({ build: { kind: "failed", reason: "unavailable" } });
    expect(text()).toContain("Local model unavailable.");
    // A Raven run whose model Ollama does not have names that model, from Raven's own file.
    render({ build: { kind: "failed", reason: "not_installed" } });
    expect(text()).toContain(`Raven needs ${RAVEN.model}.`);
    expect(text()).not.toContain("Run Raven to build one.");
    expect(rootBuildCopy({ kind: "built" })).toBeNull();
    expect(rootBuildCopy(null)).toEqual({ text: "No root view yet. Run Raven to build one.", error: false });
  });

  it("a file that is not a usable map is a named state with Refresh, never a blank canvas", async () => {
    vi.mocked(readFile).mockResolvedValue(file("<html>not a map</html>"));
    render();
    await settle();
    expect(text()).toContain("Could not show the view:");
    expect(text()).toContain(rootViewPath());
    expect(svg()).toBeNull();
    expect(vi.mocked(appendLog).mock.calls.some((c) => String(c[0]).includes("root view:"))).toBe(true);
  });
});

describe("over a kept drawing", () => {
  it("a waiting, running or failed rebuild is a header readout and the drawing stays, with Rebuild disabled while it runs", async () => {
    render({ build: { kind: "queued" } });
    await settle();
    expect(svg()).not.toBeNull();
    expect(readout()).toBe("Building root visual view…");
    expect(rebuild().disabled).toBe(true);
    render({ build: { kind: "failed", reason: "model" } });
    expect(svg()).not.toBeNull();
    expect(readout()).toBe("Root visual view could not be built.");
    expect(rebuild().disabled).toBe(false);
    render({ build: { kind: "built" } });
    expect(readout()).toBeNull();
  });

  it("says Root view needs rebuild when the saved place set differs from the root, or when nothing is saved", async () => {
    render({ listing: classifyRoot([dir("defiance"), dir("notes"), dir("zed"), dir("context"), dir("wiki")]) });
    await settle();
    expect(svg()).not.toBeNull();
    expect(readout()).toBe("Root view needs rebuild.");
    expect(rebuild().disabled).toBe(false);
    render({ saved: null });
    expect(readout()).toBe("Root view needs rebuild.");
    render();
    expect(readout()).toBeNull();
    // A running build outranks the stale readout.
    render({ saved: null, build: { kind: "building" } });
    expect(readout()).toBe("Building root visual view…");
  });

  it("Run Raven and Refresh go through their callbacks and nothing else", async () => {
    render();
    await settle();
    click(rebuild());
    expect(handlers.onRebuild).toHaveBeenCalledTimes(1);
    click(Array.from(header().querySelectorAll("button.chip")).find((c) => c.textContent === "Refresh")!);
    expect(handlers.onRefresh).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});

it("a previously built map removed before Refresh directs an explicit Raven run", async () => {
  render({ build: { kind: "built" } }); await settle();
  expect(svg()).not.toBeNull();
  vi.mocked(readFile).mockImplementation(async () => missing());
  render({ build: { kind: "built" }, reload: 1 }); await settle();
  expect(svg()).toBeNull();
  expect(text()).toContain("No root view yet. Run Raven to build one.");
  expect(text()).not.toContain("Refresh to build");
  expect(handlers.onRebuild).not.toHaveBeenCalled();
  expect(rebuild().disabled).toBe(false);
});
