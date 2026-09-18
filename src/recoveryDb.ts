/**
 * The browser half of recovery: drafts in IndexedDB, through Dexie.
 *
 * This is the storage alabs can reach without leaving the page, so it is the
 * one that answers first after a keystroke. It is *not* the durable copy:
 * everything here lives inside one browser profile and goes when that
 * profile's data is cleared. `serve.rs` keeps the copy that does not.
 *
 * Dexie is used for one thing — transactions and schema upgrades over
 * IndexedDB — and nothing else. No Cloud, no synchronisation, no account
 * layer, no React binding. It is imported only from here, and this file is
 * reached only from `runtime.browser.ts`, so the desktop build never bundles
 * it.
 *
 * Every write is one read-modify-write transaction, because the rule that a
 * newer revision is never replaced by an older one has to hold against two
 * tabs of the same profile writing at once, not just against one.
 */
import Dexie, { type Table } from "dexie";
import type { Draft, DraftListing, DraftStore } from "./recovery";

/** One database per browser profile; drafts of every root share it. */
const DB_NAME = "alabs-drafts";

class DraftDb extends Dexie {
  /** Keyed by root and path together: one draft per file per root. */
  drafts!: Table<Draft, [string, string]>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({ drafts: "[root+relPath], root" });
  }
}

/** True for a record that still has everything a draft needs. */
function usable(row: unknown): row is Draft {
  if (typeof row !== "object" || row === null) return false;
  const d = row as Record<string, unknown>;
  return (
    typeof d.root === "string" &&
    typeof d.relPath === "string" &&
    typeof d.contents === "string" &&
    typeof d.revision === "number" &&
    Number.isFinite(d.revision)
  );
}

/**
 * The browser's draft store. `name` is only for tests, which give each one a
 * database of its own.
 */
export function browserDrafts(name: string = DB_NAME): DraftStore {
  const db = new DraftDb(name);
  return {
    async put(draft: Draft): Promise<void> {
      await db.transaction("rw", db.drafts, async () => {
        const existing = await db.drafts.get([draft.root, draft.relPath]);
        if (existing !== undefined && !usable(existing)) {
          throw new Error(`the kept draft of ${draft.relPath} is unreadable; it was left untouched`);
        }
        // An equal revision may be written again: a caller that never learned
        // whether its last write landed is retrying, not going backwards.
        if (usable(existing) && existing.revision > draft.revision) {
          throw new Error(`a newer draft of ${draft.relPath} is already kept`);
        }
        await db.drafts.put(draft);
      });
    },

    async list(root: string): Promise<DraftListing> {
      const rows = await db.drafts.where("root").equals(root).toArray();
      const listing: DraftListing = { drafts: [], unreadable: [] };
      for (const row of rows) {
        // A record this version cannot make sense of is reported, never
        // quietly dropped and never deleted: it is somebody's unsaved work.
        if (usable(row)) listing.drafts.push(row);
        else listing.unreadable.push(String((row as { relPath?: unknown })?.relPath ?? "a draft"));
      }
      listing.drafts.sort((a, b) => b.updatedAt - a.updatedAt);
      return listing;
    },

    async drop(root: string, relPath: string, revision: number): Promise<void> {
      await db.transaction("rw", db.drafts, async () => {
        const existing = await db.drafts.get([root, relPath]);
        if (existing === undefined) return;
        if (!usable(existing)) {
          throw new Error(`the kept draft of ${relPath} is unreadable; it was left untouched`);
        }
        if (usable(existing) && existing.revision > revision) {
          throw new Error(`${relPath} has been edited since that version; its draft was kept`);
        }
        await db.drafts.delete([root, relPath]);
      });
    },
  };
}

/**
 * A store for a runtime whose browser storage will not open at all — private
 * browsing, blocked site data, a profile whose IndexedDB is broken.
 *
 * It refuses instead of pretending, which is the point: a draft that reports
 * itself kept when nothing kept it is worse than one that says it could not
 * be. The durable copy is unaffected, and alabs still holds the live text.
 */
export function noBrowserDrafts(reason: string): DraftStore {
  const refuse = () => Promise.reject(new Error(reason));
  return {
    put: refuse,
    list: () => Promise.resolve({ drafts: [], unreadable: [] }),
    drop: refuse,
  };
}
