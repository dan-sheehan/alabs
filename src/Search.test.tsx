// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { FileTree } from "./FileTree";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Search } from "./Search";
import { cancelSearch, nextSearchId, onSearchResults, searchScope, type SearchSummary } from "./subject";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("./subject", () => ({ listDir: vi.fn(async () => []), cancelSearch: vi.fn(async () => {}), nextSearchId: vi.fn(), onSearchResults: vi.fn(), searchScope: vi.fn() }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
let seq = 0;
const close = vi.fn();
const openResult = vi.fn();
const summary: SearchSummary = { files: 1, results: 1, truncated: false, cancelled: false };
const pending = new Map<number, ReturnType<typeof deferred<SearchSummary>>>();
const unsub = vi.fn();
const text = () => container.textContent ?? "";
const settle = () => act(async () => {});
function render(prefix = "one") {
  act(() => root.render(<Search prefix={prefix} placeName={prefix} focusToken={0} onClose={close} onOpenResult={openResult} />));
}
function type(value: string) {
  act(() => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit(value: string) {
  type(value);
  act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settle();
  return seq;
}
function hit(id: number, path: string) {
  act(() => {
    for (const [handler] of vi.mocked(onSearchResults).mock.calls) handler({ search_id: id, results: [{ rel_path: path, name: path, line: 3, text: "fixture match" }] });
  });
}
beforeEach(() => {
  vi.clearAllMocks(); seq = 0; pending.clear();
  vi.mocked(nextSearchId).mockImplementation(() => ++seq);
  vi.mocked(onSearchResults).mockResolvedValue(unsub);
  vi.mocked(searchScope).mockImplementation((_q, id) => {
    const request = deferred<SearchSummary>(); pending.set(id, request); return request.promise;
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("waits for the event listener before starting a search and receiving its first batch", async () => {
  const ready = deferred<() => void>();
  vi.mocked(onSearchResults).mockReturnValue(ready.promise);
  render(); await submit("first");
  expect(searchScope).not.toHaveBeenCalled();
  await act(async () => ready.resolve(unsub));
  expect(searchScope).toHaveBeenCalledTimes(1);
  hit(seq, "one/first.txt");
  expect(text()).toContain("first.txt");
});
it("unmount cancels only its own request and unsubscribes", async () => {
  render(); const id = await submit("first");
  act(() => root.render(null)); await settle();
  expect(cancelSearch).toHaveBeenCalledWith(id);
  expect(unsub).toHaveBeenCalledTimes(1);
});
it("an old error or summary and batches cannot change the newer request", async () => {
  render(); const first = await submit("first"); const second = await submit("second");
  hit(first, "one/old.txt"); hit(second, "one/new.txt");
  await act(async () => pending.get(first)!.reject("old failure"));
  expect(text()).toContain("Searching…"); expect(text()).not.toContain("old");
  await act(async () => pending.get(second)!.resolve(summary));
  expect(text()).toContain("1 match"); expect(text()).toContain("new.txt");
  const third = await submit("third"); const fourth = await submit("fourth");
  await act(async () => pending.get(third)!.resolve(summary));
  expect(text()).toContain("Searching…");
  await act(async () => pending.get(fourth)!.reject("current failure"));
  expect(text()).toContain("current failure"); expect(text()).not.toContain("new.txt");
});
it("scope change drops results and blocks late events/completion from the previous scope", async () => {
  render(); const id = await submit("first"); hit(id, "one/old.txt");
  render("two"); hit(id, "one/late.txt");
  await act(async () => pending.get(id)!.resolve(summary));
  expect(text()).not.toContain("old.txt"); expect(text()).not.toContain("late.txt");
  expect(cancelSearch).toHaveBeenCalledWith(id);
});
it("Escape clears, cancels its own request, and never resurrects late results", async () => {
  render(); const id = await submit("first");
  act(() => container.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  hit(id, "one/late.txt"); await act(async () => pending.get(id)!.resolve(summary));
  expect(close).toHaveBeenCalledTimes(1); expect(cancelSearch).toHaveBeenCalledWith(id);
  expect(text()).not.toContain("late"); expect(text()).not.toContain("Searching");
});
it("a delayed listener cannot start an abandoned request", async () => {
  const ready = deferred<() => void>(); vi.mocked(onSearchResults).mockReturnValue(ready.promise);
  render(); await submit("first"); act(() => root.render(null));
  await act(async () => ready.resolve(unsub));
  expect(searchScope).not.toHaveBeenCalled(); expect(unsub).toHaveBeenCalledTimes(1);
});
it("listener failure is a visible current-request error without a disk walk", async () => {
  render(); vi.mocked(onSearchResults).mockRejectedValue(new Error("listener unavailable"));
  await submit("first"); expect(text()).toContain("listener unavailable"); expect(searchScope).not.toHaveBeenCalled();
});
it("typing does not search until Enter; emptying the input stops the current search", async () => {
  render(); type("draft"); expect(searchScope).not.toHaveBeenCalled();
  const id = await submit("first"); type("edited"); expect(searchScope).toHaveBeenCalledTimes(1);
  type(""); hit(id, "one/late.txt");
  expect(cancelSearch).toHaveBeenCalledWith(id); expect(text()).not.toContain("late.txt");
});


it("root teardown cannot resurrect a same-named place in the next root", async () => {
  render(); const old = await submit("old");
  act(() => root.render(null)); render(); const fresh = await submit("fresh");
  hit(old, "one/old.txt"); hit(fresh, "one/fresh.txt");
  await act(async () => pending.get(old)!.reject("old-root failure"));
  expect(text()).toContain("Searching…"); expect(text()).toContain("fresh.txt"); expect(text()).not.toContain("old");
});
it("out-of-order subscription success and failure cannot start or fail the newer request", async () => {
  const first = deferred<() => void>(); const second = deferred<() => void>();
  vi.mocked(onSearchResults).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render(); await submit("first"); const id = await submit("second");
  await act(async () => second.resolve(unsub));
  await act(async () => first.reject("old-listener failure"));
  expect(searchScope).toHaveBeenCalledTimes(1); expect(searchScope).toHaveBeenCalledWith("second", id, "one");
  expect(text()).toContain("Searching…"); expect(text()).not.toContain("failure");
});


it("FileTree's Search toggle disposes the walk as well as its result listener", async () => {
  const props: ComponentProps<typeof FileTree> = {
    prefix: "one", placeName: "one", activePath: null, dirtyPaths: new Set(),
    expanded: new Set(), selectedDir: "one", refresh: {}, reload: 0,
    locked: false, missing: false, searching: true, searchFocus: 0,
    onSearching: (searching) => { props.searching = searching; root.render(<FileTree {...props} />); },
    onRefresh: vi.fn(), onOpenFile: vi.fn(), onOpenResult: vi.fn(), onSelectDir: vi.fn(),
    onToggleDir: vi.fn(), onNewFile: vi.fn(), onNewFolder: vi.fn(), onRename: vi.fn(), onMove: vi.fn(), onDelete: vi.fn(),
  };
  await act(async () => root.render(<FileTree {...props} />));
  const id = await submit("first");
  act(() => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Search")!.click());
  expect(cancelSearch).toHaveBeenCalledWith(id); expect(unsub).toHaveBeenCalledTimes(1);
  hit(id, "one/late.txt"); await act(async () => pending.get(id)!.resolve(summary));
  expect(container.querySelector(".search")).toBeNull(); expect(text()).not.toContain("late.txt");
});

it("exposes a focusable result button that opens its recorded line", async () => {
  render(); const id = await submit("needle"); hit(id, "one/result.txt");
  const result = container.querySelector<HTMLButtonElement>("button.search-hit")!;
  result.focus(); expect(document.activeElement).toBe(result);
  expect(result.type).toBe("button"); expect(result.tabIndex).toBe(0);
  act(() => result.click());
  expect(openResult).toHaveBeenCalledExactlyOnceWith("one/result.txt", 3);
  expect(searchScope).toHaveBeenCalledTimes(1);
});

it("locks the input and results without discarding the request or swallowing ordinary keys", async () => {
  render(); const id = await submit("needle"); hit(id, "one/result.txt");
  act(() => root.render(<Search prefix="one" placeName="one" focusToken={0} locked onClose={close} onOpenResult={openResult} />));
  expect(container.querySelector("input")!.disabled).toBe(true);
  const result = container.querySelector<HTMLButtonElement>("button.search-hit")!;
  expect(result.disabled).toBe(true); act(() => result.click());
  expect(openResult).not.toHaveBeenCalled(); expect(cancelSearch).not.toHaveBeenCalled();
  render();
  const event = new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
  act(() => container.querySelector("input")!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
});
