/**
 * Unsaved work, and how far it has got.
 *
 * alabs in Chrome may not enable editing without this. A buffer in a browser
 * tab is the least durable place text can be: the tab can be closed, the page
 * reloaded, the browser quit, the machine restarted. So every edit becomes a
 * *draft* — a numbered revision of one file's buffer — and a draft is written
 * twice: into the browser's own storage, which is immediate, and into a file
 * under alabs' state folder, which survives clearing browser data.
 *
 * The rules this module exists to keep:
 *
 *   * A revision is acknowledged only once its storage has actually accepted
 *     it. "Written" is never assumed from "asked to write".
 *   * A write that finishes late acknowledges **its own** revision and no
 *     other. It can never speak for the text that was typed after it.
 *   * Storage that fails says so. The live text stays in hand, and alabs can
 *     hand it to the user, rather than a quiet failure that looks like safety.
 *   * A draft is forgotten only when the file has been saved at that exact
 *     revision, or the user discarded it. Never to make room, never on a
 *     guess.
 *
 * Everything here is plain values and promises, so the ordering rules can be
 * tested without a browser, a server, or a disk.
 */
import type { FileStamp } from "./subject";

/** One revision of one file's unsaved buffer. */
export interface Draft {
  /** Canonical absolute path of the alabs root the file is in. */
  root: string;
  /** The file's path inside that root. */
  relPath: string;
  /** The file's stamp when the buffer last matched the disk; null when the file was already gone. */
  stamp: FileStamp | null;
  contents: string;
  /** Only ever increases for one file. */
  revision: number;
  /** The `alabs-serve` lifetime this was typed against, when there was one. */
  serverId: string | null;
  /** The alabs window that typed it. */
  sessionId: string;
  /** Milliseconds since the epoch. */
  updatedAt: number;
}

/** What one listing found, including records it could not read. */
export interface DraftListing {
  drafts: Draft[];
  /** Names of stored drafts that could not be read. Reported, never dropped. */
  unreadable: string[];
}

/** Somewhere a draft can be kept. Both places alabs keeps them look like this. */
export interface DraftStore {
  /** Store one revision. Rejects rather than storing an older one over a newer. */
  put(draft: Draft): Promise<void>;
  list(root: string): Promise<DraftListing>;
  /** Forget a draft, but only up to `revision`; newer text is kept. */
  drop(root: string, relPath: string, revision: number): Promise<void>;
}

/** How far the newest revision of one draft has got. */
export type Kept =
  /** Typed, and not yet accepted anywhere. */
  | "pending"
  /** Accepted by the browser's own storage. Survives a reload and a closed tab. */
  | "browser"
  /** Also written to alabs' state folder. Survives clearing browser data. */
  | "disk";

/** Where a draft could not be kept, and what was said about it. */
export interface Trouble {
  where: "browser" | "disk";
  reason: string;
}

/** What alabs knows about one file's unsaved work right now. */
export interface DraftState {
  revision: number;
  kept: Kept;
  /** Set while the newest revision could not be kept somewhere. */
  trouble: Trouble | null;
}

export interface RecorderIo {
  /** The alabs root every draft belongs to. */
  root: string;
  /** This `alabs-serve` lifetime, when there is one. */
  serverId: string | null;
  /** This alabs window. */
  sessionId: string;
  /** The browser's own storage: immediate, and lost with the browser's data. */
  browser: DraftStore;
  /** alabs' state folder, through the server: the durable copy. */
  disk: DraftStore;
  now?: () => number;
}

/**
 * Keeps one root's drafts, one revision at a time per file.
 *
 * Writes are single-file: while one revision of a file is being stored, newer
 * text simply replaces what is waiting, so a burst of typing costs two writes
 * rather than one per keystroke, and the newest text is always the one that
 * ends up stored.
 */
export class Recorder {
  private readonly io: RecorderIo;
  /** The newest revision assigned per file. */
  private readonly latest = new Map<string, number>();
  /** The newest revision each store has actually accepted, per file. */
  private readonly acked = new Map<string, { browser: number; disk: number }>();
  /** The newest draft not yet stored, per file. */
  private readonly waiting = new Map<string, Draft>();
  /** The store in progress per file, so settling can wait for it. */
  private readonly storing = new Map<string, Promise<void>>();
  /**
   * The revision each file has been dealt with through: saved, or discarded.
   *
   * Kept for the life of this window rather than cleared with the draft,
   * because it is also the floor the next revision has to clear. Without it, a
   * file saved and then edited again would start at 1, and a store that still
   * held revision 7 — because the drop was refused — would refuse every write
   * from then on.
   */
  private readonly settled = new Map<string, number>();
  /** The newest text per file, kept so it can be handed over if storing fails. */
  private readonly live = new Map<string, Draft>();
  private readonly troubles = new Map<string, Trouble>();
  /** Called whenever a file's `DraftState` changes, so the UI can follow it. */
  changed: (relPath: string) => void = () => {};

  constructor(io: RecorderIo) {
    this.io = io;
  }

  private now(): number {
    return (this.io.now ?? Date.now)();
  }

  private acksFor(relPath: string): { browser: number; disk: number } {
    let acks = this.acked.get(relPath);
    if (!acks) {
      acks = { browser: 0, disk: 0 };
      this.acked.set(relPath, acks);
    }
    return acks;
  }

  /**
   * Start this file's revisions above what was already stored for it.
   *
   * Revisions must only ever increase, and a restored draft was numbered by an
   * earlier alabs window. Without this, the first edit after a restore would
   * be numbered 1 and be refused as older than what is kept.
   */
  seed(relPath: string, revision: number, where: "browser" | "disk"): void {
    this.latest.set(relPath, Math.max(revision, this.latest.get(relPath) ?? 0));
    const acks = this.acksFor(relPath);
    // A listing proves only what that store holds. The other copy may be
    // older, missing, or unreadable; never promote it to an acknowledgement.
    acks[where] = Math.max(acks[where], revision);
  }

  /**
   * Record the buffer of `relPath` as its next revision and start storing it.
   * Text identical to the newest revision is not renumbered: it is already
   * exactly what is being kept.
   *
   * Returns the revision this text is known by, which is what `settle` must
   * later be given.
   */
  note(relPath: string, contents: string, stamp: FileStamp | null): number {
    const current = this.live.get(relPath);
    if (current && current.contents === contents && sameStamp(current.stamp, stamp)) {
      return current.revision;
    }
    const revision = Math.max(this.latest.get(relPath) ?? 0, this.settled.get(relPath) ?? 0) + 1;
    const draft: Draft = {
      root: this.io.root,
      relPath,
      stamp,
      contents,
      revision,
      serverId: this.io.serverId,
      sessionId: this.io.sessionId,
      updatedAt: this.now(),
    };
    this.latest.set(relPath, revision);
    this.live.set(relPath, draft);
    this.waiting.set(relPath, draft);
    this.changed(relPath);
    this.start(relPath);
    return revision;
  }

  /** Begin storing this file's waiting revisions, if nothing is already. */
  private start(relPath: string): void {
    if (this.storing.has(relPath)) return;
    const run = this.store(relPath);
    this.storing.set(relPath, run);
    void run.then(() => {
      this.storing.delete(relPath);
      // Text typed in the moment between the loop ending and this bookkeeping
      // would otherwise sit unwritten until the next keystroke.
      if (this.waiting.has(relPath)) this.start(relPath);
    });
  }

  /** Store whatever is waiting for `relPath`, one revision at a time. */
  private async store(relPath: string): Promise<void> {
    for (;;) {
      const draft = this.waiting.get(relPath);
      if (!draft) return;
      this.waiting.delete(relPath);
      // Dealt with while it waited — saved, or thrown away — so writing it
      // now would put back a draft that is finished with.
      if (draft.revision <= (this.settled.get(relPath) ?? 0)) continue;
      let trouble: Trouble | null = null;
      // The browser first: it is the storage alabs can reach without leaving
      // the page, so it is the one that answers soonest.
      try {
        await this.io.browser.put(draft);
        this.ack(relPath, "browser", draft.revision);
      } catch (err) {
        trouble = { where: "browser", reason: String(err) };
      }
      // The disk regardless: browser storage failing is exactly when the
      // durable copy matters most, and the two do not depend on each other.
      try {
        await this.io.disk.put(draft);
        this.ack(relPath, "disk", draft.revision);
      } catch (err) {
        trouble = { where: "disk", reason: String(err) };
      }
      this.setTrouble(relPath, trouble);
    }
  }

  /**
   * One store accepted one revision. Only ever that revision: a write that
   * finished late must not acknowledge the text typed after it.
   */
  private ack(relPath: string, where: "browser" | "disk", revision: number): void {
    const acks = this.acksFor(relPath);
    if (revision <= acks[where]) return;
    acks[where] = revision;
    this.changed(relPath);
  }

  private setTrouble(relPath: string, trouble: Trouble | null): void {
    const had = this.troubles.get(relPath) ?? null;
    if (trouble === null) {
      if (had === null) return;
      this.troubles.delete(relPath);
    } else {
      if (had && had.where === trouble.where && had.reason === trouble.reason) return;
      this.troubles.set(relPath, trouble);
    }
    this.changed(relPath);
  }

  /** How far this file's newest revision has got, or null when it has none. */
  state(relPath: string): DraftState | null {
    const revision = this.latest.get(relPath);
    if (revision === undefined) return null;
    const acks = this.acksFor(relPath);
    const kept: Kept = acks.disk >= revision ? "disk" : acks.browser >= revision ? "browser" : "pending";
    return { revision, kept, trouble: this.troubles.get(relPath) ?? null };
  }

  /** The newest text alabs holds for this file, for handing to the user. */
  text(relPath: string): string | null {
    return this.live.get(relPath)?.contents ?? null;
  }

  /** Every file with unsaved work alabs is keeping right now. */
  paths(): string[] {
    return [...this.latest.keys()];
  }

  /**
   * That revision has been dealt with — written to the file, or discarded on
   * purpose — so the draft is no longer needed.
   *
   * A file edited again since then keeps its draft: both stores refuse to
   * forget text newer than the revision named here, so this can be called
   * after a save without checking first.
   */
  async settle(relPath: string, revision: number): Promise<void> {
    // Typed again since: that text has not been dealt with, so nothing is
    // forgotten and nothing is asked of either store.
    if ((this.latest.get(relPath) ?? 0) > revision) return;
    this.settled.set(relPath, Math.max(this.settled.get(relPath) ?? 0, revision));
    // Nothing still waiting is worth writing now; and a write already on its
    // way has to land before the record may be removed, or the drop could
    // overtake it and leave behind exactly the draft being settled.
    this.waiting.delete(relPath);
    await this.storing.get(relPath)?.catch(() => {});
    if ((this.latest.get(relPath) ?? 0) > revision) return;
    await Promise.allSettled([
      this.io.browser.drop(this.io.root, relPath, revision),
      this.io.disk.drop(this.io.root, relPath, revision),
    ]);
    // Typed while the stores were being asked: that text is unsaved again.
    if ((this.latest.get(relPath) ?? 0) > revision) return;
    // A store that could not forget it leaves a record of text that is now in
    // the file. That is offered for review at the next launch like any other
    // draft, which is safe; what would not be safe is alabs going on claiming
    // unsaved work for a buffer that has none.
    this.latest.delete(relPath);
    this.acked.delete(relPath);
    this.waiting.delete(relPath);
    this.live.delete(relPath);
    this.troubles.delete(relPath);
    this.changed(relPath);
  }
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.identity === b.identity && a.mtime_secs === b.mtime_secs && a.mtime_nanos === b.mtime_nanos && a.len === b.len;
}

/**
 * The drafts to offer the user at launch: everything kept for this root,
 * newest first, taking the higher revision when the same file is in both
 * stores. Either can be the newer one — the browser is written first, and the
 * disk still holds what a cleared browser lost — so neither is trusted over
 * the other and the revision decides.
 */
export function mergeDrafts(browser: DraftListing, disk: DraftListing): DraftListing {
  const best = new Map<string, Draft>();
  for (const draft of [...disk.drafts, ...browser.drafts]) {
    const had = best.get(draft.relPath);
    if (!had || draft.revision > had.revision) best.set(draft.relPath, draft);
  }
  return {
    drafts: [...best.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    unreadable: [...new Set([...browser.unreadable, ...disk.unreadable])].sort(),
  };
}
