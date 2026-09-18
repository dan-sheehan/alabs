import { useEffect, useRef, useState } from "react";
import { log } from "./log";
import { invalidFailure, parseView, readFailure, SVG_NS, type Landmark, type ViewFailure } from "./viewSanitize";
import { readFile } from "./subject";
import type { BuildState } from "./viewBuild";
import { modelMissingText, RAVEN } from "./creatures";

interface VisualViewProps {
  /** Root-relative path of the view file, `views/<place>/map.svg`. */
  relPath: string;
  placeName: string;
  /** Explicit Refresh counter; a bump re-reads and re-checks the file. */
  reload: number;
  locked: boolean;
  /** True while this tab is the one on screen: the selection outline needs a rendered drawing to measure. */
  shown: boolean;
  /** A landmark file: the shared boundary-checked open-path handler decides. */
  onOpenPath: (relPath: string) => void;
  /** `Open source`: the Editor tab for the view file itself. */
  onOpenSource: () => void;
  onRefresh: () => void;
  /** What the build queue knows about this place this session, or null. */
  build: BuildState | null;
  /** `Run Raven`: queue a build or rebuild by Raven; the existing map stays until the new one passed every check. */
  onRebuild: () => void;
}

/**
 * The named copy for a build state (DESIGN.md 6.8), or null when there is
 * nothing to say. A missing map with nothing known says to run Raven; a
 * run whose model Ollama does not have names that model.
 */
export function buildCopy(build: BuildState | null): { text: string; error: boolean; hint: string | null } | null {
  if (build === null) return { text: "No visual view yet.", error: false, hint: `Run ${RAVEN.name} to build one.` };
  switch (build.kind) {
    case "queued":
      return { text: "Waiting to build the visual view…", error: false, hint: null };
    case "building":
      return { text: "Building visual view…", error: false, hint: null };
    case "built":
      return null;
    case "failed":
      if (build.reason === "unavailable") return { text: "Local model unavailable.", error: true, hint: `Start the local model, then run ${RAVEN.name} again.` };
      if (build.reason === "not_installed") return { ...modelMissingText(RAVEN), error: true };
      return { text: "Visual view could not be built.", error: true, hint: null };
  }
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; svg: SVGSVGElement; landmarks: Landmark[] }
  | { kind: "failed"; failure: ViewFailure };

/** The selection outline alabs draws inside the selected group: the mechanism's 2px `--pos` outline (DESIGN.md 6.8). */
const SELECTION_MARK = "data-alabs";

function landmarkElement(svg: SVGSVGElement, name: string): Element | null {
  return Array.from(svg.querySelectorAll("[data-landmark]")).find((el) => (el.getAttribute("data-landmark") ?? "").trim() === name) ?? null;
}

/** Mark the selected group and outline its box. Nothing in the file is changed; the outline is removed before the next one is drawn. */
export function drawSelection(svg: SVGSVGElement, name: string | null) {
  for (const old of Array.from(svg.querySelectorAll(`[${SELECTION_MARK}="selection"]`))) old.remove();
  for (const el of Array.from(svg.querySelectorAll("[data-selected]"))) el.removeAttribute("data-selected");
  if (name === null) return;
  const group = landmarkElement(svg, name);
  if (!group) return;
  group.setAttribute("data-selected", "true");
  const measurable = group as Element & { getBBox?: () => { x: number; y: number; width: number; height: number } };
  if (typeof measurable.getBBox !== "function") return;
  const box = measurable.getBBox();
  if (box.width === 0 && box.height === 0) return;
  const rect = group.ownerDocument.createElementNS(SVG_NS, "rect");
  rect.setAttribute(SELECTION_MARK, "selection");
  rect.setAttribute("x", String(box.x - 3));
  rect.setAttribute("y", String(box.y - 3));
  rect.setAttribute("width", String(box.width + 6));
  rect.setAttribute("height", String(box.height + 6));
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke", "#4ea1ff");
  rect.setAttribute("stroke-width", "2");
  rect.setAttribute("vector-effect", "non-scaling-stroke");
  rect.setAttribute("pointer-events", "none");
  group.appendChild(rect);
}

/**
 * The Visual View tab (DESIGN.md 6.8): the sanitized drawing on the left,
 * a 300px inspector on the right, header with the view path, `Open source`
 * and `Refresh`. One bounded read per open or Refresh; the text passes
 * `parseView` before it enters the DOM. Selection lives here, so it
 * survives a switch to another tab or place while the component stays
 * mounted. Every failure replaces the drawing with its named state and
 * keeps the tab and the inspector column; nothing is ever blank.
 */
export function VisualView({ relPath, placeName, reload, locked, shown, onOpenPath, onOpenSource, onRefresh, build, onRebuild }: VisualViewProps) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);

  // The read and the check. A Refresh keeps the current drawing on screen
  // until the new one is ready; a failure replaces it.
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
          void log("error", `view ${relPath}: ${parsed.reason}`);
        }
      } catch (err) {
        next = { kind: "failed", failure: readFailure(err, relPath) };
        void log("error", `view ${relPath}: ${String(err)}`);
      }
      if (cancelled) return;
      setState(next);
      // A selection survives a reload only while its landmark still exists.
      setSelected((current) => (current !== null && next.kind === "ready" && next.landmarks.some((l) => l.name === current) ? current : null));
    })();
    return () => {
      cancelled = true;
    };
  }, [relPath, reload]);

  // The sanitized drawing is placed once per read; landmarks get their
  // keyboard and accessibility handles here, outside the file's content.
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

  // The selected treatment, measured only while the drawing is on screen.
  useEffect(() => {
    if (state.kind !== "ready" || !shown) return;
    drawSelection(state.svg, selected);
  }, [state, selected, shown]);

  const landmarkOf = (target: EventTarget | null): string | null => {
    const el = target instanceof Element ? target.closest("[data-landmark]") : null;
    const name = el?.getAttribute("data-landmark")?.trim() ?? "";
    return name === "" ? null : name;
  };

  const landmark = state.kind === "ready" && selected !== null ? (state.landmarks.find((l) => l.name === selected) ?? null) : null;
  const building = build !== null && (build.kind === "queued" || build.kind === "building");
  const copy = buildCopy(build) ?? (state.kind === "failed" && state.failure.kind === "missing" ? buildCopy(null) : null);
  // With a drawing on screen the build state is a header readout; the drawing stays until a rebuilt map passed every check.
  const headerCopy = state.kind === "ready" && build !== null && build.kind !== "built" ? copy : null;

  return (
    <div className="view-tab">
      <div className="surface-header">
        <span className="mono muted surface-path" title={relPath}>
          ◫ {relPath}
        </span>
        {headerCopy !== null && (
          <span className={"view-build-status" + (headerCopy.error ? " error" : " muted")} role="status">
            {headerCopy.text}
          </span>
        )}
        <button type="button" className="chip" onClick={onOpenSource} disabled={locked}>
          Open source
        </button>
        <button type="button" className="chip" onClick={onRefresh} disabled={locked}>
          Refresh
        </button>
        <button type="button" className="chip" onClick={onRebuild} disabled={locked || building} title={RAVEN.job}>
          Run {RAVEN.name}
        </button>
      </div>
      <div className="view-columns">
        <div className="view-main">
          {state.kind === "loading" && <div className="view-state muted">Opening view…</div>}
          {state.kind === "failed" && state.failure.kind === "missing" && copy !== null && (
            <div className="view-state" role="status">
              <div className={copy.error ? "error" : "muted"}>{copy.text}</div>
              {copy.hint !== null && <div className="muted view-state-hint">{copy.hint}</div>}
              {!building && (
                <button type="button" className="chip" onClick={onRefresh} disabled={locked}>
                  Refresh
                </button>
              )}
            </div>
          )}
          {state.kind === "failed" && (state.failure.kind !== "missing" || copy === null) && (
            <div className="view-state" role="status">
              <div className="error">{state.failure.text}</div>
              {state.failure.kind === "missing" && (
                <div className="muted view-state-hint">
                  {placeName} has no Visual View file. Put {relPath} inside the alabs root, then Refresh.
                </div>
              )}
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
        <aside className="view-inspector" aria-label="landmark">
          {landmark === null ? (
            <div className="muted">Select a landmark to see its real files.</div>
          ) : (
            <>
              <div className="view-landmark-name mono strong">{landmark.name}</div>
              {landmark.note !== "" && <div className="view-landmark-note">{landmark.note}</div>}
              <div className="tag view-files-tag">FILES</div>
              <div className="view-files">
                {landmark.paths.length === 0 && landmark.badPaths.length === 0 && <div className="muted">none listed</div>}
                {landmark.paths.map((path) => (
                  <button key={path} type="button" className="navlink view-file" title={path} disabled={locked} onClick={() => onOpenPath(path)}>
                    <span className="ltr">{path} →</span>
                  </button>
                ))}
                {landmark.badPaths.map((path) => (
                  <div key={`bad:${path}`} className="view-file view-file-bad muted mono" title={path}>
                    <span className="ltr">{path} · not a usable path</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
