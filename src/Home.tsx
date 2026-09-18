import { ROLES, type Role } from "./places";
import { roleConflictText } from "./notices";
import { RootView } from "./RootView";
import type { HomeData } from "./launch";
import type { RootInfo } from "./subject";
import type { BuildState } from "./viewBuild";

/**
 * The compact Visual View mark on a Home row: `◫ view` when the map
 * exists; otherwise what the build queue knows this session; otherwise
 * that there is no view yet (Raven can build one from the Visual View
 * tab). Every mark is a target that opens the place's Visual View tab.
 */
export function viewSuffix(hasView: boolean, build: BuildState | null): string | null {
  if (hasView) return "◫ view";
  if (build !== null && (build.kind === "queued" || build.kind === "building")) return "◫ building…";
  if (build !== null && build.kind === "failed") return build.reason === "unavailable" ? "◫ unavailable" : "◫ not built";
  return "◫ no view";
}

interface HomeBodyProps {
  root: RootInfo;
  home: HomeData | null;
  loading: boolean;
  activeWork: string | null;
  /** Live counts of the active work place's scope, or null when it has no live scope yet. */
  activeCounts: { tabs: number; unsaved: number } | null;
  locked: boolean;
  /** What the Visual View build queue knows about the root view this session. */
  rootBuild: BuildState | null;
  /** Bumped by Refresh and by a finished root build: the root map is re-read. */
  rootReload: number;
  onOpenPlace: (name: string) => void;
  /** Open the place and its Visual View tab. */
  onOpenView: (name: string) => void;
  onOpenRole: (role: Role) => void;
  onRebuildRoot: () => void;
  onRefresh: () => void;
}

/** The Home canvas: the ACTIVE WORK row, then the root Visual View. Reads only the root map file, through `RootView`. */
export function HomeBody({ root, home, loading, activeWork, activeCounts, locked, rootBuild, rootReload, onOpenPlace, onOpenView, onOpenRole, onRebuildRoot, onRefresh }: HomeBodyProps) {
  if (!home) {
    return <div className="home">{loading ? <div className="home-reading muted">Reading {root.path}…</div> : null}</div>;
  }
  const work = home.listing.work;
  const activePlace = activeWork !== null && work.some((p) => p.name === activeWork) ? activeWork : null;
  return (
    <div className="home">
      {activePlace !== null && (
        <div className="active-work">
          <span className="tag">ACTIVE WORK</span>
          <span className="active-dot" aria-hidden="true" />
          <span className="active-work-name mono strong" title={activePlace}>{activePlace}</span>
          {activeCounts && (
            <span className="active-work-counts muted">
              {activeCounts.tabs} {activeCounts.tabs === 1 ? "tab" : "tabs"} · {activeCounts.unsaved} unsaved
            </span>
          )}
          <button type="button" className="chip chip-primary active-return" title={`Return to ${activePlace}`} disabled={locked} onClick={() => onOpenPlace(activePlace)}>
            Return to {activePlace}
          </button>
        </div>
      )}
      <RootView
        listing={home.listing}
        git={home.git}
        views={home.views}
        saved={home.rootView.saved}
        reload={rootReload}
        locked={locked}
        build={rootBuild}
        onOpenPlace={onOpenPlace}
        onOpenView={onOpenView}
        onOpenRole={onOpenRole}
        onRebuild={onRebuildRoot}
        onRefresh={onRefresh}
      />
    </div>
  );
}

interface HomeSidebarProps {
  root: RootInfo;
  home: HomeData | null;
  locked: boolean;
  activeWork: string | null;
  /** Knowledge roles with a live scope this session: a conflicted one stays enterable. */
  liveRoles: ReadonlySet<Role>;
  /** What the Visual View build queue knows per work place this session. */
  builds: ReadonlyMap<string, BuildState>;
  onRefresh: () => void;
  onOpenPlace: (name: string) => void;
  onOpenView: (name: string) => void;
  onOpenRole: (role: Role) => void;
  onNewFolder: () => void;
  onCreateRole: (role: Role) => void;
}

/**
 * The middle column on Home: the root's controls and the dense list of
 * every current place. `alabs root` with Refresh, the counts, WORK with one
 * 26px row per work place (kind swatch, name, the active-work dot, the
 * Visual View mark) and `+ New folder`, KNOWLEDGE with Context, Wiki and
 * Definitions, then the intake hint. No path here; the rail footer carries it.
 */
export function HomeSidebar({ root, home, locked, activeWork, liveRoles, builds, onRefresh, onOpenPlace, onOpenView, onOpenRole, onNewFolder, onCreateRole }: HomeSidebarProps) {
  const work = home?.listing.work ?? [];
  const present = home ? ROLES.filter(({ role }) => home.listing.roles[role].kind === "present").length : 0;
  const row = (key: string, className: string, title: string, onClick: (() => void) | undefined, children: React.ReactNode) => (
    <div
      key={key}
      className={"side-row" + className + (onClick ? "" : " side-inert")}
      role={onClick ? "button" : undefined}
      tabIndex={onClick && !locked ? 0 : -1}
      aria-disabled={onClick ? locked : undefined}
      title={title}
      onClick={locked ? undefined : onClick}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && !locked && onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </div>
  );
  return (
    <div className="home-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title strong">alabs root</span>
        <button type="button" className="chip" onClick={onRefresh} disabled={locked}>
          Refresh
        </button>
      </div>
      {home && (
        <div className="sidebar-facts muted">
          {work.length} work {work.length === 1 ? "folder" : "folders"} · {present} of {ROLES.length} knowledge folders
        </div>
      )}
      {home && (
        <>
          <div className="side-section">
            <span className="tag">WORK</span>
          </div>
          {work.length === 0 && <div className="side-empty">No work here yet. Move, copy, or clone folders into {root.path}, then Refresh.</div>}
          {work.map((place) => {
            const isRepo = home.git.get(place.name) === "repo";
            const suffix = viewSuffix(home.views.has(place.name), builds.get(place.name) ?? null);
            return row(
              `work:${place.name}`,
              "",
              place.name,
              () => onOpenPlace(place.name),
              <>
                <span className={"swatch " + (isRepo ? "swatch-git" : "swatch-folder")} aria-hidden="true" />
                <span className="side-name mono">{place.name}</span>
                {isRepo && <span className="tag kind-tag">git</span>}
                {activeWork === place.name && <span className="active-dot" title="active work" aria-label="active work" />}
                {suffix !== null && (
                  <button
                    type="button"
                    className="side-suffix mono"
                    title={`Open the visual view of ${place.name}`}
                    disabled={locked}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenView(place.name);
                    }}
                  >
                    {suffix}
                  </button>
                )}
              </>,
            );
          })}
          <button type="button" className="navlink side-new" disabled={locked} onClick={onNewFolder}>
            + New folder
          </button>
          <div className="side-section">
            <span className="tag">KNOWLEDGE</span>
          </div>
          {ROLES.map(({ role, label }) => {
            const state = home.listing.roles[role];
            const enterable = state.kind === "present" || (state.kind === "conflict" && liveRoles.has(role));
            if (enterable) {
              return row(
                `know:${role}`,
                state.kind === "conflict" ? " side-conflict" : "",
                state.kind === "present" ? state.name : roleConflictText(label, state.names),
                () => onOpenRole(role),
                <>
                  <span className="swatch swatch-know" aria-hidden="true" />
                  <span className="side-name">{label}</span>
                  {state.kind === "conflict" && <span className="side-tag mono error">conflict</span>}
                </>,
              );
            }
            if (state.kind === "conflict") {
              return row(
                `know:${role}`,
                " side-conflict",
                roleConflictText(label, state.names),
                undefined,
                <>
                  <span className="swatch swatch-missing" aria-hidden="true" />
                  <span className="side-name">{label}</span>
                  <span className="side-tag mono error">conflict</span>
                </>,
              );
            }
            return row(
              `know:${role}`,
              " side-not-created",
              `${label} is not created. Click to create ${role}/ inside the root.`,
              () => onCreateRole(role),
              <>
                <span className="swatch swatch-missing" aria-hidden="true" />
                <span className="side-name muted">{label}</span>
                <span className="side-tag navlink">create →</span>
              </>,
            );
          })}
        </>
      )}
      <div className="sidebar-hint muted">Bring work in with Finder, Terminal, or a clone, then Refresh.</div>
    </div>
  );
}
