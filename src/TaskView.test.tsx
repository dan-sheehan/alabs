// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskView } from "./TaskView";
import { EMPTY_DRAFT, type ContextCandidate, type TaskDraft } from "./task";

// The Task tab surface (DESIGN.md 6.10) rendered for real in jsdom: the
// sections, the context rows, the unsaved mark, the disabled Copy chip, and
// the packet shown selected after a failed copy. The copy itself and the
// baseline are App's and are tested in App.step6.test.tsx.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const handlers = { onDraft: vi.fn(), onCopy: vi.fn(), onTerminal: vi.fn() };
const candidates: ContextCandidate[] = [
  { relPath: "defiance/src/a.py", dirty: false },
  { relPath: "defiance/README.md", dirty: true },
  { relPath: "wiki/notes.md", dirty: false },
];

function render(draft: TaskDraft, rows: ContextCandidate[] = candidates, locked = false) {
  act(() => {
    root.render(<TaskView placeName="defiance" draft={draft} candidates={rows} locked={locked} {...handlers} />);
  });
}

const text = () => container.textContent ?? "";
const copyChip = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Copy task packet") as HTMLButtonElement;
const terminalChip = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Open in Terminal") as HTMLButtonElement;
const boxes = () => Array.from(container.querySelectorAll("input[type=checkbox]")) as HTMLInputElement[];

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the Task tab", () => {
  it("shows the three sections, one unticked row per candidate in order, and the prompt when nothing is open", () => {
    render(EMPTY_DRAFT);
    expect(text()).toContain("TASK");
    expect(text()).toContain("CONTEXT FILES");
    expect(text()).toContain("CONSTRAINTS");
    expect(boxes()).toHaveLength(3);
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(Array.from(container.querySelectorAll(".task-path")).map((e) => e.textContent)).toEqual(["defiance/src/a.py", "defiance/README.md", "wiki/notes.md"]);
    expect(text()).not.toContain("•");
    render(EMPTY_DRAFT, []);
    expect(text()).toContain("Open the files you want to include, then tick them here.");
    expect(boxes()).toHaveLength(0);
  });

  it("Copy is disabled for an empty task and while a ticked file is unsaved; Terminal stays enabled; the unsaved mark shows only on a ticked dirty row", () => {
    render(EMPTY_DRAFT);
    expect(copyChip().disabled).toBe(true);
    expect(terminalChip().disabled).toBe(false);
    render({ ...EMPTY_DRAFT, text: "   " });
    expect(copyChip().disabled).toBe(true);
    render({ ...EMPTY_DRAFT, text: "Do the thing", selected: new Set(["defiance/src/a.py"]) });
    expect(copyChip().disabled).toBe(false);
    expect(text()).not.toContain("•");
    render({ ...EMPTY_DRAFT, text: "Do the thing", selected: new Set(["defiance/src/a.py", "defiance/README.md"]) });
    expect(copyChip().disabled).toBe(true);
    expect(container.querySelectorAll(".dirty-mark")).toHaveLength(1);
    expect(copyChip().title).toBe("Save defiance/README.md first");
    // The same dirty file, saved: the row loses its mark and Copy is back.
    render({ ...EMPTY_DRAFT, text: "Do the thing", selected: new Set(["defiance/src/a.py", "defiance/README.md"]) }, candidates.map((c) => ({ ...c, dirty: false })));
    expect(copyChip().disabled).toBe(false);
    expect(container.querySelectorAll(".dirty-mark")).toHaveLength(0);
    // Locked: everything is inert.
    render({ ...EMPTY_DRAFT, text: "x" }, candidates, true);
    expect(copyChip().disabled).toBe(true);
    expect(terminalChip().disabled).toBe(true);
  });

  it("ticking and unticking, typing and the two actions reach the owner; the draft itself is never kept here", () => {
    render({ ...EMPTY_DRAFT, text: "x" });
    act(() => {
      boxes()[0].click();
    });
    expect(handlers.onDraft).toHaveBeenCalledTimes(1);
    const tick = handlers.onDraft.mock.calls[0][0] as (d: TaskDraft) => TaskDraft;
    expect([...tick(EMPTY_DRAFT).selected]).toEqual(["defiance/src/a.py"]);
    const untick = tick({ ...EMPTY_DRAFT, selected: new Set(["defiance/src/a.py", "wiki/notes.md"]) });
    // The checkbox reported checked=true (the DOM toggled), so this call adds; the owner's state decides.
    expect([...untick.selected]).toContain("defiance/src/a.py");
    act(() => {
      copyChip().click();
      terminalChip().click();
    });
    expect(handlers.onCopy).toHaveBeenCalledTimes(1);
    expect(handlers.onTerminal).toHaveBeenCalledTimes(1);
    const area = container.querySelector(".task-text") as HTMLTextAreaElement;
    expect(area.value).toBe("x");
  });

  it("after a failed copy the packet is shown in a read-only text area and selected", () => {
    const packet = "Work folder: defiance\nRoot: /r\n\nTask:\nx\n\nContext:\nnone\n\nConstraints:\nnone\n";
    render({ ...EMPTY_DRAFT, text: "x", fallback: packet });
    const area = container.querySelector(".task-fallback") as HTMLTextAreaElement;
    expect(area).not.toBeNull();
    expect(area.readOnly).toBe(true);
    expect(area.value).toBe(packet);
    expect(text()).toContain("TASK PACKET");
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe(packet.length);
    render({ ...EMPTY_DRAFT, text: "x", fallback: null });
    expect(container.querySelector(".task-fallback")).toBeNull();
  });
});
