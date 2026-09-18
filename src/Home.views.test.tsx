// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HomeSidebar, viewSuffix } from "./Home";
import { classifyRoot } from "./places";
import type { Entry } from "./subject";
import type { BuildState } from "./viewBuild";

// The Home middle column's Visual View mark per work place: what each row
// says, and that only the map's existence and the session's build
// knowledge decide it. No model is needed to show Home.

const dir = (name: string): Entry => ({ name, rel_path: name, is_dir: true });

function html(builds: Map<string, BuildState>, views = new Set(["defiance"])) {
  return renderToString(
    <HomeSidebar
      root={{ path: "/root", name: "root" }}
      home={{ listing: classifyRoot([dir("defiance"), dir("cockpit"), dir("zed"), dir("views"), dir("wiki")]), views, git: new Map(), rootView: { exists: false, saved: null } }}
      locked={false}
      activeWork={null}
      liveRoles={new Set()}
      builds={builds}
      onRefresh={vi.fn()}
      onOpenPlace={vi.fn()}
      onOpenView={vi.fn()}
      onOpenRole={vi.fn()}
      onNewFolder={vi.fn()}
      onCreateRole={vi.fn()}
    />,
  );
}

const marks = (page: string) => Array.from(page.matchAll(/class="side-suffix mono"[^>]*title="Open the visual view of ([^"]+)"[^>]*>([^<]*)</g), (m) => [m[1], m[2]]);

describe("the row's Visual View mark", () => {
  it("says what the map's existence and the build queue know, per place", () => {
    expect(viewSuffix(true, null)).toBe("◫ view");
    expect(viewSuffix(true, { kind: "failed", reason: "invalid" })).toBe("◫ view");
    expect(viewSuffix(false, { kind: "queued" })).toBe("◫ building…");
    expect(viewSuffix(false, { kind: "building" })).toBe("◫ building…");
    expect(viewSuffix(false, { kind: "failed", reason: "invalid" })).toBe("◫ not built");
    expect(viewSuffix(false, { kind: "failed", reason: "unavailable" })).toBe("◫ unavailable");
    // A Raven run whose model is missing is a failed build; nothing known and no map is simply no view yet.
    expect(viewSuffix(false, { kind: "failed", reason: "not_installed" })).toBe("◫ not built");
    expect(viewSuffix(false, null)).toBe("◫ no view");
    // A build that finished but whose map is not on disk yet reads as no view until Home re-reads.
    expect(viewSuffix(false, { kind: "built" })).toBe("◫ no view");
  });

  it("renders one mark per row from those facts, each a target that opens the place's Visual View", () => {
    const page = html(new Map([["cockpit", { kind: "building" }]]));
    expect(marks(page)).toEqual([
      ["cockpit", "◫ building…"],
      ["defiance", "◫ view"],
      ["zed", "◫ no view"],
    ]);
    const none = html(new Map());
    expect(marks(none)).toEqual([
      ["cockpit", "◫ no view"],
      ["defiance", "◫ view"],
      ["zed", "◫ no view"],
    ]);
    const failed = html(new Map([["zed", { kind: "failed", reason: "unavailable" }]]));
    expect(marks(failed)).toEqual([
      ["cockpit", "◫ no view"],
      ["defiance", "◫ view"],
      ["zed", "◫ unavailable"],
    ]);
  });
});

// jsdom dispatches bubbling keys but does not synthesize the browser's button
// click; dispatch that separately, so an outer key handler cannot hide here.
it.each(["Enter", " "])("keeps nested %s activation separate and respects the lock", (key) => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const openPlace = vi.fn(); const openView = vi.fn();
  const render = (locked: boolean) => act(() => root.render(<HomeSidebar root={{ path: "/root", name: "root" }} home={{ listing: classifyRoot([dir("thinking")]), views: new Set(), git: new Map(), rootView: { exists: false, saved: null } }} locked={locked} activeWork="thinking" liveRoles={new Set()} builds={new Map()} onRefresh={vi.fn()} onOpenPlace={openPlace} onOpenView={openView} onOpenRole={vi.fn()} onNewFolder={vi.fn()} onCreateRole={vi.fn()} />));
  try {
    render(false);
    const row = container.querySelector<HTMLElement>(".side-row")!;
    const view = row.querySelector<HTMLButtonElement>("button")!;
    view.focus(); expect(document.activeElement).toBe(view);
    act(() => view.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    expect(openPlace).not.toHaveBeenCalled();
    act(() => view.click()); expect(openView).toHaveBeenCalledExactlyOnceWith("thinking");
    row.focus(); expect(document.activeElement).toBe(row);
    act(() => row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    expect(openPlace).toHaveBeenCalledExactlyOnceWith("thinking");
    render(true);
    expect(view.disabled).toBe(true); expect(row.tabIndex).toBe(-1);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    act(() => { view.click(); row.click(); row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
    expect(openPlace).toHaveBeenCalledTimes(1); expect(openView).toHaveBeenCalledTimes(1);
  } finally { act(() => root.unmount()); container.remove(); }
});
