import { useEffect, useRef, useState } from "react";
import { log } from "./log";
import { drawSelection } from "./VisualView";
import { invalidFailure, parseView, readFailure, type Landmark, type ViewFailure } from "./viewSanitize";
import { readFile } from "./subject";
import { KIND_TEXT } from "./overviewFacts";
import { ROLES, rootViewPath, type Role, type RootListing } from "./places";
import { rootViewCurrent, type RootMap } from "./rootMap";
import type { BuildState } from "./viewBuild";
import type { GitKind } from "./launch";
import { modelMissingText, RAVEN } from "./creatures";

interface RootViewProps {
  /** The current root listing: what a selected node resolves to right now. */
  listing: RootListing;
  /** The `.git` kind per work place, for the inspector's KIND line. */
  git: ReadonlyMap<string, GitKind>;
  /** Work places whose own Visual View exists: what `Open visual view` needs. */
  views: ReadonlySet<string>;
  /** The saved `views/.root/view.json` as Home read it, for the inspector's facts and the stale check; null when absent or unreadable. */
  saved: RootMap | null;
  /** Explicit Refresh counter (and a bump after a build): a bump re-reads the map file. */
  reload: number;
  locked: boolean;
  /** What the build queue knows about the root view this session, or null. */
  build: BuildState | null;
  onOpenPlace: (name: string) => void;
  onOpenView: (name: string) => void;
  onOpenRole: (role: Role) => void;
  onRebuild: () => void;
  onRefresh: () => void;
}

/** The named copy for the root view's build state, or null when there is nothing to say. */
export function rootBuildCopy(build: BuildState | null): { text: string; error: boolean } | null {
  if (build === null) return { text: `No root view yet. Run ${RAVEN.name} to build one.`, error: false };
  switch (build.kind) {
    case "queued":
    case "building":
      return { text: "Building root visual view…", error: false };
    case "built":
      return null;
    case "failed":
      if (build.reason === "unavailable") return { text: "Local model unavailable.", error: true };
      if (build.reason === "not_installed") return { text: modelMissingText(RAVEN).text, error: true };
      return { text: "Root visual view could not be built.", error: true };
  }
}

/** What a selected node of the root map is right now: a listed work place, a present knowledge role, or something no longer in the root. */
export type RootNode = { kind: "work"; name: string } | { kind: "know"; role: Role; label: string } | { kind: "gone"; name: string };

/** Resolve a landmark of the root map against the current listing by the folder it carries as its path. */
export function resolveRootNode(landmark: Landmark, listing: RootListing): RootNode {
  const path = landmark.paths[0] ?? "";
  if (listing.work.some((p) => p.name === path)) return { kind: "work", name: path };
  const role = ROLES.find((r) => r.folder === path.toLowerCase());
  if (role && listing.roles[role.role].kind === "present") return { kind: "know", role: role.role, label: role.label };
  return { kind: "gone", name: landmark.name };
}

type State = { kind: "loading" } | { kind: "ready"; svg: SVGSVGElement; landmarks: Landmark[] } | { kind: "failed"; failure: ViewFailure };

/**
 * The Home canvas: the root Visual View (`views/.root/map.svg`) rendered
 * through the same sanitizer as every Visual View, with a small inspector
 * that enters the selected place. One bounded read per open, Refresh or
 * finished build; no model is ever called from here. A missing map shows
 * the build state in its place; the drawing on screen stays while a
 * rebuild waits, runs or fails.
 */
export function RootView({ listing, git, views, saved, reload, locked, build, onOpenPlace, onOpenView, onOpenRole, onRebuild, onRefresh }: RootViewProps) {
  const relPath = rootViewPath();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: State;
      try {
        const file = await readFile(relPath);
        const parsed = parseView(file.content);
        if (parsed.kind === "ok") next = { kind: "ready", svg: parsed.svg, landmarks: parsed.landmarks };
        else {
          next = { kind: "failed", failure: invalidFailure(parsed.reason, relPath) };
          void log("error", `root view: ${parsed.reason}`);
        }
      } catch (err) {
        const failure = readFailure(err, relPath);
        next = { kind: "failed", failure };
        if (failure.kind !== "missing") void log("error", `root view: ${String(err)}`);
      }
      if (cancelled) return;
      setState(next);
      setSelected((current) => (current !== null && next.kind === "ready" && next.landmarks.some((l) => l.name === current) ? current : null));
    })();
    return () => {
      cancelled = true;
    };
  }, [relPath, reload]);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    if (state.kind !== "ready") {
      el.replaceChildren();
      return;
    }
    el.replaceChildren(state.svg);
    for (const group of Array.from(state.svg.querySelectorAll("[data-landmark]"))) {
      const name = (group.getAttribute("data-landmark") ?? "").trim();
      if (name === "") continue;
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", name);
    }
  }, [state]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    drawSelection(state.svg, selected);
  }, [state, selected]);

  const landmarkOf = (target: EventTarget | null): string | null => {
    const el = target instanceof Element ? target.closest("[data-landmark]") : null;
    const name = el?.getAttribute("data-landmark")?.trim() ?? "";
    return name === "" ? null : name;
  };

  const landmark = state.kind === "ready" && selected !== null ? (state.landmarks.find((l) => l.name === selected) ?? null) : null;
  const node = landmark === null ? null : resolveRootNode(landmark, listing);
  const savedPlace = node?.kind === "work" ? (saved?.places.find((p) => p.placeId === node.name) ?? null) : null;
  const building = build !== null && (build.kind === "queued" || build.kind === "building");
  const copy = rootBuildCopy(build);
  const stale = state.kind === "ready" && (saved === null || !rootViewCurrent(saved, listing));
  // With a drawing on screen the build state, else the stale state, is a header readout; the drawing stays.
  const headerCopy = state.kind !== "ready" ? null : build !== null && build.kind !== "built" ? copy : stale ? { text: "Root view needs rebuild.", error: false } : null;

  return (
    <div className="view-tab root-view">
      <div className="surface-header">
        <span className="mono muted surface-path" title={relPath}>
          ◫ {relPath}
        </span>
        {headerCopy !== null && (
          <span className={"view-build-status" + (headerCopy.error ? " error" : " muted")} role="status">
            {headerCopy.text}
          </span>
        )}
        <button type="button" className="chip" onClick={onRefresh} disabled={locked}>
          Refresh
        </button>
        <button type="button" className="chip" onClick={onRebuild} disabled={locked || building} title={RAVEN.job}>
          Run {RAVEN.name}
        </button>
      </div>
      <div className="view-columns">
        <div className="view-main">
          {state.kind === "loading" && <div className="view-state muted">Opening root view…</div>}
          {state.kind === "failed" && state.failure.kind === "missing" && (
            <div className="view-state" role="status">
              {copy !== null ? (
                <div className={copy.error ? "error" : "muted"}>{copy.text}</div>
              ) : (
                <div className="muted">No root view yet. Run Raven to build one.</div>
              )}
              {!building && (
                <button type="button" className="chip" onClick={onRefresh} disabled={locked}>
                  Refresh
                </button>
              )}
            </div>
          )}
          {state.kind === "failed" && state.failure.kind !== "missing" && (
            <div className="view-state" role="status">
              <div className="error">{state.failure.text}</div>
              <button type="button" className="chip" onClick={onRefresh} disabled={locked}>
                Refresh
              </button>
            </div>
          )}
          <div
            ref={canvas}
            className="view-canvas"
            hidden={state.kind !== "ready"}
            onClick={(e) => {
              const name = landmarkOf(e.target);
              if (name === null || locked) return;
              setSelected(name);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              const name = landmarkOf(e.target);
              if (name === null || locked) return;
              e.preventDefault();
              setSelected(name);
            }}
          />
        </div>
        <aside className="view-inspector" aria-label="place">
          {node === null || landmark === null ? (
            <div className="muted">Select a place to see what it holds.</div>
          ) : node.kind === "gone" ? (
            <>
              <div className="view-landmark-name mono strong">{node.name}</div>
              <div className="view-landmark-note muted">{node.name} is not in the root right now. Refresh, then rebuild the root view.</div>
            </>
          ) : node.kind === "know" ? (
            <>
              <div className="view-landmark-name mono strong">{node.label}</div>
              <div className="view-landmark-note">knowledge place</div>
              <div className="overview-actions">
                <button type="button" className="chip chip-primary" disabled={locked} onClick={() => onOpenRole(node.role)}>
                  Open
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="view-landmark-name mono strong">{node.name}</div>
              <dl className="spec root-spec">
                <dt className="tag">KIND</dt>
                <dd>
                  <span className={"swatch " + (git.get(node.name) === "repo" ? "swatch-git" : "swatch-folder")} aria-hidden="true" /> {KIND_TEXT[git.get(node.name) ?? "none"]}
                </dd>
              </dl>
              {(savedPlace?.description ?? landmark.note) !== "" && <div className="view-landmark-note">{savedPlace?.description ?? landmark.note}</div>}
              {savedPlace !== null && savedPlace.highlights.length > 0 && (
                <>
                  <div className="tag view-files-tag">HIGHLIGHTS</div>
                  <div className="root-highlights">
                    {savedPlace.highlights.map((h) => (
                      <div key={h.id} className="root-highlight">
                        ▪ {h.label}
                      </div>
                    ))}
                  </div>
                </>
              )}
              <div className="overview-actions">
                <button type="button" className="chip chip-primary" disabled={locked} onClick={() => onOpenPlace(node.name)}>
                  Enter place
                </button>
                {views.has(node.name) && (
                  <button type="button" className="chip" disabled={locked} onClick={() => onOpenView(node.name)}>
                    Open visual view
                  </button>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
