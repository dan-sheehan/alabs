/**
 * The one seam between alabs and whatever it is running inside.
 *
 * `Bridge` is the typed transport: a named native operation with arguments,
 * and a named native event. `Host` is the small set of things only the
 * surrounding application can do — pick a folder, exit, and tell alabs that
 * the window or a native shortcut asked for something.
 *
 * A build picks one implementation: Vite resolves `alabs-runtime` to
 * `runtime.desktop.ts` or `runtime.browser.ts` (see `vite.config.ts`), so
 * only the selected one is bundled and the browser build never imports
 * Tauri. Nothing else in the application imports a runtime directly.
 */
import { runtime } from "alabs-runtime";
import type { DraftStore } from "./recovery";

/** The open alabs root: its folder name and canonical absolute path. */
export interface RootInfo {
  name: string;
  path: string;
}

/**
 * What the runtime settles before alabs can show anything.
 *
 * A runtime that owns its root names it here, and that is the only place the
 * root can come from: remembered layout state can never select or replace it.
 */
export interface Bootstrap {
  /** The root this runtime owns, or null when the user chooses one. */
  root: RootInfo | null;
  /**
   * False while this runtime cannot write. The editor opens read-only and
   * the actions that would write refuse with a reason, rather than failing
   * halfway through.
   *
   * This is about the runtime, not about this window: a window that is
   * read-only because another one is editing is `editing`'s business below.
   */
  canEdit: boolean;
  /**
   * What this runtime calls the process alabs is talking to, or null when
   * there is no separate process — the desktop application is the only window
   * there is.
   *
   * A page compares it with the one it saw before to tell "still the same
   * server" from "the server was restarted", which is the difference between
   * an editing role and in-flight work that still stand and ones that are
   * gone. Nothing is admitted by it; the launch credential does that.
   */
  serverId: string | null;
}

/** Who may change files, from the asking window's point of view. */
export interface Writer {
  /** True when this window is the one that may change files. */
  writing: boolean;
  /** The window that holds the role; null while nobody does. */
  holder: string | null;
}

/**
 * Everything editing needs that only the surrounding runtime can provide:
 * somewhere to keep unsaved work, and the rule about who may write.
 *
 * Null when the surrounding application is the only window there is, and
 * owns its own unsaved work — the desktop build. The browser is where a root
 * can be open in two tabs at once and where a buffer can vanish with the tab,
 * so the browser is where both of these exist.
 */
export interface Editing {
  /** This window's name for itself, for as long as it is open. */
  sessionId: string;
  /** Drafts inside the browser: immediate, and gone with the browser's data. */
  browserDrafts: DraftStore;
  /** Drafts in alabs' own state folder: the copy clearing browser data cannot take. */
  diskDrafts: DraftStore;
  /**
   * Ask to be the window that may change files. `takeOver` is the user's
   * explicit takeover; without it another window's role is never disturbed.
   */
  claim(takeOver: boolean): Promise<Writer>;
  /** Give the role up, if this window has it. */
  release(): Promise<Writer>;
}

/** The typed transport to the native side. */
export interface Bridge {
  /** Run one named native operation. Rejects with the reason it refused. */
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /**
   * Subscribe to one named native event. Resolves to the function that
   * unsubscribes; calling it twice is harmless.
   */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

/**
 * What only the surrounding application can do. Each `on…` returns the
 * function that stops listening. A host that cannot raise one of these
 * (the browser has no native menu) returns a handler that never fires,
 * never one that throws.
 */
export interface Host {
  /** What this runtime settles before anything is shown. Read once, at launch. */
  bootstrap(): Promise<Bootstrap>;
  /** Show the folder picker; null when the user cancels. */
  pickFolder(): Promise<string | null>;
  /** Exit. Called only after unsaved edits have been dealt with. */
  quit(): Promise<void>;
  /** The window was asked to close. alabs decides whether it may. */
  onWindowClose(handler: () => void): Promise<() => void>;
  /** The application was asked to quit (the Quit menu item, Command-Q). */
  onQuitRequested(handler: () => void): Promise<() => void>;
  /** File > Close Tab (Command-W): the tab, never the window. */
  onCloseTabRequested(handler: () => void): Promise<() => void>;
  /**
   * True when a native menu owns Command-W and delivers it through
   * `onCloseTabRequested`; the raw key is then swallowed so nothing else
   * acts on it. False when the surrounding application owns the key
   * outright — Chrome closes its own tab — and alabs leaves it alone.
   * Either way alabs never closes a tab from the raw key.
   */
  menuOwnsCloseTab: boolean;
  /** How unsaved work is kept and who may write; null when neither is shared. */
  editing: Editing | null;
}

export interface Runtime {
  bridge: Bridge;
  host: Host;
}

export const bridge: Bridge = runtime.bridge;
export const host: Host = runtime.host;
