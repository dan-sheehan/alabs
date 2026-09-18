import { useEffect, useRef, useState } from "react";
import { renderMarkdown } from "./markdown";
import {
  branchText,
  clockTime,
  gitInspectionText,
  KIND_TEXT,
  lastCommitText,
  readmeExcerpt,
  readOverview,
  topLevelRows,
  topLevelSummary,
  type OverviewSheet,
  type PlaceKind,
} from "./overviewFacts";
import { failureNotice, placeMissingText } from "./notices";
import { log } from "./log";
import { visualViewPath } from "./places";
import { gitFacts, listDir, readFile, type GitInspection } from "./subject";
import { AskLocalModel, type AskProps } from "./AskLocalModel";

interface OverviewProps {
  /** The place: its root-relative folder, display name and kind (work or knowledge). */
  prefix: string;
  placeName: string;
  isWork: boolean;
  rootPath: string;
  /** True when the place's folder is not in the root right now: the body says so and reads nothing. */
  missing: boolean;
  /** Explicit Refresh counter; a bump re-reads the listing, the README and the Git facts. */
  reload: number;
  locked: boolean;
  /** From Home's `.git` check: fills KIND at once. Git runs only for a repository. */
  gitKind: PlaceKind;
  /** True when `views/<place>/map.svg` exists. */
  hasView: boolean;
  /** Paths of editor tabs with unsaved edits: a dirty README makes the excerpt say it shows the disk. */
  dirtyPaths: ReadonlySet<string>;
  onOpenPath: (relPath: string) => void;
  /** Open the Editor tab for a path (the tab holding unsaved README edits). */
  onOpenEditor: (relPath: string) => void;
  /** Show the place's Visual View tab (`◫ Open visual view` and the VIEW row). */
  onOpenView: () => void;
  /** `Task…`, `Changes` and `Open in Terminal` (Step 6). */
  onOpenTask: () => void;
  onOpenChanges: () => void;
  onOpenTerminal: () => void;
  /** Expand and select a folder in the tree. */
  onRevealDir: (relPath: string) => void;
  onRefresh: () => void;
  onHome: () => void;
  /** The Git facts just read, for the where strip. */
  onGit: (git: GitInspection | null) => void;
  /** The Wiki place only: the folders `Ask local model` reads, the remembered model and where a choice goes. Absent everywhere else. */
  ask?: AskProps;
}

/** A sanitized excerpt placed into the DOM once per text. */
function Rendered({ text, relPath, onOpenPath, locked }: { text: string; relPath: string; onOpenPath: (p: string) => void; locked: boolean }) {
  const body = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    el.innerHTML = renderMarkdown(text, relPath);
    for (const a of el.querySelectorAll("a[data-path]")) {
      a.setAttribute("role", "link");
      a.setAttribute("tabindex", "0");
      a.setAttribute("title", a.getAttribute("data-path") ?? "");
    }
  }, [text, relPath]);
  const linkOf = (target: EventTarget | null): string | null => {
    const el = target instanceof Element ? target.closest("a[data-path]") : null;
    return el?.getAttribute("data-path") ?? null;
  };
  return (
    <div
      ref={body}
      className="markdown-body overview-excerpt"
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
  );
}

/**
 * The pinned first tab of every place (DESIGN.md 6.5): action row, README
 * excerpt and TOP LEVEL from one listing and one bounded README read, THIS
 * PLACE facts from Home's `.git` check and one Git call for a repository.
 * Stays mounted while the place is not showing, so returning reloads
 * nothing; an explicit Refresh re-reads everything.
 */
export function Overview(props: OverviewProps) {
  const {
    prefix,
    placeName,
    isWork,
    rootPath,
    missing,
    reload,
    locked,
    gitKind,
    hasView,
    dirtyPaths,
    onOpenPath,
    onOpenEditor,
    onOpenView,
    onOpenTask,
    onOpenChanges,
    onOpenTerminal,
    onRevealDir,
    onRefresh,
    onHome,
    onGit,
    ask,
  } = props;
  const [sheet, setSheet] = useState<OverviewSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [git, setGit] = useState<GitInspection | "loading" | null>(null);
  const onGitRef = useRef(onGit);
  onGitRef.current = onGit;

  useEffect(() => {
    if (missing) return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const next = await readOverview({ listDir, readFile }, prefix);
        if (!cancelled) setSheet(next);
      } catch (err) {
        if (!cancelled) setError(failureNotice(err).text);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefix, reload, missing]);

  useEffect(() => {
    if (missing || !isWork || gitKind !== "repo") {
      setGit(null);
      onGitRef.current(gitKind === "linked" ? { kind: "linked" } : null);
      return;
    }
    let cancelled = false;
    setGit("loading");
    void (async () => {
      const result = await gitFacts(prefix);
      if (cancelled) return;
      setGit(result);
      onGitRef.current(result);
      const problem =
        result.kind === "facts"
          ? [result.branch, result.last].find((o) => o.kind !== "ok")
          : result.kind === "none"
            ? undefined
            : result;
      if (problem) void log("error", `git ${prefix}: ${JSON.stringify(problem)}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [prefix, reload, missing, isWork, gitKind]);

  if (missing) {
    return (
      <div className="overview">
        <p className="overview-missing">{placeMissingText(placeName, rootPath)}</p>
        <div className="overview-actions">
          <button type="button" className="chip" onClick={onRefresh} disabled={locked}>
            Refresh
          </button>
          <button type="button" className="chip" onClick={onHome} disabled={locked}>
            Home
          </button>
        </div>
      </div>
    );
  }
  if (error) return <div className="overview error">{error}</div>;
  if (!sheet) return <div className="overview muted">Reading {placeName}/…</div>;
  return (
    <OverviewSheetView
      sheet={sheet}
      prefix={prefix}
      isWork={isWork}
      locked={locked}
      gitKind={gitKind}
      git={git}
      hasView={hasView}
      readmeDirty={sheet.readme !== null && dirtyPaths.has(sheet.readme.relPath)}
      onOpenPath={onOpenPath}
      onOpenView={onOpenView}
      onOpenTask={onOpenTask}
      onOpenChanges={onOpenChanges}
      onOpenTerminal={onOpenTerminal}
      onRevealDir={onRevealDir}
      onRefresh={onRefresh}
      onOpenTab={() => sheet.readme && onOpenEditor(sheet.readme.relPath)}
      ask={ask}
    />
  );
}

export interface OverviewSheetProps {
  sheet: OverviewSheet;
  prefix: string;
  isWork: boolean;
  locked: boolean;
  gitKind: PlaceKind;
  /** The Git inspection, `"loading"` while the call is out, null for a non-repository. */
  git: GitInspection | "loading" | null;
  hasView: boolean;
  readmeDirty: boolean;
  onOpenPath: (relPath: string) => void;
  onOpenView: () => void;
  onOpenTask: () => void;
  onOpenChanges: () => void;
  onOpenTerminal: () => void;
  onRevealDir: (relPath: string) => void;
  onRefresh: () => void;
  onOpenTab: () => void;
  /** Now, for relative times; tests pass a fixed value. */
  now?: () => number;
  /** The Wiki place only: renders the `ASK LOCAL MODEL` section under the columns. */
  ask?: AskProps;
}

/** The sheet itself, rendered from what was read. Pure over its props. */
export function OverviewSheetView({
  sheet,
  prefix,
  isWork,
  locked,
  gitKind,
  git,
  hasView,
  readmeDirty,
  onOpenPath,
  onOpenView,
  onOpenTask,
  onOpenChanges,
  onOpenTerminal,
  onRevealDir,
  onRefresh,
  onOpenTab,
  now = () => Date.now() / 1000,
  ask,
}: OverviewSheetProps) {
  const { rows, more } = topLevelRows(sheet.entries);
  const readme = sheet.readme;
  const excerpt = readme?.text === null || readme?.text === undefined ? null : readmeExcerpt(readme.text);
  const nowSecs = now();
  const cell = (fact: (g: GitInspection) => string) => {
    if (git === "loading") return "…";
    if (git === null) return gitKind === "linked" ? KIND_TEXT.linked : "";
    const whole = gitInspectionText(git);
    return whole ?? fact(git);
  };
  return (
    <div className="overview">
      {isWork && (
        <div className="overview-actions overview-action-row">
          {hasView && (
            <button type="button" className="chip chip-primary" onClick={onOpenView} disabled={locked}>
              ◫ Open visual view
            </button>
          )}
          <button type="button" className="chip" onClick={onOpenTask} disabled={locked}>
            Task…
          </button>
          <button type="button" className="chip" onClick={onOpenChanges} disabled={locked}>
            Changes
          </button>
          <button type="button" className="chip" onClick={onOpenTerminal} disabled={locked}>
            Open in Terminal
          </button>
          <span className="overview-asof mono muted">
            as of {clockTime(sheet.readAt)} ·{" "}
            <button type="button" className="navlink" onClick={onRefresh} disabled={locked}>
              Refresh
            </button>
          </span>
        </div>
      )}
      <div className={"overview-columns" + (isWork ? "" : " overview-columns-single")}>
        <div className="overview-left">
          <section className="overview-section" aria-label="README">
            <div className="overview-tag">
              <span className="tag">README</span>
              {readme && <span className="tag tag-detail">{readme.name} · rendered</span>}
            </div>
            {readme ? (
              <>
                {readmeDirty && (
                  <div className="disk-banner" role="status">
                    Unsaved edits exist in the editor. This excerpt shows the saved file on disk.{" "}
                    <button type="button" className="chip" onClick={onOpenTab} disabled={locked}>
                      Open tab
                    </button>
                  </div>
                )}
                {excerpt === null ? (
                  <div className="muted">{readme.name} could not be read.</div>
                ) : (
                  <Rendered text={excerpt} relPath={readme.relPath} onOpenPath={onOpenPath} locked={locked} />
                )}
                <button type="button" className="navlink" disabled={locked} onClick={() => onOpenPath(readme.relPath)}>
                  Open README →
                </button>
              </>
            ) : (
              <div className="muted">no README.md</div>
            )}
          </section>
          <section className="overview-section" aria-label="TOP LEVEL">
            <div className="overview-tag">
              <span className="tag">TOP LEVEL</span>
              <span className="tag tag-detail">{topLevelSummary(sheet.entries)}</span>
            </div>
            {sheet.entries.length === 0 ? (
              <div>Nothing here yet. Add files with Finder or the tree, then Refresh.</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th className="tag">NAME</th>
                    <th className="tag">KIND</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ entry, kind }) => {
                    const go = () => (entry.is_dir ? onRevealDir(entry.rel_path) : onOpenPath(entry.rel_path));
                    return (
                      <tr
                        key={entry.rel_path}
                        className="table-row"
                        tabIndex={locked ? -1 : 0}
                        onClick={locked ? undefined : go}
                        onKeyDown={(e) => {
                          if (!locked && (e.key === "Enter" || e.key === " ")) {
                            e.preventDefault();
                            go();
                          }
                        }}
                      >
                        <td className="mono">{entry.name}</td>
                        <td>
                          {entry.is_dir && <span className="swatch swatch-folder" aria-hidden="true" />} {kind}
                        </td>
                        <td className="table-link">
                          <span className="navlink">{entry.is_dir ? "open in tree →" : "open →"}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {more > 0 && (
                    <tr className="table-row" tabIndex={locked ? -1 : 0} onClick={locked ? undefined : () => onRevealDir(prefix)}>
                      <td className="muted" colSpan={3}>
                        and {more} more in the tree →
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </section>
        </div>
        {isWork && (
          <section className="overview-section overview-right" aria-label="THIS PLACE">
            <div className="overview-tag">
              <span className="tag">THIS PLACE</span>
            </div>
            <dl className="spec">
              <dt className="tag">KIND</dt>
              <dd className="mono">
                {gitKind === "repo" && <span className="swatch swatch-git" aria-hidden="true" />} {KIND_TEXT[gitKind]}
              </dd>
              {gitKind === "repo" && (
                <>
                  <dt className="tag">BRANCH</dt>
                  <dd className="mono" title={cell(branchText)}>
                    {cell(branchText)}
                  </dd>
                  <dt className="tag">LAST</dt>
                  <dd className="mono" title={cell((g) => lastCommitText(g, nowSecs))}>
                    {cell((g) => lastCommitText(g, nowSecs))}
                  </dd>
                </>
              )}
              {hasView && (
                <>
                  <dt className="tag">VIEW</dt>
                  <dd>
                    <button type="button" className="navlink" disabled={locked} onClick={onOpenView}>
                      {visualViewPath(prefix)}
                    </button>
                  </dd>
                </>
              )}
            </dl>
          </section>
        )}
      </div>
      {ask && <AskLocalModel {...ask} locked={locked} />}
    </div>
  );
}
