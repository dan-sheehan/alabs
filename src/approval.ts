/**
 * Approvals to drop an editor buffer. Every destructive transition (closing
 * a tab, switching subject, quitting, moving a file to the Trash) may dispose
 * a Monaco model only for the exact model version the user approved, either
 * by saving it or by choosing Discard. An edit after the approval makes the
 * buffer dirty again and the approval void; the user is then asked again.
 *
 * Pure functions on version numbers, so the decision is testable without
 * Monaco.
 */

/** Permission to drop one buffer at exactly this alternative version id. */
export interface Approval {
  version: number;
}

/**
 * True when `approval` still covers the buffer: its live version is the one
 * approved. A buffer with no live model (`null`) has nothing to lose.
 */
export function approvalHolds(approval: Approval | null | undefined, liveVersion: number | null): boolean {
  if (liveVersion === null) return true;
  return approval != null && approval.version === liveVersion;
}

/**
 * The implicit approval for a clean buffer: nothing to save, so its live
 * version may be dropped. Null when the buffer is dirty.
 */
export function cleanApproval(savedVersion: number, liveVersion: number | null): Approval | null {
  if (liveVersion === null) return { version: savedVersion };
  return savedVersion === liveVersion ? { version: liveVersion } : null;
}

/**
 * Approval for a buffer whose user chose Discard while it stood at
 * `liveVersion`; only that exact version may be dropped.
 */
export function discardApproval(liveVersion: number): Approval {
  return { version: liveVersion };
}

/**
 * Which of `paths` still lack a holding approval, given each buffer's saved
 * and live versions. A path with an explicit approval that holds is covered;
 * so is a path with no explicit approval whose buffer is clean. Everything
 * else must be asked about again before it may be disposed.
 */
export function unapproved(
  paths: readonly string[],
  approvals: ReadonlyMap<string, Approval>,
  versions: (path: string) => { saved: number; live: number | null } | null,
): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const v = versions(path);
    if (!v) continue;
    const approval = approvals.get(path) ?? cleanApproval(v.saved, v.live);
    if (!approvalHolds(approval, v.live)) out.push(path);
  }
  return out;
}
