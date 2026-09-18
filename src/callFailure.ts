/**
 * Two ways a runtime call can fail that change what alabs must *do*, not just
 * what it says. Everything else is an ordinary refusal with a reason to show.
 *
 * The marker is a registered symbol rather than a message alabs matches on, so
 * nothing depends on the wording of a sentence a user reads.
 */

export type CallFailure =
  /**
   * The request left, and no answer came back. The operation may have been
   * carried out in full. Nothing may be retried on this: what actually
   * happened has to be found out from the disk first.
   */
  | "uncertain"
  /**
   * Refused because another alabs window holds the editing role. The page
   * that asked is read-only and did not know it yet.
   */
  | "not-writing";

/** Registered, so a second copy of this module still recognises the mark. */
const MARK = Symbol.for("alabs.callFailure");

/** An error carrying what kind of failure it is. */
export function failed(kind: CallFailure, message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, MARK, { value: kind, enumerable: false });
  return error;
}

/** What kind of failure this is, or null for an ordinary refusal. */
export function callFailure(err: unknown): CallFailure | null {
  if (typeof err !== "object" || err === null) return null;
  const kind = (err as Record<symbol, unknown>)[MARK];
  return kind === "uncertain" || kind === "not-writing" ? kind : null;
}
