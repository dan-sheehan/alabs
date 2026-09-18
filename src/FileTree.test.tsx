// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileTree } from "./FileTree";
import { listDir } from "./subject";

vi.mock("./subject", () => ({ listDir: vi.fn(), cancelSearch: vi.fn(), onSearchResults: vi.fn(), nextSearchId: vi.fn(), searchScope: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const handlers = { onOpenFile: vi.fn(), onOpenResult: vi.fn(), onSelectDir: vi.fn(), onRename: vi.fn(), onMove: vi.fn(), onDelete: vi.fn(), onNewFile: vi.fn(), onNewFolder: vi.fn(), onRefresh: vi.fn() };
function Tree(props: Partial<ComponentProps<typeof FileTree>>) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const [searching, onSearching] = useState(false);
  return <FileTree prefix="thinking" placeName="thinking" activePath="thinking/a.txt" dirtyPaths={new Set(["thinking/a.txt"])} selectedDir="thinking" expanded={expanded} onToggleDir={(path) => setExpanded(expanded.has(path) ? new Set() : new Set([path]))} refresh={{}} reload={0} locked={false} missing={false} searching={searching} onSearching={onSearching} searchFocus={0} {...handlers} {...props} />;
}
const render = async (props: Partial<ComponentProps<typeof FileTree>> = {}) => { await act(async () => root.render(<Tree {...props} />)); };
const button = (title: string) => container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
const click = (el: HTMLElement) => act(() => el.click());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listDir).mockImplementation(async (path) => path === "thinking" ? [{ name: "folder", rel_path: "thinking/folder", is_dir: true }, { name: "a.txt", rel_path: "thinking/a.txt", is_dir: false }] : [{ name: "child.txt", rel_path: "thinking/folder/child.txt", is_dir: false }]);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("uses focusable native activation buttons and separate named actions, retaining selection and dirty state", async () => {
  await render();
  const file = button("thinking/a.txt");
  file.focus(); expect(document.activeElement).toBe(file);
  expect(file.tabIndex).toBe(0);
  click(file); expect(handlers.onOpenFile).toHaveBeenCalledExactlyOnceWith("thinking/a.txt");
  expect(file.closest(".tree-active")).not.toBeNull();
  expect(file.querySelector(".dirty-mark")).not.toBeNull();
  for (const [label, handler] of [["rename a.txt", handlers.onRename], ["move a.txt", handlers.onMove], ["Move a.txt to Trash", handlers.onDelete]] as const) {
    const action = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    action.focus(); expect(document.activeElement).toBe(action); click(action);
    expect(handler).toHaveBeenCalledTimes(1);
  }
  expect(handlers.onOpenFile).toHaveBeenCalledTimes(1);
  click(file.parentElement!);
  expect(handlers.onOpenFile).toHaveBeenCalledTimes(2);
});
it("expands and collapses a folder without letting its actions toggle it", async () => {
  await render();
  const folder = button("thinking/folder"); click(folder); await act(async () => {});
  expect(folder.getAttribute("aria-expanded")).toBe("true");
  click(container.querySelector<HTMLButtonElement>('[aria-label="rename folder"]')!);
  expect(folder.getAttribute("aria-expanded")).toBe("true");
  click(folder);
  expect(folder.getAttribute("aria-expanded")).toBe("false");
  expect(button("thinking/folder/child.txt").closest("[hidden]")).not.toBeNull();
});
it("Escape returns focus to Search and hidden tree targets stay hidden during search", async () => {
  await render();
  const search = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Search")!;
  click(search);
  expect(button("thinking/a.txt").closest("[hidden]")).not.toBeNull();
  const input = container.querySelector("input")!;
  expect(document.activeElement).toBe(input);
  const globalEscape = vi.fn();
  window.addEventListener("keydown", globalEscape);
  try {
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(globalEscape).not.toHaveBeenCalled();
  } finally { window.removeEventListener("keydown", globalEscape); }
  expect(document.activeElement).toBe(search);
  expect(container.querySelector("input")).toBeNull();
  expect(button("thinking/a.txt").closest("[hidden]")).toBeNull();
});
it("disables actions while locked and removes missing scope targets from display", async () => {
  await render({ locked: true });
  for (const b of container.querySelectorAll<HTMLButtonElement>("button:not(.sidebar-header)")) expect(b.disabled).toBe(true);
  click(button("thinking/a.txt")); expect(handlers.onOpenFile).not.toHaveBeenCalled();
  await render({ missing: true });
  expect(button("thinking/a.txt").closest("[hidden]")).not.toBeNull();
  expect(button("New File").disabled).toBe(true);
  expect(button("Refresh from disk").disabled).toBe(false);
});

it("reveals a complete Unicode title and path by focusable disclosure, including Search and missing scopes", async () => {
  const title = "長い名前-thinking-with-a-complete-title";
  await render({ placeName: title, prefix: "parent/" + title });
  const disclosure = container.querySelector<HTMLButtonElement>(".sidebar-identity button")!;
  disclosure.focus(); expect(document.activeElement).toBe(disclosure);
  expect(disclosure.title).toBe("parent/" + title);
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  click(disclosure);
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector(".sidebar-full-title")?.textContent).toContain("parent/" + title);
  await render({ placeName: title, searching: true });
  expect(disclosure.textContent).toContain("SEARCH IN");
  expect(container.querySelector('[title="New File"]')).toBeNull();
  await render({ placeName: title, missing: true, locked: true });
  expect(disclosure.disabled).toBe(false);
  click(disclosure); expect(container.querySelector(".sidebar-full-title")).toBeNull();
});
