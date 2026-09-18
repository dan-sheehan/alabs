import { useEffect, useRef, useState } from "react";
import { renderMarkdown } from "./markdown";
import { failureNotice } from "./notices";
import { displayPath } from "./places";
import { readFile } from "./subject";

interface MarkdownViewProps {
  /** Root-relative path of the file, and the place's folder for display. */
  relPath: string;
  prefix: string;
  /** Explicit Refresh counter; a bump re-reads the file from disk. */
  reload: number;
  locked: boolean;
  /** True when an Editor tab for the same path has unsaved edits: the view shows the disk and says so. */
  dirtyInEditor: boolean;
  /** A local link: the shared boundary-checked open-path handler decides. */
  onOpenPath: (relPath: string) => void;
  /** `Open source`: the Editor tab for this path. */
  onOpenSource: () => void;
  /** Show the editor tab that holds the unsaved edits. */
  onOpenTab: () => void;
}

type State = { kind: "loading" } | { kind: "ready"; html: string } | { kind: "failed"; reason: string };

/**
 * The Markdown tab (DESIGN.md 6.6): one bounded read, rendered through the
 * two-stage pipeline in `markdown.ts`, mounted per tab so a return reloads
 * nothing. A click on a local link goes through `onOpenPath`; `http(s)`
 * links were rendered as text and images as their alt text, so nothing in
 * the body can leave the app or load anything.
 */
export function MarkdownView({ relPath, prefix, reload, locked, dirtyInEditor, onOpenPath, onOpenSource, onOpenTab }: MarkdownViewProps) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const body = useRef<HTMLDivElement | null>(null);
  const name = relPath.split("/").pop() ?? relPath;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const file = await readFile(relPath);
        if (cancelled) return;
        setState({ kind: "ready", html: renderMarkdown(file.content, relPath) });
      } catch (err) {
        if (!cancelled) setState({ kind: "failed", reason: failureNotice(err).text });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relPath, reload]);

  // The sanitized markup is placed once per render result; local links get
  // a keyboard target here, outside the file's own content.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    el.innerHTML = state.kind === "ready" ? state.html : "";
    for (const a of el.querySelectorAll("a[data-path]")) {
      const path = a.getAttribute("data-path") ?? "";
      a.setAttribute("role", "link");
      a.setAttribute("tabindex", "0");
      a.setAttribute("title", path);
    }
  }, [state]);

  const linkOf = (target: EventTarget | null): string | null => {
    const el = target instanceof Element ? target.closest("a[data-path]") : null;
    return el?.getAttribute("data-path") ?? null;
  };

  return (
    <div className="markdown-tab">
      <div className="surface-header">
        <span className="mono muted surface-path" title={relPath}>
          {displayPath(relPath, prefix)}
        </span>
        <button type="button" className="chip" onClick={onOpenSource} disabled={locked}>
          Open source
        </button>
      </div>
      {dirtyInEditor && (
        <div className="disk-banner" role="status">
          Unsaved edits exist in the editor. This view shows the saved file on disk.{" "}
          <button type="button" className="chip" onClick={onOpenTab} disabled={locked}>
            Open tab
          </button>
        </div>
      )}
      {state.kind === "loading" && <div className="markdown-note muted">Opening {name}…</div>}
      {state.kind === "failed" && (
        <div className="editor-message">
          <div className="mono muted">{displayPath(relPath, prefix)}</div>
          <div className="error">{state.reason}</div>
        </div>
      )}
      <div
        ref={body}
        className="markdown-body"
        hidden={state.kind !== "ready"}
        onClick={(e) => {
          const path = linkOf(e.target);
          if (path === null || locked) return;
          e.preventDefault();
          onOpenPath(path);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          const path = linkOf(e.target);
          if (path === null || locked) return;
          e.preventDefault();
          onOpenPath(path);
        }}
      />
    </div>
  );
}
