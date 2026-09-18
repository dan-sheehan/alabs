// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualView } from "./VisualView";
import { appendLog, readFile } from "./subject";
import type { FileContent } from "./subject";
import type { BuildState } from "./viewBuild";
import { RAVEN } from "./creatures";

// The Visual View surface (DESIGN.md 6.8) rendered for real in jsdom: the
// read and check, landmark selection, the inspector, the file handoff, the
// named failure states and Refresh. `openPath` itself is App's; here it is
// the `onOpenPath` callback and the test proves the surface calls it with
// the landmark's path and nothing else.

vi.mock("./subject", () => ({ readFile: vi.fn(), appendLog: vi.fn(async () => {}) }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW = "views/defiance/map.svg";
const MAP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <g data-landmark="Validation" data-note="Where every rule runs." data-path="defiance/src/defiance/corpus.py">
    <rect id="v" x="0" y="0" width="90" height="40"/><text x="4" y="20">Validation</text>
    <g data-path="defiance/tests/test_corpus.py"></g>
    <g data-path="../outside.md"></g>
  </g>
  <g data-landmark="Query path" data-path="defiance/src/defiance/query.py"><rect id="q" x="100" y="0" width="90" height="40"/></g>
</svg>`;
const MAP_RENAMED = MAP.replace('data-landmark="Validation"', 'data-landmark="Checks"');

const file = (content: string): FileContent => ({ name: "map.svg", content, stamp: { identity: "1:1", mtime_secs: 0, mtime_nanos: 0, len: content.length } });

let container: HTMLDivElement;
let root: Root;
const handlers = { onOpenPath: vi.fn(), onOpenSource: vi.fn(), onRefresh: vi.fn(), onRebuild: vi.fn() };

function render(props: Partial<{ reload: number; locked: boolean; shown: boolean; build: BuildState | null }> = {}) {
  act(() => {
    root.render(<VisualView relPath={VIEW} placeName="defiance" reload={0} locked={false} shown build={null} {...handlers} {...props} />);
  });
}

/** Let the read settle: the surface awaits one promise, then sets state. */
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
const fileLinks = () => Array.from(inspector().querySelectorAll("button.view-file")) as HTMLButtonElement[];
const logged = () => vi.mocked(appendLog).mock.calls.map((c) => String(c[0]));

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
  it("shows Opening view…, then the sanitized drawing with keyboard handles, the header and the empty inspector prompt", async () => {
    render();
    expect(text()).toContain("Opening view…");
    expect(svg()).toBeNull();
    await settle();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(VIEW);
    expect(svg()).not.toBeNull();
    expect(text()).not.toContain("Opening view…");
    expect(text()).toContain("◫ views/defiance/map.svg");
    expect(text()).toContain("Select a landmark to see its real files.");
    const v = group("Validation")!;
    expect(v.getAttribute("role")).toBe("button");
    expect(v.getAttribute("tabindex")).toBe("0");
    expect(v.getAttribute("aria-label")).toBe("Validation");
    expect(container.querySelector("[data-selected]")).toBeNull();
  });

  it("Open source, Refresh and Run Raven are the header chips", async () => {
    render();
    await settle();
    const chips = Array.from(container.querySelectorAll(".surface-header .chip")) as HTMLButtonElement[];
    expect(chips.map((c) => c.textContent)).toEqual(["Open source", "Refresh", "Run Raven"]);
    click(chips[0]);
    expect(handlers.onOpenSource).toHaveBeenCalledTimes(1);
    click(chips[1]);
    expect(handlers.onRefresh).toHaveBeenCalledTimes(1);
    click(chips[2]);
    expect(handlers.onRebuild).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenPath).not.toHaveBeenCalled();
  });
});

describe("selection and the inspector", () => {
  it("a click on any part of a landmark selects it, marks it, and fills the inspector with name, note and FILES", async () => {
    render();
    await settle();
    click(container.querySelector("#v")!);
    expect(group("Validation")?.getAttribute("data-selected")).toBe("true");
    expect(group("Query path")?.hasAttribute("data-selected")).toBe(false);
    const box = inspector();
    expect(box.querySelector(".view-landmark-name")?.textContent).toBe("Validation");
    expect(box.querySelector(".view-landmark-note")?.textContent).toBe("Where every rule runs.");
    expect(box.textContent).toContain("FILES");
    expect(fileLinks().map((b) => b.title)).toEqual(["defiance/src/defiance/corpus.py", "defiance/tests/test_corpus.py"]);
    expect(box.textContent).toContain("../outside.md · not a usable path");
    expect(box.textContent).not.toContain("Select a landmark");
  });

  it("a file link routes exactly its path through onOpenPath and the landmark stays selected; a bad path has no link", async () => {
    render();
    await settle();
    click(container.querySelector("#v")!);
    click(fileLinks()[1]);
    expect(handlers.onOpenPath).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenPath).toHaveBeenCalledWith("defiance/tests/test_corpus.py");
    expect(group("Validation")?.getAttribute("data-selected")).toBe("true");
    expect(inspector().querySelector(".view-landmark-name")?.textContent).toBe("Validation");
    expect(inspector().querySelectorAll("button.view-file")).toHaveLength(2);
    expect(inspector().querySelector(".view-file-bad")?.tagName).toBe("DIV");
  });

  it("Enter selects a landmark from the keyboard; selecting another moves the mark; the selection survives being hidden and shown again", async () => {
    render();
    await settle();
    press(group("Query path")!, "Enter");
    expect(group("Query path")?.getAttribute("data-selected")).toBe("true");
    expect(inspector().querySelector(".view-landmark-name")?.textContent).toBe("Query path");
    expect(fileLinks().map((b) => b.title)).toEqual(["defiance/src/defiance/query.py"]);
    click(container.querySelector("#v")!);
    expect(group("Query path")?.hasAttribute("data-selected")).toBe(false);
    expect(group("Validation")?.getAttribute("data-selected")).toBe("true");
    // Another tab or place is shown, then this one again: nothing was re-read and the selection is intact.
    render({ shown: false });
    render({ shown: true });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(group("Validation")?.getAttribute("data-selected")).toBe("true");
    expect(inspector().querySelector(".view-landmark-name")?.textContent).toBe("Validation");
  });

  it("a click on empty canvas or a shape outside any landmark selects nothing", async () => {
    vi.mocked(readFile).mockResolvedValue(file('<svg xmlns="http://www.w3.org/2000/svg"><rect id="plain"/><g data-landmark="A"><rect id="a"/></g></svg>'));
    render();
    await settle();
    click(container.querySelector("#plain")!);
    expect(container.querySelector("[data-selected]")).toBeNull();
    expect(text()).toContain("Select a landmark to see its real files.");
    click(container.querySelector("#a")!);
    expect(inspector().textContent).toContain("none listed");
  });

  it("while locked, clicks change nothing", async () => {
    render({ locked: true });
    await settle();
    click(container.querySelector("#v")!);
    expect(container.querySelector("[data-selected]")).toBeNull();
    expect(text()).toContain("Select a landmark to see its real files.");
  });
});

describe("named failure states replace the drawing and keep the inspector column", () => {
  it("missing view: the next action is to run Raven", async () => {
    vi.mocked(readFile).mockRejectedValue("cannot access views/defiance/map.svg: No such file or directory (os error 2)");
    render();
    await settle();
    expect(text()).toContain("No visual view yet.");
    expect(text()).toContain("Run Raven to build one.");
    expect(svg()).toBeNull();
    expect(inspector().textContent).toContain("Select a landmark to see its real files.");
    expect(text()).not.toContain("Opening view…");
    expect(logged().some((l) => l.includes("view views/defiance/map.svg: cannot access"))).toBe(true);
  });

  it("too large", async () => {
    vi.mocked(readFile).mockRejectedValue("file is larger than 2 MB: views/defiance/map.svg");
    render();
    await settle();
    expect(text()).toContain("View is too large to open in alabs.");
    expect(svg()).toBeNull();
  });

  it("unreadable", async () => {
    vi.mocked(readFile).mockRejectedValue("cannot access views/defiance/map.svg: Permission denied (os error 13)");
    render();
    await settle();
    expect(text()).toContain("Could not read the view: cannot access views/defiance/map.svg: Permission denied.");
    expect(svg()).toBeNull();
  });

  it("sanitizer rejection or malformed SVG", async () => {
    vi.mocked(readFile).mockResolvedValue(file("<p>not a map</p>"));
    render();
    await settle();
    expect(text()).toContain("Could not show the view: no SVG drawing was found in it. Fix views/defiance/map.svg, then Refresh.");
    expect(svg()).toBeNull();
    expect(container.querySelector("p")).toBeNull();
    expect(logged().some((l) => l.includes("view views/defiance/map.svg: no SVG drawing"))).toBe(true);
  });

  it("a hostile map renders with nothing unsafe in the document", async () => {
    vi.mocked(readFile).mockResolvedValue(
      file('<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned=1"><script>window.pwned=2</script><g data-landmark="A" onclick="window.pwned=3"><rect id="a"/><image href="http://evil.example/x.png"/></g></svg>'),
    );
    render();
    await settle();
    expect(svg()).not.toBeNull();
    expect(container.innerHTML).not.toContain("pwned");
    expect(container.innerHTML).not.toContain("evil.example");
    expect(container.querySelector("script, image")).toBeNull();
    click(container.querySelector("#a")!);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    expect(inspector().querySelector(".view-landmark-name")?.textContent).toBe("A");
  });
});

describe("Refresh", () => {
  it("rereads the file and replaces the drawing; the selection survives while its landmark exists and clears when it is gone", async () => {
    render();
    await settle();
    click(container.querySelector("#v")!);
    expect(group("Validation")?.getAttribute("data-selected")).toBe("true");

    // The landmark is still there after the reread: still selected, drawing replaced.
    const before = svg();
    render({ reload: 1 });
    await settle();
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(svg()).not.toBe(before);
    expect(group("Validation")?.getAttribute("data-selected")).toBe("true");
    expect(inspector().querySelector(".view-landmark-name")?.textContent).toBe("Validation");

    // The author renamed it: nothing is selected any more, and the inspector says so.
    vi.mocked(readFile).mockResolvedValue(file(MAP_RENAMED));
    render({ reload: 2 });
    await settle();
    expect(group("Validation")).toBeNull();
    expect(group("Checks")).not.toBeNull();
    expect(container.querySelector("[data-selected]")).toBeNull();
    expect(text()).toContain("Select a landmark to see its real files.");
  });

  it("a failed reread replaces the drawing with the named state and keeps the surface; the next good reread brings it back", async () => {
    render();
    await settle();
    click(container.querySelector("#v")!);
    vi.mocked(readFile).mockRejectedValue("cannot access views/defiance/map.svg: No such file or directory (os error 2)");
    render({ reload: 1 });
    await settle();
    expect(svg()).toBeNull();
    expect(text()).toContain("No visual view yet.");
    expect(container.querySelector("[data-selected]")).toBeNull();
    expect(inspector().textContent).toContain("Select a landmark to see its real files.");
    vi.mocked(readFile).mockResolvedValue(file(MAP));
    render({ reload: 2 });
    await settle();
    expect(svg()).not.toBeNull();
    expect(text()).not.toContain("No visual view yet.");
  });

  it("a reread keeps the current drawing on screen until the new one is ready; nothing is blank in between", async () => {
    render();
    await settle();
    let release!: (value: FileContent) => void;
    vi.mocked(readFile).mockImplementation(() => new Promise<FileContent>((r) => (release = r)));
    render({ reload: 1 });
    expect(svg()).not.toBeNull();
    expect(text()).not.toContain("Opening view…");
    await act(async () => {
      release(file(MAP_RENAMED));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(group("Checks")).not.toBeNull();
  });
});

describe("build states (automatic Visual Views)", () => {
  const missing = () => vi.mocked(readFile).mockRejectedValue("cannot access views/defiance/map.svg: No such file or directory (os error 2)");
  const rebuildChip = () => Array.from(container.querySelectorAll(".surface-header .chip")).find((c) => c.textContent === "Run Raven") as HTMLButtonElement;
  const stateBlock = () => container.querySelector(".view-state") as HTMLElement | null;

  it("a missing view with nothing known says there is no view yet and to run Raven; Run Raven is enabled and names Raven's job", async () => {
    missing();
    render();
    await settle();
    expect(stateBlock()?.textContent).toContain("No visual view yet.");
    expect(stateBlock()?.textContent).toContain("Run Raven to build one.");
    expect(stateBlock()?.textContent).not.toContain("View file not found");
    expect(stateBlock()?.querySelector(".chip")?.textContent).toBe("Refresh");
    expect(rebuildChip().disabled).toBe(false);
    expect(rebuildChip().title).toBe(RAVEN.job);
    expect(svg()).toBeNull();
  });

  it("waiting and building are said in place, without a Refresh chip, and Run Raven is disabled", async () => {
    missing();
    render({ build: { kind: "queued" } });
    await settle();
    expect(stateBlock()?.textContent).toBe("Waiting to build the visual view…");
    expect(stateBlock()?.querySelector(".chip")).toBeNull();
    expect(rebuildChip().disabled).toBe(true);
    render({ build: { kind: "building" } });
    expect(stateBlock()?.textContent).toBe("Building visual view…");
    expect(rebuildChip().disabled).toBe(true);
  });

  it("a failed build names the failure and offers Run Raven; an unreachable local model names that; a Raven run's missing model is named", async () => {
    missing();
    render({ build: { kind: "failed", reason: "invalid" } });
    await settle();
    expect(stateBlock()?.querySelector(".error")?.textContent).toBe("Visual view could not be built.");
    expect(rebuildChip().disabled).toBe(false);
    click(rebuildChip());
    expect(handlers.onRebuild).toHaveBeenCalledTimes(1);
    render({ build: { kind: "failed", reason: "unavailable" } });
    expect(stateBlock()?.querySelector(".error")?.textContent).toBe("Local model unavailable.");
    expect(stateBlock()?.textContent).toContain("Start the local model, then run Raven again.");
    render({ build: { kind: "failed", reason: "not_installed" } });
    expect(stateBlock()?.querySelector(".error")?.textContent).toBe(`Raven needs ${RAVEN.model}.`);
    expect(stateBlock()?.textContent).toContain("Install it in Ollama, then run Raven again.");
    expect(rebuildChip().disabled).toBe(false);
  });

  it("a view that was built but is not on disk directs an explicit Raven run", async () => {
    missing();
    render({ build: { kind: "built" } });
    await settle();
    expect(stateBlock()?.textContent).toContain("No visual view yet.");
    expect(stateBlock()?.textContent).toContain("Run Raven to build one.");
    expect(handlers.onRebuild).not.toHaveBeenCalled();
    expect(rebuildChip().disabled).toBe(false);
  });

  it("with a drawing on screen a rebuild is a header readout and the drawing stays, through waiting, building and failure", async () => {
    render();
    await settle();
    expect(svg()).not.toBeNull();
    expect(container.querySelector(".view-build-status")).toBeNull();
    render({ build: { kind: "queued" } });
    expect(container.querySelector(".view-build-status")?.textContent).toBe("Waiting to build the visual view…");
    expect(svg()).not.toBeNull();
    expect(rebuildChip().disabled).toBe(true);
    render({ build: { kind: "building" } });
    expect(container.querySelector(".view-build-status")?.textContent).toBe("Building visual view…");
    expect(svg()).not.toBeNull();
    render({ build: { kind: "failed", reason: "model" } });
    const status = container.querySelector(".view-build-status");
    expect(status?.textContent).toBe("Visual view could not be built.");
    expect(status?.classList.contains("error")).toBe(true);
    expect(svg()).not.toBeNull();
    expect(rebuildChip().disabled).toBe(false);
    render({ build: { kind: "built" } });
    expect(container.querySelector(".view-build-status")).toBeNull();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("Run Raven needs no model chosen in alabs and is inert under the lock", async () => {
    render();
    await settle();
    expect(rebuildChip().disabled).toBe(false);
    render({ locked: true });
    expect(rebuildChip().disabled).toBe(true);
    render({ locked: false });
    expect(rebuildChip().disabled).toBe(false);
  });
});

describe("overlapping manual Refresh", () => {
  it.each(["success", "missing"])("an older %s cannot replace the newest saved map or its selection", async (outcome) => {
    render();
    await settle();
    let resolve!: (value: FileContent) => void;
    let reject!: (reason: string) => void;
    vi.mocked(readFile).mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    render({ reload: 1 });
    vi.mocked(readFile).mockResolvedValue(file(MAP_RENAMED));
    render({ reload: 2 });
    await settle();
    click(group("Checks")!);
    await act(async () => {
      if (outcome === "success") resolve(file(MAP));
      else reject("No such file or directory");
    });
    expect(group("Checks")?.getAttribute("data-selected")).toBe("true");
    expect(group("Validation")).toBeNull();
    expect(text()).not.toContain("No visual view yet.");
    expect(handlers.onRebuild).not.toHaveBeenCalled();
  });
});
