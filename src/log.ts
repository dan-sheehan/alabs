/**
 * The one bounded local log, `alabs.log` in the app data folder. Records
 * named failures, state fallback, restore and Refresh summaries and boundary
 * refusals. Never file contents, never absolute root paths: callers pass the
 * root so it can be replaced before the line leaves the app. A write failure
 * is swallowed; nothing waits on the log and nothing depends on it.
 */
import { appendLog } from "./subject";

export type LogLevel = "info" | "warn" | "error";

/** Replace the absolute root path (and any path under it) with `<root>`. */
export function redactRoot(text: string, root: string | null): string {
  if (!root) return text;
  return text.split(root).join("<root>");
}

/** Write one line. Fire and forget: the returned promise never rejects. */
export function log(level: LogLevel, message: string, root: string | null = null): Promise<void> {
  const line = `${new Date().toISOString()} ${level} ${redactRoot(message, root)}`;
  return appendLog(line).catch(() => {
    // The log is disposable. A failure here changes nothing else.
  });
}
