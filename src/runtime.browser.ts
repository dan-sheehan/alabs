/**
 * The browser runtime: one alabs page talking to the one `alabs-serve`
 * process that launched it, over loopback HTTP.
 *
 * Three things make a request admissible, and the page can only supply one of
 * them: the launch credential. The other two — this exact origin, and this
 * exact host — are the browser's own doing and cannot be forged by another
 * page. The credential arrives once, in the fragment of the URL the launcher
 * opened, and is taken out of the address bar and out of history immediately.
 *
 * There is no route that takes a command name. Every operation this runtime
 * can perform is named in `ROUTES` below, and the server has a route for each
 * one and for nothing else. An operation the browser cannot do yet is refused
 * here, by name, with what to do instead — never sent and never half-done.
 */
import { failed } from "./callFailure";
import type { Draft, DraftListing, DraftStore } from "./recovery";
import { browserDrafts, noBrowserDrafts } from "./recoveryDb";
import type { Bootstrap, Runtime, Writer } from "./runtime";

/** Where the launcher leaves the credential, and where it is kept afterwards. */
const CREDENTIAL_KEY = "alabs.credential";
const CREDENTIAL_HEADER = "X-Alabs-Credential";
/** 32 bytes as hex, exactly as `serve.rs` writes it. */
const CREDENTIAL_SHAPE = /^#c=([0-9a-f]{64})$/;

/** Where this window's name for itself is kept, and the header that carries it. */
const SESSION_KEY = "alabs.session";
const SESSION_HEADER = "X-Alabs-Session";

/** Each operation alabs can perform in Chrome today, and the route that does it. */
const ROUTES: Readonly<Record<string, string>> = {
  list_dir: "list-dir",
  entry_kind: "entry-kind",
  read_file: "read-file",
  stat_file: "stat-file",
  git_facts: "git-facts",
  git_query: "git-query",
  open_terminal: "open-terminal",
  cancel_search: "cancel-search",
  load_ui_state: "load-ui-state",
  save_ui_state: "save-ui-state",
  append_log: "append-log",
  save_file: "save-file",
  recreate_file: "recreate-file",
  create_file: "create-file",
  create_dir: "create-dir",
  list_local_models: "list-local-models",
  ask_local_model: "ask-local-model",
  generate_local_model_json: "generate-local-model-json",
  collect_inventory: "collect-inventory",
  write_view_files: "write-view-files",
  write_root_view_files: "write-root-view-files",
  view_session: "view-session",
};

/**
 * The one operation whose answer arrives in pieces rather than all at once.
 * It has its own route and its own reader below; everything else is one
 * request and one answer.
 */
const SEARCH_ROUTE = "search-subject";

/**
 * Everything else, and what alabs says instead of failing. A name missing
 * from both tables is a mistake in alabs, not something a user did.
 */
const NOT_YET: Readonly<Record<string, string>> = {
  open_subject:
    "alabs in Chrome works on the one folder it was started with. To work somewhere else, stop it with Control-C and start it again with that path.",
  move_item: "Moving and renaming are not available in Chrome yet. Finder can do it, then Refresh.",
  trash_item: "Delete is not available in Chrome yet. Finder can do it, then Refresh.",
};

/**
 * Take the launch credential out of the address bar and keep it for this tab
 * only. Reloading keeps it; a tab opened by hand at this address has none,
 * and says so rather than half-working.
 */
function claimCredential(): string | null {
  const arrived = CREDENTIAL_SHAPE.exec(location.hash);
  if (arrived) {
    const token = arrived[1];
    try {
      sessionStorage.setItem(CREDENTIAL_KEY, token);
    } catch {
      // Private browsing or blocked storage: this tab still works, a reload
      // does not. Nothing here is worth failing the launch for.
    }
    history.replaceState(null, "", location.pathname + location.search);
    return token;
  }
  try {
    return sessionStorage.getItem(CREDENTIAL_KEY);
  } catch {
    return null;
  }
}

let credential = claimCredential();

/**
 * This window's name for itself.
 *
 * It says which admitted page is asking; it admits nothing. Always fresh
 * for this document: Chrome copies sessionStorage when duplicating a tab or
 * opening a same-origin popup. Reusing that name would create two writers.
 * Pagehide releases the old role on reload; if it never arrives, the user
 * can explicitly take over. Drafts remain keyed by root and file.
 */
function windowName(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const name = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  try {
    sessionStorage.setItem(SESSION_KEY, name);
  } catch {
    // Nothing to do: this window is simply new again after a reload.
  }
  return name;
}

const sessionId = windowName();

/**
 * A launcher opening its address in a tab that is already on it changes only
 * the fragment, and a fragment-only navigation reloads nothing: this module
 * would never run again and the page would keep talking to the process that
 * has stopped. A credential that is not the one in hand means a new launch,
 * so alabs takes it and starts over.
 */
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    const arrived = CREDENTIAL_SHAPE.exec(location.hash);
    if (arrived === null) return;
    const clean = location.pathname + location.search;
    if (arrived[1] === credential) {
      history.replaceState(null, "", clean);
      return;
    }
    credential = arrived[1];
    try {
      sessionStorage.setItem(CREDENTIAL_KEY, arrived[1]);
    } catch {
      // The reload below still starts this tab against the new process.
    }
    location.replace(clean);
  });
}

const NO_CREDENTIAL =
  "This page was not opened by alabs. Start alabs with `npm run browser -- <path>` and use the address it prints.";

/**
 * A request that left and was never answered.
 *
 * This is not the same as a refusal. A refusal is the server saying no, and
 * alabs knows nothing happened. This is silence, and a save that ends in
 * silence may have been written in full. It is marked so that nothing up the
 * chain quietly tries again: what actually happened has to be read back off
 * the disk first.
 */
function unanswered(): Error {
  return failed("uncertain", "alabs is not answering. Its terminal window may have been closed.");
}

/**
 * One operation, as one same-origin POST. Rejects with the reason it refused.
 *
 * `keepalive` is for the one request alabs makes as the page is going away —
 * giving up editing — which the browser would otherwise cancel with the page.
 */
async function request(route: string, args: Record<string, unknown>, keepalive = false): Promise<Response> {
  if (credential === null) throw new Error(NO_CREDENTIAL);
  let response: Response;
  try {
    response = await fetch(`/api/v1/${route}`, {
      method: "POST",
      mode: "same-origin",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      keepalive,
      headers: {
        "Content-Type": "application/json",
        [CREDENTIAL_HEADER]: credential,
        [SESSION_HEADER]: sessionId,
      },
      body: JSON.stringify(args),
    });
  } catch {
    // The process is gone, or the machine went to sleep with the page open.
    throw unanswered();
  }
  // The request reached the server and the server ran out of time answering
  // it. Whatever it was doing may well have finished.
  if (response.status === 408) throw unanswered();
  if (!response.ok) {
    const reason = await response
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : null,
      )
      .catch(() => null);
    const said = reason ?? `alabs refused this (${response.status}).`;
    // 409 is the one refusal that is about this window rather than about what
    // it asked for: another window holds the editing role. The page turns
    // that back into being read-only rather than showing it as a failure.
    if (response.status === 409) throw failed("not-writing", said);
    throw new Error(said);
  }
  return response;
}

/** One operation, as one same-origin POST, with the one answer it returns. */
async function call<T>(route: string, args: Record<string, unknown>, keepalive = false): Promise<T> {
  const response = await request(route, args, keepalive);
  try {
    return await response.json() as T;
  } catch {
    // Receiving headers does not confirm the operation: its answer can be
    // lost while reading the body, after a write has already committed.
    throw unanswered();
  }
}

// ---------------------------------------------------------------------------
// Search: the one answer that arrives in pieces.
//
// The desktop pushes hits to the window as native events while the walk runs.
// Here they come down the body of the one request that started the walk, a
// JSON object per line, and the summary is the last line. The page subscribes
// exactly as it does on the desktop, so `Search.tsx` cannot tell the two
// apart — including that a batch of a search it has replaced is dropped on
// its `search_id`.
// ---------------------------------------------------------------------------

type SearchBatch = { search_id: number; results: unknown[] };

/** Everyone listening for hits right now. The same shape as a native listener. */
const searchListeners = new Set<(batch: SearchBatch) => void>();

function toListeners(batch: SearchBatch): void {
  // A copy, so a listener that unsubscribes while being called cannot change
  // the set being walked.
  for (const listener of [...searchListeners]) listener(batch);
}

/** One line of the streamed answer, as `serve.rs` writes it. */
type SearchLine =
  | { kind: "batch"; search_id: number; results: unknown[] }
  | { kind: "summary"; summary: unknown };

/**
 * Run one search and read its answer as it arrives. Hits go to the listeners
 * the moment their batch lands; the promise settles on the summary, which is
 * the last line the server writes.
 *
 * A stream that ends without a summary is silence, not an empty result: the
 * process went away mid-walk, and saying "no matches" would be a lie.
 */
async function searchStream(args: Record<string, unknown>): Promise<unknown> {
  const response = await request(SEARCH_ROUTE, args);
  const body = response.body;
  if (body === null) throw unanswered();
  const reader = body.getReader();
  const decode = new TextDecoder();
  let pending = "";
  let summary: unknown = null;
  const take = (line: string) => {
    if (line.trim() === "") return;
    const parsed = JSON.parse(line) as SearchLine;
    if (parsed.kind === "batch") toListeners({ search_id: parsed.search_id, results: parsed.results });
    else if (parsed.kind === "summary") summary = parsed.summary;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decode.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) take(line);
    }
  } catch {
    // The connection died part-way through the answer.
    throw unanswered();
  }
  take(pending);
  if (summary === null) throw unanswered();
  return summary;
}

/**
 * Drafts kept in alabs' own state folder, through the server.
 *
 * The durable half: this is what survives clearing the browser's data, and
 * what the user can open in Finder if alabs itself will not start.
 */
const diskDrafts: DraftStore = {
  put: (draft: Draft) =>
    call<{ revision: number }>("recovery-put", {
      relPath: draft.relPath,
      stamp: draft.stamp,
      revision: draft.revision,
      contents: draft.contents,
    }).then(() => {}),
  // The root is the one this process owns, so the server fills it in; it is
  // not something the page may choose.
  list: (_root: string) => call<DraftListing>("recovery-list", {}),
  drop: (_root: string, relPath: string, revision: number) =>
    call<boolean>("recovery-drop", { relPath, revision }).then(() => {}),
};

/**
 * Drafts inside this browser profile. Opened lazily, because a profile that
 * will not give alabs any storage must not stop the page from loading — it
 * must make the failure visible instead.
 */
function openBrowserDrafts(): DraftStore {
  try {
    return browserDrafts();
  } catch (err) {
    return noBrowserDrafts(`this browser will not keep drafts for alabs: ${String(err)}`);
  }
}

export const runtime: Runtime = {
  bridge: {
    invoke: (command, args) => {
      if (command === "search_subject") return searchStream(args ?? {}) as Promise<never>;
      const route = ROUTES[command];
      if (route !== undefined) return call(route, args ?? {});
      const reason = NOT_YET[command];
      return Promise.reject(new Error(reason ?? `alabs cannot do "${command}" in Chrome.`));
    },
    // Search is the one thing the server has more than one answer for, and it
    // sends them down the request that asked. Every other event the desktop
    // raises has no counterpart here, and a caller still gets a real
    // unsubscribe, so its cleanup path is the same one the desktop takes.
    listen: async (event, handler) => {
      if (event !== "search-results") return () => {};
      const listener = handler as (batch: SearchBatch) => void;
      searchListeners.add(listener);
      return () => searchListeners.delete(listener);
    },
  },
  host: {
    bootstrap: () => call<Bootstrap>("bootstrap", {}),
    // One process owns one root, so there is nothing to pick.
    pickFolder: () => Promise.reject(new Error(NOT_YET.open_subject)),
    // Chrome owns this window. The process it belongs to is stopped with
    // Control-C in the terminal that started it.
    quit: () => Promise.reject(new Error("Closing alabs is Control-C in the terminal that started it.")),
    // Chrome owns its own window and shortcuts, so none of these ever fire.
    onWindowClose: async () => () => {},
    onQuitRequested: async () => () => {},
    onCloseTabRequested: async () => () => {},
    // Command-W closes the Chrome tab. alabs cannot take that key and does
    // not try to; the tab strip's own close control is how an editor tab is
    // closed here.
    menuOwnsCloseTab: false,
    editing: {
      sessionId,
      browserDrafts: openBrowserDrafts(),
      diskDrafts,
      claim: (takeOver: boolean) => call<Writer>("claim-writing", { takeOver }),
      // Sent with `keepalive`, because the moment this matters most is the
      // one where the page is closing: a window that goes without saying so
      // would leave the next one read-only for no reason.
      release: () => call<Writer>("release-writing", {}, true),
    },
  },
};
