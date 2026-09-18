// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The browser runtime's two promises, checked here rather than only in
 * Chrome: the launch credential is handled the way `browser-building.md`
 * section 3 requires, and there is no way to reach an operation this build
 * does not list — including anything that would change the open root.
 */

const CREDENTIAL = "a1b2c3d4".repeat(8);

/** Load the module fresh, as a page load would, at `hash`. */
async function load(hash: string) {
  vi.resetModules();
  window.history.replaceState(null, "", `/${hash}`);
  return (await import("./runtime.browser")).runtime;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fetchMock = vi.fn(async () => new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("the launch credential", () => {
  it("is taken from the fragment, kept only in session storage, and removed from the address at once", async () => {
    await load(`#c=${CREDENTIAL}`);
    // Out of the address bar before anything else can read it, and without
    // adding a history entry that still holds it.
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(CREDENTIAL);
    expect(sessionStorage.getItem("alabs.credential")).toBe(CREDENTIAL);
    // Session storage and nowhere else: not local storage, not a cookie.
    expect(localStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    // The window's own name is kept beside it. It is not a second credential:
    // it says which page is asking, and admits nothing.
    expect(Object.keys(sessionStorage).sort()).toEqual(["alabs.credential", "alabs.session"]);
    expect(sessionStorage.getItem("alabs.session")).not.toBe(CREDENTIAL);
    expect(sessionStorage.getItem("alabs.session")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("survives a reload of the same tab", async () => {
    await load(`#c=${CREDENTIAL}`);
    const again = await load("");
    await again.bridge.invoke("list_dir", { relPath: "" });
    expect(sent().headers["X-Alabs-Credential"]).toBe(CREDENTIAL);
  });

  it("is required: a tab that never had one says so and sends nothing", async () => {
    const runtime = await load("");
    await expect(runtime.bridge.invoke("list_dir", { relPath: "" })).rejects.toThrow(/was not opened by alabs/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a malformed fragment is not taken as a credential", async () => {
    for (const bad of ["#c=short", "#c=" + "z".repeat(64), "#" + CREDENTIAL, `#c=${CREDENTIAL}&x=1`]) {
      const runtime = await load(bad);
      expect(sessionStorage.getItem("alabs.credential")).toBeNull();
      await expect(runtime.bridge.invoke("list_dir", { relPath: "" })).rejects.toThrow(/was not opened by alabs/);
    }
  });

  it("a new launch's credential replaces the old one and starts the tab over", async () => {
    await load(`#c=${CREDENTIAL}`);
    const next = "f".repeat(64);
    const replace = vi.fn();
    // A second `npm run browser` opens its address in this tab. Only the
    // fragment changes, so nothing reloads on its own and this module would
    // otherwise keep talking to the process that has stopped.
    const real = Object.getOwnPropertyDescriptor(window, "location")!;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, hash: `#c=${next}`, pathname: "/", search: "", replace },
    });
    try {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      expect(sessionStorage.getItem("alabs.credential")).toBe(next);
      expect(replace).toHaveBeenCalledWith("/");
    } finally {
      Object.defineProperty(window, "location", real);
    }
  });
});

/** The one fetch the runtime made: its path, method and headers. */
function sent() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { path, init, headers: init.headers as Record<string, string> };
}

describe("what the browser can reach", () => {
  /** Every command `subject.ts` can send, from the wire contract in `runtime.test.ts`. */
  const ROUTED = [
    ["list_dir", "list-dir"],
    ["entry_kind", "entry-kind"],
    ["read_file", "read-file"],
    ["stat_file", "stat-file"],
    ["git_facts", "git-facts"],
    ["git_query", "git-query"],
    ["open_terminal", "open-terminal"],
    ["cancel_search", "cancel-search"],
    ["load_ui_state", "load-ui-state"],
    ["save_ui_state", "save-ui-state"],
    ["append_log", "append-log"],
    ["save_file", "save-file"],
    ["recreate_file", "recreate-file"],
    ["create_file", "create-file"],
    ["create_dir", "create-dir"],
    ["list_local_models", "list-local-models"],
    ["ask_local_model", "ask-local-model"],
    ["generate_local_model_json", "generate-local-model-json"],
    ["collect_inventory", "collect-inventory"],
    ["write_view_files", "write-view-files"],
    ["write_root_view_files", "write-root-view-files"],
    ["view_session", "view-session"],
  ] as const;

  /** The one command whose answer arrives in pieces; checked on its own below. */
  const STREAMED = ["search_subject"] as const;

  const REFUSED = [
    "open_subject",
    "move_item",
    "trash_item",
  ] as const;

  it.each(ROUTED)("%s goes to one named same-origin route", async (command, route) => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    await runtime.bridge.invoke(command, { relPath: "a" });
    const { path, init, headers } = sent();
    // A relative path, so the request can only ever be same-origin.
    expect(path).toBe(`/api/v1/${route}`);
    expect(init.method).toBe("POST");
    expect(init.mode).toBe("same-origin");
    expect(init.credentials).toBe("omit");
    expect(headers["X-Alabs-Credential"]).toBe(CREDENTIAL);
  });

  it.each(REFUSED)("%s is refused by name and never sent", async (command) => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    await expect(runtime.bridge.invoke(command, {})).rejects.toThrow(/not available in Chrome yet|one folder it was started with/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names every command the application can send: none falls through to a generic message", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    const named = new Set<string>([...ROUTED.map(([c]) => c), ...STREAMED, ...REFUSED]);
    // A command alabs does not know is a mistake in alabs, and says so
    // differently from one that is simply not available yet.
    await expect(runtime.bridge.invoke("made_up", {})).rejects.toThrow(/cannot do "made_up"/);
    expect(named.size).toBe(ROUTED.length + STREAMED.length + REFUSED.length);
  });
});

describe("the root and the window belong to the host", () => {
  it("there is no way to choose or change the root while this process runs", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    // Both doors: the picker, and the operation that would replace the handle.
    await expect(runtime.host.pickFolder()).rejects.toThrow(/one folder it was started with/);
    await expect(runtime.bridge.invoke("open_subject", { path: "/somewhere" })).rejects.toThrow(
      /one folder it was started with/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the root comes from bootstrap and from nowhere else", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ root: { name: "served", path: "/served" }, canEdit: true, serverId: "abc123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await runtime.host.bootstrap()).toEqual({
      root: { name: "served", path: "/served" },
      canEdit: true,
      serverId: "abc123",
    });
    expect(sent().path).toBe("/api/v1/bootstrap");
  });

  it("Chrome owns its own window and shortcuts", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    expect(runtime.host.menuOwnsCloseTab).toBe(false);
    for (const on of [runtime.host.onWindowClose, runtime.host.onQuitRequested, runtime.host.onCloseTabRequested]) {
      const handler = vi.fn();
      const off = await on(handler);
      off();
      expect(handler).not.toHaveBeenCalled();
    }
    await expect(runtime.host.quit()).rejects.toThrow(/Control-C/);
  });
});

describe("a refusal from the server arrives as its reason", () => {
  it("carries the server's own words, not a status code", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "path is outside the subject: ../.." }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(runtime.bridge.invoke("read_file", { relPath: "../.." })).rejects.toThrow("path is outside the subject: ../..");
  });

  it("a process that has stopped answering says that, rather than a network word", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(runtime.bridge.invoke("read_file", { relPath: "a" })).rejects.toThrow(/alabs is not answering/);
  });
});

describe("which window is asking, and who may write", () => {
  it("every request says which window it came from, and the name is not the credential", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    await runtime.bridge.invoke("list_dir", { relPath: "" });
    const name = sent().headers["X-Alabs-Session"];
    expect(name).toMatch(/^[0-9a-f]{16}$/);
    expect(name).not.toBe(CREDENTIAL);
  });

  it("each document has a fresh identity even when Chrome copies session storage", async () => {
    await load(`#c=${CREDENTIAL}`);
    const first = sessionStorage.getItem("alabs.session");
    // Reloads and copied tabs both run over existing session storage.
    await load("");
    expect(sessionStorage.getItem("alabs.session")).not.toBe(first);
    // A new tab starts with session storage of its own.
    sessionStorage.clear();
    await load(`#c=${CREDENTIAL}`);
    expect(sessionStorage.getItem("alabs.session")).not.toBe(first);
  });

  it("asking for the editing role is one named route, and a takeover is explicit", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    const editing = runtime.host.editing!;
    expect(editing.sessionId).toBe(sessionStorage.getItem("alabs.session"));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ writing: false, holder: "other" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await editing.claim(false)).toEqual({ writing: false, holder: "other" });
    const { path, init } = sent();
    expect(path).toBe("/api/v1/claim-writing");
    expect(JSON.parse(String(init.body))).toEqual({ takeOver: false });
  });
});

describe("a result alabs does not know", () => {
  /** The marker `callFailure.ts` sets, read the way the application reads it. */
  async function kindOf(run: () => Promise<unknown>) {
    const { callFailure } = await import("./callFailure");
    try {
      await run();
      return "no failure";
    } catch (err) {
      return callFailure(err);
    }
  }

  it("a request that is never answered is uncertain, not a refusal", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    // A save that ends in silence may have been written in full, so it is
    // marked as such and nothing up the chain may simply try it again.
    expect(await kindOf(() => runtime.bridge.invoke("save_file", { relPath: "a" }))).toBe("uncertain");
  });

  it("a request the server ran out of time answering is uncertain too", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 408 }));
    expect(await kindOf(() => runtime.bridge.invoke("save_file", { relPath: "a" }))).toBe("uncertain");
  });

  it("a successful response whose body is lost is uncertain and never retried", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("connection lost after headers"));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
    expect(await kindOf(() => runtime.bridge.invoke("save_file", { relPath: "a" }))).toBe("uncertain");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an ordinary refusal is certain: it says no, and nothing happened", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "a.md changed on disk since it was opened; save refused" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await kindOf(() => runtime.bridge.invoke("save_file", { relPath: "a" }))).toBeNull();
  });

  it("being refused because another window is editing is its own kind", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "another alabs window is editing this root." }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await kindOf(() => runtime.bridge.invoke("save_file", { relPath: "a" }))).toBe("not-writing");
  });
});

describe("drafts on the disk go through the server", () => {
  it("keeping a draft names the file, never the root: the process owns that", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ revision: 3 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await runtime.host.editing!.diskDrafts.put({
      root: "/somewhere/else",
      relPath: "notes.md",
      stamp: null,
      contents: "unsaved",
      revision: 3,
      serverId: "abc",
      sessionId: "tab",
      updatedAt: 1,
    });
    const { path, init } = sent();
    expect(path).toBe("/api/v1/recovery-put");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ relPath: "notes.md", stamp: null, revision: 3, contents: "unsaved" });
    expect(JSON.stringify(body)).not.toContain("/somewhere/else");
  });

  it("forgetting a draft names the revision that was dealt with", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    fetchMock.mockResolvedValueOnce(
      new Response("true", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await runtime.host.editing!.diskDrafts.drop("/root", "notes.md", 7);
    const { path, init } = sent();
    expect(path).toBe("/api/v1/recovery-drop");
    expect(JSON.parse(String(init.body))).toEqual({ relPath: "notes.md", revision: 7 });
  });
});

describe("a search, whose answer arrives in pieces", () => {
  /** A response body that hands over `lines` one chunk at a time, as the server does. */
  function streamed(lines: string[]): Response {
    const encode = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encode.encode(line));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }

  const hit = { name: "a.md", rel_path: "p/a.md", line: 3, text: "match" };

  it("hits reach the listeners as they land, and the summary ends the call", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    fetchMock.mockResolvedValueOnce(
      streamed([
        JSON.stringify({ kind: "batch", search_id: 4, results: [hit] }) + "\n",
        // A batch split across two chunks: a line is only a line once it ends.
        '{"kind":"batch","search_id":4,"resu',
        'lts":[]}\n' + JSON.stringify({ kind: "summary", summary: { files: 2, results: 1, truncated: false, cancelled: false } }) + "\n",
      ]),
    );
    const batches: unknown[] = [];
    const off = await runtime.bridge.listen("search-results", (b) => batches.push(b));
    const summary = await runtime.bridge.invoke("search_subject", { query: "m", searchId: 4, scope: "p" });
    expect(summary).toEqual({ files: 2, results: 1, truncated: false, cancelled: false });
    expect(batches).toEqual([
      { search_id: 4, results: [hit] },
      { search_id: 4, results: [] },
    ]);
    expect(sent().path).toBe("/api/v1/search-subject");

    // Unsubscribing really stops it: a later search reaches nobody.
    off();
    fetchMock.mockResolvedValueOnce(
      streamed([JSON.stringify({ kind: "batch", search_id: 5, results: [hit] }) + "\n", JSON.stringify({ kind: "summary", summary: { files: 0, results: 0, truncated: false, cancelled: true } }) + "\n"]),
    );
    await runtime.bridge.invoke("search_subject", { query: "m", searchId: 5, scope: "p" });
    expect(batches).toHaveLength(2);
  });

  it("an answer that stops half way is silence, not an empty result", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    // The process went away mid-walk. Saying "no matches" would be a lie, and
    // the page has to be told that alabs stopped answering.
    fetchMock.mockResolvedValueOnce(streamed([JSON.stringify({ kind: "batch", search_id: 1, results: [hit] }) + "\n"]));
    await expect(runtime.bridge.invoke("search_subject", { query: "m", searchId: 1, scope: "p" })).rejects.toThrow(
      /alabs is not answering/,
    );
  });

  it("a refusal is still a refusal: nothing is streamed and the reason is the server's", async () => {
    const runtime = await load(`#c=${CREDENTIAL}`);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid scope: ../.." }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(runtime.bridge.invoke("search_subject", { query: "m", searchId: 1, scope: "../.." })).rejects.toThrow(
      "invalid scope: ../..",
    );
  });
});
