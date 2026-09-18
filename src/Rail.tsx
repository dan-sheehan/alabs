import { useEffect, useRef, type ReactNode } from "react";
import { knowKey, ROLES, workKey, type Role, type RootListing, type ScopeKey } from "./places";
import { roleConflictText } from "./notices";
import type { GitKind } from "./launch";
import type { PlaceStatus } from "./scopeState";
import type { RootInfo } from "./subject";

/** A live scope as the rail needs to know it: what it is bound to and whether that folder is still in the root. */
export interface LivePlace {
  key: ScopeKey;
  kind: "work" | "know";
  /** Root-relative folder the scope is bound to. */
  prefix: string;
  role: Role | null;
  status: PlaceStatus;
}

interface RailProps {
  root: RootInfo | null;
  listing: RootListing | null;
  /** The `.git` kind per work place from Home's check, for the kind swatch. */
  repos: ReadonlyMap<string, GitKind> | null;
  /** Every live work and knowledge scope, so a missing place stays listed and a conflicted role stays enterable. */
  live: readonly LivePlace[];
  activeKey: ScopeKey;
  /** Remembered active work place, shown with the position dot when it is not the current place. */
  activeWork: string | null;
  /** True during a restore or root change: every row is inert. */
  locked: boolean;
  /**
   * False when the runtime owns the root: one process, one folder, settled
   * before the page loaded. The footer then says so rather than offering a
   * picker that can only refuse.
   */
  canChangeRoot: boolean;
  onHome: () => void;
  onOpenPlace: (name: string) => void;
  /** Enter a knowledge place that exists (or already has a live scope). */
  onOpenRole: (role: Role) => void;
  /** Click on a not-created knowledge row: create the default folder. */
  onCreateRole: (role: Role) => void;
  onChangeRoot: () => void;
}

/** The permanent left column: where can I go. */
export function Rail({ root, listing, repos, live, activeKey, activeWork, locked, canChangeRoot, onHome, onOpenPlace, onOpenRole, onCreateRole, onChangeRoot }: RailProps) {
  const nav = useRef<HTMLElement | null>(null);
  // On place change the current row is scrolled into view (only the WORK list can scroll).
  useEffect(() => {
    nav.current?.querySelector(".rail-work .rail-current")?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);
  const row = (
    id: string,
    key: ScopeKey | null,
    className: string,
    onClick: (() => void) | undefined,
    title: string,
    children: ReactNode,
  ) => (
    <div
      key={id}
      className={"rail-row" + (key !== null && key === activeKey ? " rail-current" : "") + (onClick ? "" : " rail-inert") + className}
      role={onClick ? "button" : undefined}
      tabIndex={onClick && !locked ? 0 : -1}
      title={title}
      onClick={locked ? undefined : onClick}
      onKeyDown={(e) => {
        if (!locked && onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </div>
  );

  /** Work rows: every listed place plus every live work scope whose folder is gone, alphabetical. */
  const workRows = (() => {
    if (!listing) return [];
    const rows = listing.work.map((p) => ({ name: p.name, missing: false }));
    for (const scope of live) {
      if (scope.kind === "work" && scope.status === "missing" && !rows.some((r) => r.name === scope.prefix)) {
        rows.push({ name: scope.prefix, missing: true });
      }
    }
    rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
    return rows;
  })();

  return (
    <nav ref={nav} className={"rail" + (locked ? " rail-locked" : "")} role="navigation" aria-label="places">
      <div className="rail-brand">
        <span className="rail-app">alabs</span>
        <span className="tag">PLACES</span>
      </div>
      {row("home", "home", " rail-home", onHome, "Home", <span className="rail-name">Home</span>)}
      {root && listing && (
        <>
          <div className="rail-section">
            <span className="tag">WORK</span>
          </div>
          <div className="rail-work">
            {workRows.map((place) =>
              row(
                `work:${place.name}`,
                workKey(place.name),
                place.missing ? " rail-missing" : "",
                () => onOpenPlace(place.name),
                place.missing ? `${place.name} is not in ${root.path} right now. Your open files are still here.` : place.name,
                <>
                  <span
                    className={"swatch " + (place.missing ? "swatch-missing swatch-error" : repos?.get(place.name) === "repo" ? "swatch-git" : "swatch-folder")}
                    aria-hidden="true"
                  />
                  <span className="rail-name mono">{place.name}</span>
                  {!place.missing && repos?.get(place.name) === "repo" && <span className="tag kind-tag">git</span>}
                  {place.missing && <span className="rail-suffix mono error">missing</span>}
                  {!place.missing && activeWork === place.name && workKey(place.name) !== activeKey && (
                    <span className="active-dot" title="active work" aria-label="active work" />
                  )}
                </>,
              ),
            )}
          </div>
          <div className="rail-section">
            <span className="tag">KNOWLEDGE</span>
          </div>
          {ROLES.map(({ role, label }) => {
            const state = listing.roles[role];
            const scope = live.find((s) => s.kind === "know" && s.role === role);
            const id = `know:${role}`;
            const key = knowKey(role);
            // A live scope keeps its row enterable whatever the listing says now.
            if (scope && scope.status === "missing") {
              return row(
                id,
                key,
                " rail-know rail-missing",
                () => onOpenRole(role),
                `${scope.prefix} is not in ${root.path} right now. Your open files are still here.`,
                <>
                  <span className="swatch swatch-missing swatch-error" aria-hidden="true" />
                  <span className="rail-name">{label}</span>
                  <span className="rail-suffix mono error">missing</span>
                </>,
              );
            }
            if (state.kind === "conflict") {
              const enterable = scope !== undefined;
              return row(
                id,
                key,
                " rail-know",
                enterable ? () => onOpenRole(role) : undefined,
                roleConflictText(label, state.names),
                <>
                  <span className={"swatch " + (enterable ? "swatch-know" : "swatch-missing")} aria-hidden="true" />
                  <span className="rail-name">{label}</span>
                  <span className="rail-suffix mono error">conflict</span>
                </>,
              );
            }
            if (state.kind === "present" || scope) {
              return row(
                id,
                key,
                " rail-know",
                () => onOpenRole(role),
                scope?.prefix ?? (state.kind === "present" ? state.name : label),
                <>
                  <span className="swatch swatch-know" aria-hidden="true" />
                  <span className="rail-name">{label}</span>
                </>,
              );
            }
            return row(
              id,
              null,
              " rail-know rail-not-created",
              () => onCreateRole(role),
              `${label} is not created. Click to create ${role}/ inside the root.`,
              <>
                <span className="swatch swatch-missing" aria-hidden="true" />
                <span className="rail-name">{label}</span>
                <span className="rail-suffix mono">not created</span>
              </>,
            );
          })}
        </>
      )}
      <div className="rail-footer">
        {root && (
          <>
            <span className="tag">ROOT</span>
            <div className="rail-root mono" title={root.path}>
              <span className="ltr">{root.path}</span>
            </div>
            {canChangeRoot ? (
              <button type="button" className="navlink" onClick={onChangeRoot} disabled={locked}>
                Change root…
              </button>
            ) : (
              <div className="rail-fixed muted" title="Stop alabs with Control-C in its terminal and start it again with another path.">
                One process, one folder
              </div>
            )}
          </>
        )}
      </div>
    </nav>
  );
}
