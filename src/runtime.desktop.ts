/**
 * The desktop runtime: Tauri. Selected by `vite.config.ts` for the default
 * build and for `tauri dev`/`tauri build`. This file is the only place in
 * the frontend that imports `@tauri-apps`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type { Runtime } from "./runtime";

export const runtime: Runtime = {
  bridge: {
    invoke: (command, args) => invoke(command, args),
    listen: (event, handler) => listen(event, (e) => handler(e.payload as never)),
  },
  host: {
    // The desktop user chooses the root and may change it, and the desktop
    // build has always been able to write. There is no separate process to
    // name: this application is it.
    bootstrap: async () => ({ root: null, canEdit: true, serverId: null }),
    // Dialog only: nothing in Rust changes and nothing is opened or read.
    pickFolder: async () => {
      const path = await open({ directory: true, multiple: false });
      return typeof path === "string" ? path : null;
    },
    quit: () => invoke("quit"),
    // The window never closes itself: the close is refused here and alabs
    // decides, after the unsaved-edits guard, whether to exit.
    onWindowClose: (handler) =>
      getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        handler();
      }),
    onQuitRequested: (handler) => listen("quit-requested", () => handler()),
    onCloseTabRequested: (handler) => listen("close-tab-requested", () => handler()),
    menuOwnsCloseTab: true,
    // One window, which owns its own unsaved work: there is no role to share
    // and nowhere a buffer can go that the application does not go with it.
    // Recovery drafts are the browser runtime's answer to a problem the
    // desktop application does not have.
    editing: null,
  },
};
