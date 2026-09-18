import { useEffect, useRef, useState } from "react";
import { displayPath } from "./places";
import { cancelSearch, nextSearchId, onSearchResults, searchScope, type SearchResult, type SearchSummary } from "./subject";

interface SearchProps {
  /** The place being searched: its root-relative folder and display name. */
  prefix: string;
  locked?: boolean;
  placeName: string;
  /** Called with a filename hit (no line) or a content hit (1-based line). */
  onOpenResult: (relPath: string, line: number | null) => void;
  /** Escape or Clear: leave search and show the tree again. */
  onClose: () => void;
  /** Bumped by Cmd+Shift+F while the search is already open: focus the input again. */
  focusToken: number;
}

interface SearchRun {
  id: number;
  query: string;
  results: SearchResult[];
  summary: SearchSummary | null;
  error: string | null;
}


/**
 * On-demand search inside one place. A search runs only when the user presses
 * Enter with a non-empty query, and its results live only here until the
 * next search or Clear. It never leaves the place showing; nothing runs in
 * the background.
 */
export function Search({ prefix, placeName, onOpenResult, onClose, focusToken, locked = false }: SearchProps) {
  const [query, setQuery] = useState("");
  const [run, setRun] = useState<SearchRun | null>(null);
  const requestRef = useRef<{ id: number; unlisten: (() => void) | null } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (focusToken > 0) inputRef.current?.focus();
  }, [focusToken]);

  // An id owns both the listener and the native walk. Disposing an old
  // component must never cancel a newer search (including Raven's search).
  const stop = () => {
    const request = requestRef.current;
    requestRef.current = null;
    if (!request) return;
    request.unlisten?.();
    void cancelSearch(request.id).catch(() => {});
  };

  useEffect(() => {
    setRun(null);
    setQuery("");
    return stop;
  }, [prefix]);

  const start = async () => {
    const text = query.trim();
    if (!text || locked) return;
    stop();
    const id = nextSearchId();
    const request = { id, unlisten: null as (() => void) | null };
    requestRef.current = request;
    const current = () => requestRef.current === request;
    setRun({ id, query: text, results: [], summary: null, error: null });
    try {
      const unlisten = await onSearchResults((batch) => {
        if (!current() || batch.search_id !== id) return;
        setRun((r) => r && r.id === id ? { ...r, results: [...r.results, ...batch.results] } : r);
      });
      if (!current()) { unlisten(); return; }
      request.unlisten = unlisten;
      // Subscribe first: a small native search can emit every hit immediately.
      const summary = await searchScope(text, id, prefix);
      if (current()) setRun((r) => r && r.id === id ? { ...r, summary } : r);
    } catch (err) {
      if (current()) setRun((r) => r && r.id === id ? { ...r, error: String(err) } : r);
    }
  };

  const clear = () => {
    stop();
    setRun(null);
    setQuery("");
    onClose();
  };

  const count = run?.results.length ?? 0;
  return (
    <div className="search">
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <input
          ref={inputRef}
          disabled={locked}
          className="input search-input mono"
          type="search"
          autoFocus
          placeholder={`Search in ${placeName}`}
          aria-label={`Search in ${placeName}`}
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value.trim()) { stop(); setRun(null); }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              clear();
            }
          }}
        />
      </form>
      {run && (
        <div className="search-results" role="list" aria-label={`results for ${run.query}`}>
          <div className="search-note muted">
            {run.error
              ? `Search failed: ${run.error}`
              : run.summary === null
                ? "Searching…"
                : run.summary.cancelled
                  ? "Search replaced"
                  : count === 0
                    ? `No matches in ${placeName}`
                    : `${count} ${count === 1 ? "match" : "matches"}${run.summary.truncated ? " (stopped at limit)" : ""}`}
          </div>
          {run.results.map((hit, i) => (
            <div
              key={`${hit.rel_path}:${hit.line ?? "name"}:${i}`}
              role="listitem"
            >
              <button
                type="button"
                disabled={locked}
                className="search-hit"
                title={hit.line === null ? hit.rel_path : `${hit.rel_path}:${hit.line}`}
                onClick={() => onOpenResult(hit.rel_path, hit.line)}
              >
                <span className="search-hit-path mono">
                  {displayPath(hit.rel_path, prefix)}
                  {hit.line !== null && <span className="muted">:{hit.line}</span>}
                </span>
                {hit.text !== null && <span className="search-hit-text mono muted">{hit.text}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
