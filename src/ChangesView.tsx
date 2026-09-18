import { useEffect, useRef, useState } from "react";
import { editor as monacoEditor, Uri } from "monaco-editor";
import {
  BASELINE_GONE,
  BINARY,
  DIRTY_NOTE,
  emptyText,
  FILE_GONE,
  MODE_LABEL,
  NOT_GIT,
  offerModes,
  paneTitles,
  queryFailureText,
  READING,
  rowsOf,
  rowText,
  SELECT_PROMPT,
  sidesOf,
  type ChangeRow,
  type ChangesMode,
  type Side,
} from "./changes";
import { languageForFile } from "./language";
import { log } from "./log";
import { clockTime, KIND_TEXT, type PlaceKind } from "./overviewFacts";
import { gitQuery, readFile, type GitQuery } from "./subject";
import type { Baseline } from "./uiState";

interface ChangesProps {
  /** The place's root-relative folder and display name. */
  prefix: string;
  placeName: string;
  /** From Home's `.git` check: nothing runs for a folder or a linked `.git`. */
  gitKind: PlaceKind;
  /** The handoff baseline recorded for this place, or null. */
  baseline: Baseline | null;
  /** When a task packet was copied, until the next Refresh; the readout's cue. */
  taskStartedAt: number | null;
  /** Explicit Refresh counter; a bump re-reads the listing and the selected comparison. */
  reload: number;
  locked: boolean;
  /** Root-relative paths of Editor tabs with unsaved edits: the comparison shows the disk and says so. */
  dirtyPaths: ReadonlySet<string>;
  /** Open a changed file: the shared boundary-checked open-path handler. */
  onOpenPath: (relPath: string) => void;
  /** Show the Editor tab holding unsaved edits for a path. */
  onOpenTab: (relPath: string) => void;
  onRefresh: () => void;
}

type Listing =
  | { kind: "loading" }
  | { kind: "ready"; rows: ChangeRow[]; readAt: Date }
  | { kind: "failed"; text: string };

type Comparison =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "nested" }
  | { kind: "ready"; left: string; right: string; gone: boolean }
  | { kind: "binary" }
  | { kind: "failed"; text: string };

/** The URI scheme of throwaway comparison models: never a file, never a buffer. */
export const DIFF_SCHEME = "alabs-git";

/** The listing query for a mode. */
function listingQuery(mode: ChangesMode, baseline: Baseline | null): GitQuery {
  if (mode === "status" || baseline === null) return { kind: "status" };
  return mode === "since" ? { kind: "since", baseline: baseline.commit } : { kind: "committed", baseline: baseline.commit };
}

type SideText = { kind: "text"; text: string } | { kind: "gone" } | { kind: "binary" } | { kind: "failed"; text: string };

/** The text of one pane, from the object database or the file on disk. Unsaved editor text is never consulted. */
async function readSide(prefix: string, path: string, side: Side): Promise<SideText> {
  switch (side.kind) {
    case "empty":
      return { kind: "text", text: "" };
    case "gone":
      return { kind: "gone" };
    case "rev": {
      const result = await gitQuery(prefix, { kind: "blob", rev: side.rev, path });
      if (result.kind === "blob") return { kind: "text", text: result.text };
      if (result.kind === "binary") return { kind: "binary" };
      if (result.kind === "missing") return { kind: "gone" };
      return { kind: "failed", text: queryFailureText(result) ?? "Git could not read this file." };
    }
    case "disk": {
      try {
        const text = (await readFile(`${prefix}/${path}`)).content;
        // A NUL byte is valid UTF-8, so the read succeeds; it is still not a text file.
        return text.includes("\0") ? { kind: "binary" } : { kind: "text", text };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (reason.startsWith("not a UTF-8 text file")) return { kind: "binary" };
        if (reason.includes("No such file") || reason.includes("Not a directory")) return { kind: "gone" };
        return { kind: "failed", text: `${reason.replace(/\s*\(os error \d+\)/g, "").replace(/outside the subject/g, "outside the root")}.` };
      }
    }
  }
}

let sequence = 0;

/**
 * The Changes tab (DESIGN.md 6.9): a plain-language list of what changed,
 * per mode, and a read-only Monaco comparison of the selected file. Every
 * listing comes from the endpoints its mode names, NUL-delimited, through
 * the one hardened Git helper. Comparison models live under `alabs-git:`
 * and are disposed on selection change, on close and on unmount; they never
 * take part in buffer ownership, dirty tracking, save, rename or restore.
 * Nothing here reads an editor buffer: the disk side is the saved file.
 */
export function ChangesView(props: ChangesProps) {
  const { prefix, placeName, gitKind, baseline, taskStartedAt, reload, locked, dirtyPaths, onOpenPath, onOpenTab, onRefresh } = props;
  const offer = offerModes(baseline);
  const [mode, setMode] = useState<ChangesMode>(offer.initial);
  const [baselineGone, setBaselineGone] = useState(false);
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [comparison, setComparison] = useState<Comparison>({ kind: "idle" });
  const diffHost = useRef<HTMLDivElement | null>(null);
  const diffEditor = useRef<monacoEditor.IStandaloneDiffEditor | null>(null);
  const models = useRef<monacoEditor.ITextModel[]>([]);
  const baselineCommit = baseline?.commit ?? null;

  // A new baseline (a new packet) resets the mode and forgets a vanished one.
  useEffect(() => {
    setBaselineGone(false);
    setMode(offerModes(baseline).initial);
    setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselineCommit]);

  const usable = gitKind === "repo";
  const effectiveMode: ChangesMode = baselineGone ? "status" : mode;

  // The listing: one or two bounded Git calls for the mode's endpoints.
  useEffect(() => {
    if (!usable) return;
    let cancelled = false;
    setListing({ kind: "loading" });
    void (async () => {
      const result = await gitQuery(prefix, listingQuery(effectiveMode, baseline));
      if (cancelled) return;
      if (result.kind === "baseline_missing") {
        // Named, then the uncommitted listing takes over (the effect re-runs for "status").
        setBaselineGone(true);
        void log("warn", `changes ${prefix}: task baseline ${baselineCommit ?? ""} no longer exists`);
        return;
      }
      const rows = rowsOf(effectiveMode, result);
      if (rows === null) {
        const text = queryFailureText(result) ?? "Git could not read this folder.";
        setListing({ kind: "failed", text });
        void log("error", `changes ${prefix}: ${JSON.stringify(result)}`);
        return;
      }
      setListing({ kind: "ready", rows, readAt: new Date() });
      setSelected((s) => (s !== null && rows.some((r) => r.path === s) ? s : null));
    })();
    return () => {
      cancelled = true;
    };
  }, [prefix, effectiveMode, baseline, baselineCommit, reload, usable]);

  const rows = listing.kind === "ready" ? listing.rows : [];
  const row = selected === null ? null : (rows.find((r) => r.path === selected) ?? null);

  // The comparison for the selected row: the mode's left side and its right side, read fresh.
  useEffect(() => {
    if (!usable || row === null) {
      setComparison({ kind: "idle" });
      return;
    }
    const sides = sidesOf(effectiveMode, row, baselineGone ? null : baseline);
    if (sides === null) {
      setComparison({ kind: "nested" });
      return;
    }
    let cancelled = false;
    setComparison({ kind: "loading" });
    void (async () => {
      const [left, right] = await Promise.all([readSide(prefix, row.path, sides.left), readSide(prefix, row.path, sides.right)]);
      if (cancelled) return;
      const failed = [left, right].find((s): s is Extract<SideText, { kind: "failed" }> => s.kind === "failed");
      if (failed) {
        setComparison({ kind: "failed", text: failed.text });
        return;
      }
      if (left.kind === "binary" || right.kind === "binary") {
        setComparison({ kind: "binary" });
        return;
      }
      setComparison({
        kind: "ready",
        left: left.kind === "text" ? left.text : "",
        right: right.kind === "text" ? right.text : "",
        gone: right.kind === "gone",
      });
    })();
    return () => {
      cancelled = true;
    };
    // The row object changes identity with every listing; its path and state are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix, effectiveMode, baselineCommit, baselineGone, row?.path, row?.state, reload, usable]);

  // The diff editor: throwaway models under `alabs-git:`, replaced on every
  // comparison and disposed with the surface.
  useEffect(() => {
    const host = diffHost.current;
    const disposeModels = () => {
      for (const model of models.current) model.dispose();
      models.current = [];
    };
    if (!host || comparison.kind !== "ready" || row === null) {
      diffEditor.current?.setModel(null);
      disposeModels();
      return;
    }
    if (!diffEditor.current) {
      monacoEditor.setTheme("vs-dark");
      diffEditor.current = monacoEditor.createDiffEditor(host, {
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        // Always two panes, as the titles say; the inline view wraps deleted lines one character per line.
        useInlineViewWhenSpaceIsLimited: false,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 14,
        wordWrap: "on",
        enableSplitViewResizing: false,
      });
    }
    diffEditor.current.setModel(null);
    disposeModels();
    sequence += 1;
    const language = languageForFile(row.path);
    const uri = (side: "left" | "right") => Uri.from({ scheme: DIFF_SCHEME, path: `/${sequence}/${side}/${row.path}` });
    const original = monacoEditor.createModel(comparison.left, language, uri("left"));
    const modified = monacoEditor.createModel(comparison.right, language, uri("right"));
    models.current = [original, modified];
    diffEditor.current.setModel({ original, modified });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparison]);

  useEffect(
    () => () => {
      diffEditor.current?.setModel(null);
      diffEditor.current?.dispose();
      diffEditor.current = null;
      for (const model of models.current) model.dispose();
      models.current = [];
    },
    [],
  );

  const titles = paneTitles(effectiveMode);
  const readout =
    taskStartedAt !== null ? (
      <span className="overview-asof mono muted">Task started {clockTime(new Date(taskStartedAt))} · press Refresh when the tool is done</span>
    ) : (
      <span className="overview-asof mono muted">
        {listing.kind === "ready" ? `as of ${clockTime(listing.readAt)} · ` : ""}
        <button type="button" className="navlink" onClick={onRefresh} disabled={locked}>
          Refresh
        </button>
      </span>
    );
  const note = baselineGone ? BASELINE_GONE : offer.note;
  const modes: ChangesMode[] = baselineGone ? ["status"] : offer.modes;
  const rowDirty = row !== null && dirtyPaths.has(`${prefix}/${row.path}`);

  if (!usable) {
    return (
      <div className="changes" aria-label={`Changes in ${placeName}`}>
        <div className="changes-header">
          <span className="chip chip-primary chip-static">{MODE_LABEL.status}</span>
          {readout}
        </div>
        <div className="changes-state">{gitKind === "linked" ? KIND_TEXT.linked : NOT_GIT}</div>
      </div>
    );
  }

  return (
    <div className="changes" aria-label={`Changes in ${placeName}`}>
      <div className="changes-header">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            className={"chip" + (m === effectiveMode ? " chip-primary" : "")}
            aria-pressed={m === effectiveMode}
            disabled={locked}
            onClick={() => {
              setSelected(null);
              setMode(m);
            }}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
        {readout}
      </div>
      {note && <div className="changes-note muted">{note}</div>}
      <div className="changes-columns">
        <div className="changes-list" role="listbox" aria-label="Changed files">
          {listing.kind === "loading" && <div className="changes-row muted">{READING}</div>}
          {listing.kind === "failed" && <div className="changes-row error">{listing.text}</div>}
          {listing.kind === "ready" && rows.length === 0 && <div className="changes-row muted">{emptyText(effectiveMode)}</div>}
          {listing.kind === "ready" &&
            rows.map((r) => {
              const openable = r.state !== "deleted" && r.state !== "nested";
              const isSelected = r.path === selected;
              return (
                <div
                  key={r.path}
                  role="option"
                  aria-selected={isSelected}
                  className={"changes-row changes-file mono" + (isSelected ? " changes-selected" : "")}
                  tabIndex={locked ? -1 : 0}
                  title={r.path}
                  onClick={locked ? undefined : () => setSelected(r.path)}
                  onKeyDown={(e) => {
                    if (locked || e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(r.path);
                    }
                  }}
                >
                  <span className="changes-row-text">
                    <span className={"changes-state-word" + (r.state === "conflict" ? " error" : "")}>{r.state === "nested" ? "nested repository" : r.state}</span>
                    <span className="muted"> · </span>
                    <span className="ltr">{r.path}</span>
                  </span>
                  {openable && (
                    <button
                      type="button"
                      className="navlink changes-open"
                      disabled={locked}
                      title={`open ${r.path}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenPath(`${prefix}/${r.path}`);
                      }}
                    >
                      open →
                    </button>
                  )}
                </div>
              );
            })}
        </div>
        <div className="changes-diff">
          <div className="diff-titles">
            <span className="diff-title mono muted">{titles.left}</span>
            <span className="diff-title mono muted">{titles.right}</span>
          </div>
          {rowDirty && (
            <div className="disk-banner" role="status">
              {DIRTY_NOTE}{" "}
              <button type="button" className="chip" disabled={locked} onClick={() => row && onOpenTab(`${prefix}/${row.path}`)}>
                Open tab
              </button>
            </div>
          )}
          {comparison.kind === "idle" && <div className="changes-state muted">{SELECT_PROMPT}</div>}
          {comparison.kind === "loading" && <div className="changes-state muted">{READING}</div>}
          {comparison.kind === "nested" && row && <div className="changes-state muted">{rowText(row)}</div>}
          {comparison.kind === "binary" && <div className="changes-state muted">{BINARY}</div>}
          {comparison.kind === "failed" && <div className="changes-state error">{comparison.text}</div>}
          {comparison.kind === "ready" && comparison.gone && <div className="changes-gone muted">{FILE_GONE}</div>}
          <div ref={diffHost} className="diff-editor" hidden={comparison.kind !== "ready"} />
        </div>
      </div>
    </div>
  );
}
