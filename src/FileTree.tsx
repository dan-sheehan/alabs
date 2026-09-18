import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "./Search";
import { listDir, type Entry } from "./subject";

interface FileTreeProps {
  /** The place this tree shows: its root-relative folder and display name. */
  prefix: string;
  placeName: string;
  activePath: string | null;
  /** Paths of tabs with unsaved edits, for the `•` mark. */
  dirtyPaths: ReadonlySet<string>;
  /** Expanded folders (root-relative). Owned by the scope so it can be remembered. */
  expanded: ReadonlySet<string>;
  /** Folder (root-relative) that new items are created in. */
  selectedDir: string;
  /** Per-folder counters; a bump makes that folder re-list its contents. */
  refresh: Record<string, number>;
  /**
   * Explicit Refresh counter. A bump re-lists the place root and every
   * expanded folder; collapsed folders drop their cached listing and re-list
   * lazily when next expanded. Nothing is scanned recursively.
   */
  reload: number;
  locked: boolean;
  /** True when the place's folder is not in the root right now: one named row instead of the tree. */
  missing: boolean;
  /** Search replaces the tree while true. Owned by the scope. */
  searching: boolean;
  onSearching: (on: boolean) => void;
  /** Bumped to focus the search input (Cmd+Shift+F). */
  searchFocus: number;
  onRefresh: () => void;
  onOpenFile: (relPath: string) => void;
  /** Open a search hit: a real file, at `line` (1-based) when given. */
  onOpenResult: (relPath: string, line: number | null) => void;
  onSelectDir: (relPath: string) => void;
  onToggleDir: (relPath: string) => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: (entry: Entry) => void;
  onMove: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
}

interface TreeContext {
  locked: boolean;
  activePath: string | null;
  dirtyPaths: ReadonlySet<string>;
  selectedDir: string;
  expanded: ReadonlySet<string>;
  refresh: Record<string, number>;
  reload: number;
  onOpenFile: (relPath: string) => void;
  onSelectDir: (relPath: string) => void;
  onToggleDir: (relPath: string) => void;
  onRename: (entry: Entry) => void;
  onMove: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
}

/** The sidebar of one place: header, Search, the lazily listed tree. Stays mounted while the place is not showing. */
export function FileTree({
  prefix,
  placeName,
  activePath,
  dirtyPaths,
  selectedDir,
  expanded,
  refresh,
  reload,
  locked,
  missing,
  searching,
  onSearching,
  searchFocus,
  onRefresh,
  onOpenFile,
  onOpenResult,
  onSelectDir,
  onToggleDir,
  onNewFile,
  onNewFolder,
  onRename,
  onMove,
  onDelete,
}: FileTreeProps) {
  const inert = locked || missing;
  const searchButton = useRef<HTMLButtonElement>(null);
  const [showTitle, setShowTitle] = useState(false);
  return (
    <div className="tree">
      <div className="sidebar-identity">
        <button type="button" className="sidebar-header" title={prefix} aria-expanded={showTitle} onClick={() => setShowTitle(!showTitle)}>
          <span className="tag">{searching ? "SEARCH IN" : "INSIDE"}</span>
          <span className="sidebar-title strong mono">{placeName}</span>
          <span className="muted" aria-hidden="true">{showTitle ? "▾" : "▸"}</span>
        </button>
        {showTitle && (
          <div className="sidebar-full-title mono">
            {placeName}
            {prefix !== placeName && <><br /><span className="muted">{prefix}</span></>}
          </div>
        )}
      </div>
      {!searching && (
        <div className="sidebar-actions">
          <button type="button" className="navlink" title="New File" onClick={onNewFile} disabled={inert}>
            + file
          </button>
          <button type="button" className="navlink" title="New Folder" onClick={onNewFolder} disabled={inert}>
            + folder
          </button>
        </div>
      )}
      <div className="sidebar-actions">
        <button ref={searchButton} type="button" className="chip" onClick={() => onSearching(!searching)} disabled={inert}>
          Search
        </button>
        <button type="button" className="chip" title="Refresh from disk" onClick={onRefresh} disabled={locked}>
          Refresh
        </button>
      </div>
      {missing && <div className="tree-note muted">{placeName} is not available right now.</div>}
      {searching && !missing && (
        <Search
          prefix={prefix}
          placeName={placeName}
          onOpenResult={onOpenResult}
          onClose={() => {
            onSearching(false);
            searchButton.current?.focus();
          }}
          focusToken={searchFocus}
          locked={locked}
        />
      )}
      {/* The tree stays mounted behind search results so its expanded folders are kept. */}
      <div hidden={searching || missing}>
        <DirContents
          relPath={prefix}
          depth={0}
          active={!searching}
          ctx={{
            locked: inert,
            activePath,
            dirtyPaths,
            selectedDir,
            expanded,
            refresh,
            reload,
            onOpenFile,
            onSelectDir,
            onToggleDir,
            onRename,
            onMove,
            onDelete,
          }}
        />
      </div>
    </div>
  );
}

function DirContents({
  relPath,
  depth,
  active,
  ctx,
}: {
  relPath: string;
  depth: number;
  /** False while the parent folder is collapsed; a Refresh then skips this level. */
  active: boolean;
  ctx: TreeContext;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = ctx.refresh[relPath] ?? 0;

  const load = useCallback(() => {
    let cancelled = false;
    listDir(relPath).then(
      (list) => {
        if (!cancelled) {
          setEntries(list);
          setError(null);
        }
      },
      (err) => {
        if (!cancelled) setError(String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [relPath]);

  // Initial listing, and re-listing after something was created, moved or trashed here.
  useEffect(load, [load, version]);

  // Explicit Refresh: re-list this level only while it is visible.
  const appliedReload = useRef(ctx.reload);
  useEffect(() => {
    if (!active || appliedReload.current === ctx.reload) return;
    appliedReload.current = ctx.reload;
    return load();
  }, [active, ctx.reload, load]);

  const name = relPath.split("/").pop() ?? relPath;
  if (error)
    return (
      <div className="tree-error" style={{ paddingLeft: indent(depth) }}>
        {error}
      </div>
    );
  if (!entries)
    return (
      <div className="tree-note muted mono" style={{ paddingLeft: indent(depth) }}>
        Reading {name}/…
      </div>
    );
  if (entries.length === 0)
    return (
      <div className="tree-note muted mono" style={{ paddingLeft: indent(depth) }}>
        empty
      </div>
    );

  return (
    <>
      {entries.map((entry) =>
        entry.is_dir ? (
          <DirNode key={entry.rel_path} entry={entry} depth={depth} ctx={ctx} />
        ) : (
          <div
            key={entry.rel_path}
            className={"tree-row tree-file" + (entry.rel_path === ctx.activePath ? " tree-active" : "")}
            style={{ paddingLeft: indent(depth) }}
            onClick={(e) => { if (e.target === e.currentTarget && !ctx.locked) ctx.onOpenFile(entry.rel_path); }}
          >
            <button type="button" className="tree-open" disabled={ctx.locked} title={entry.rel_path} onClick={() => ctx.onOpenFile(entry.rel_path)}>
              <span className="tree-icon" aria-hidden="true">·</span>
              <span className="tree-name mono">{entry.name}</span>
              {ctx.dirtyPaths.has(entry.rel_path) && <span className="dirty-mark">•</span>}
            </button>
            <RowActions entry={entry} ctx={ctx} />
          </div>
        ),
      )}
    </>
  );
}

function DirNode({ entry, depth, ctx }: { entry: Entry; depth: number; ctx: TreeContext }) {
  const expanded = ctx.expanded.has(entry.rel_path);
  // Once a folder has been shown open it keeps its listing while collapsed, so
  // re-opening it is instant. A remembered expanded folder lists itself when it
  // first appears, exactly as if the user had just clicked it.
  const [loaded, setLoaded] = useState(expanded);
  const version = ctx.refresh[entry.rel_path] ?? 0;

  useEffect(() => {
    if (expanded) setLoaded(true);
  }, [expanded]);

  // A bump for this folder (something was created, moved or trashed inside it)
  // re-lists it only if it has a listing; a collapsed, never-listed folder
  // lists itself fresh when it is next expanded. Expanding is App's decision.
  useEffect(() => {
    if (version > 0) setLoaded(true);
  }, [version]);

  // Refresh: a collapsed folder forgets its stale listing instead of re-reading
  // it now, so only the place root and expanded folders touch the disk.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useEffect(() => {
    if (ctx.reload > 0 && !expandedRef.current) setLoaded(false);
  }, [ctx.reload]);

  const toggle = () => {
    ctx.onToggleDir(entry.rel_path);
    setLoaded(true);
    ctx.onSelectDir(entry.rel_path);
  };

  return (
    <>
      <div
        className={"tree-row tree-dir" + (entry.rel_path === ctx.selectedDir ? " tree-selected" : "")}
        style={{ paddingLeft: indent(depth) }}
        onClick={(e) => { if (e.target === e.currentTarget && !ctx.locked) toggle(); }}
      >
        <button type="button" className="tree-open" disabled={ctx.locked} aria-expanded={expanded} title={entry.rel_path} onClick={toggle}>
          <span className="tree-icon" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span className="tree-name mono">{entry.name}</span>
        </button>
        <RowActions entry={entry} ctx={ctx} />
      </div>
      {loaded && (
        <div hidden={!expanded} className="tree-children">
          <DirContents relPath={entry.rel_path} depth={depth + 1} active={expanded} ctx={ctx} />
        </div>
      )}
    </>
  );
}

/** Pointer and keyboard actions on a tree row. Clicks must not open or toggle the row. */
function RowActions({ entry, ctx }: { entry: Entry; ctx: TreeContext }) {
  return (
    <span className="tree-actions">
      <button
        type="button"
        disabled={ctx.locked}
        className="tree-action"
        title="Rename"
        aria-label={`rename ${entry.name}`}
        onClick={(e) => {
          e.stopPropagation();
          ctx.onRename(entry);
        }}
      >
        ✎
      </button>
      <button
        type="button"
        disabled={ctx.locked}
        className="tree-action"
        title="Move to folder"
        aria-label={`move ${entry.name}`}
        onClick={(e) => {
          e.stopPropagation();
          ctx.onMove(entry);
        }}
      >
        ⤴
      </button>
      <button
        type="button"
        disabled={ctx.locked}
        className="tree-action"
        title="Move to Trash"
        aria-label={`Move ${entry.name} to Trash`}
        onClick={(e) => {
          e.stopPropagation();
          ctx.onDelete(entry);
        }}
      >
        🗑
      </button>
    </span>
  );
}

function indent(depth: number): number {
  return 10 + depth * 16;
}
