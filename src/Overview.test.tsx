import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OverviewSheetView, type OverviewSheetProps } from "./Overview";
import type { OverviewSheet } from "./overviewFacts";
import type { Entry, GitInspection } from "./subject";

// The sheet is rendered from what was read (`readOverview` is tested in
// overviewFacts.test.ts) with react-dom/server, the harness the App tests
// use. Effects do not run, so the README excerpt's sanitized markup is the
// browser check; the observed facts and every named state are asserted here.

const dir = (name: string): Entry => ({ name, rel_path: `defiance/${name}`, is_dir: true });
const file = (name: string): Entry => ({ name, rel_path: `defiance/${name}`, is_dir: false });
const readAt = new Date(2026, 8, 14, 15, 42);
const now = 1_000_000;

function sheet(entries: Entry[], readme: OverviewSheet["readme"] = null): OverviewSheet {
  return { entries, readme, readAt };
}

function render(overrides: Partial<OverviewSheetProps> = {}): string {
  const props: OverviewSheetProps = {
    sheet: sheet([dir("src"), file("README.md"), file("main.py")], { name: "README.md", relPath: "defiance/README.md", text: "# Defiance\n\nA corpus tool." }),
    prefix: "defiance",
    isWork: true,
    locked: false,
    gitKind: "none",
    git: null,
    hasView: false,
    onOpenView: () => {},
    onOpenTask: () => {},
    onOpenChanges: () => {},
    onOpenTerminal: () => {},
    readmeDirty: false,
    onOpenPath: vi.fn(),
    onRevealDir: vi.fn(),
    onRefresh: vi.fn(),
    onOpenTab: vi.fn(),
    now: () => now,
    ...overrides,
  };
  // React's server renderer separates adjacent text expressions with comment nodes.
  return renderToString(<OverviewSheetView {...props} />)
    .replace(/<!-- -->/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

const facts = (branch: string, last: { subject: string; time: number } | null): GitInspection => ({
  kind: "facts",
  branch: { kind: "ok", value: branch },
  last: { kind: "ok", value: last },
});

describe("Overview sheet: the optional Ask section", () => {
  it("renders ASK LOCAL MODEL only when given the folders (the Wiki place), after TOP LEVEL, with Ask disabled until a question is typed", () => {
    expect(render({ isWork: false })).not.toContain("ASK LOCAL MODEL");
    const html = render({ isWork: false, ask: { rootPath: "/root", folders: { context: "context", wiki: "wiki" }, model: null, onSelectModel: vi.fn() } });
    expect(html.indexOf("TOP LEVEL")).toBeLessThan(html.indexOf("ASK LOCAL MODEL"));
    expect(html).toContain("What do I want to know?");
    expect(html).toContain("reads the saved files in context/ and wiki/");
    expect(html).toMatch(/<button[^>]*class="chip chip-primary"[^>]*disabled=""[^>]*>Ask<\/button>/);
    expect(html).toContain("Choose a local model…");
    expect(html).not.toContain("Thinking");
    // A remembered model shows by name with a change link; nothing is listed until asked.
    const remembered = render({ isWork: false, ask: { rootPath: "/root", folders: { context: null, wiki: "wiki" }, model: "small:1b", onSelectModel: vi.fn() } });
    expect(remembered).toContain("small:1b");
    expect(remembered).toContain(">change<");
    expect(remembered).not.toContain("<select");
  });
});

describe("Overview sheet: observed facts only", () => {
  it("a plain work folder: action row readout, README tag, TOP LEVEL rows, KIND folder and nothing about git", () => {
    const html = render();
    expect(html).toContain("as of 3:42 pm");
    expect(html).toContain("Task…");
    expect(html).toContain("Changes");
    expect(html).toContain("Open in Terminal");
    expect(html).toContain("Refresh");
    expect(html).toContain("README.md · rendered");
    expect(html).toContain("Open README →");
    expect(html).toContain("1 folder · 2 files");
    expect(html).toContain("main.py");
    expect(html).toContain("python");
    expect(html).toContain("open in tree →");
    expect(html).toContain("THIS PLACE");
    expect(html).toContain("folder");
    expect(html).not.toContain("BRANCH");
    expect(html).not.toContain("LAST");
    expect(html).not.toContain("git repository");
    expect(html).not.toContain("VIEW");
  });

  it("no README: the one muted line, so the sheet keeps its shape", () => {
    const html = render({ sheet: sheet([dir("src")]) });
    expect(html).toContain("no README.md");
    expect(html).not.toContain("Open README");
    expect(html).not.toContain("rendered");
  });

  it("an unreadable README is named, never shown as empty", () => {
    const html = render({ sheet: sheet([file("README.md")], { name: "README.md", relPath: "defiance/README.md", text: null }) });
    expect(html).toContain("README.md could not be read.");
    expect(html).toContain("Open README →");
  });

  it("an empty place says what to do next", () => {
    const html = render({ sheet: sheet([]) });
    expect(html).toContain("Nothing here yet. Add files with Finder or the tree, then Refresh.");
    expect(html).toContain("0 folders · 0 files");
  });

  it("a git repository: KIND at once, then BRANCH and LAST from the facts, with the view link when a view exists", () => {
    const loading = render({ gitKind: "repo", git: "loading", hasView: true });
    expect(loading).toContain("git repository");
    expect(loading).toContain("BRANCH");
    // The fact cells read `…` while the Git call is out (the `Task…` chip is copy, not a loading mark).
    expect(loading).toContain('title="…"');
    expect(loading).toContain("views/defiance/map.svg");
    const done = render({ gitKind: "repo", git: facts("main", { subject: "fix ingestion", time: now - 2 * 86400 }) });
    expect(done).toContain("main");
    expect(done).toContain('"fix ingestion" · 2 days ago');
    expect(done).not.toContain('title="…"');
    expect(done).not.toContain("2d");
  });

  it("a repository with no commits, a detached one, and every named git failure, in place", () => {
    expect(render({ gitKind: "repo", git: facts("main", null) })).toContain("no commits yet");
    expect(render({ gitKind: "repo", git: facts("", null) })).toContain("detached");
    expect(render({ gitKind: "repo", git: { kind: "unavailable" } })).toContain("Git is unavailable on this Mac.");
    expect(render({ gitKind: "repo", git: { kind: "facts", branch: { kind: "timeout" }, last: { kind: "timeout" } } })).toContain("Git took too long");
    expect(render({ gitKind: "repo", git: { kind: "facts", branch: { kind: "too_large" }, last: { kind: "too_large" } } })).toContain(
      "Git returned too much to show",
    );
    expect(render({ gitKind: "repo", git: { kind: "refused", reason: ".git/info/attributes is present" } })).toContain(
      "Git could not read this folder: .git/info/attributes is present",
    );
    expect(
      render({ gitKind: "repo", git: { kind: "facts", branch: { kind: "failed", reason: "dubious ownership" }, last: { kind: "ok", value: null } } }),
    ).toContain("Git could not read this folder: dubious ownership");
  });

  it("a .git file is the linked unsupported state and shows no branch or commit", () => {
    const html = render({ gitKind: "linked", git: null });
    expect(html).toContain("Linked Git directory · not supported yet");
    expect(html).not.toContain("BRANCH");
    expect(html).not.toContain("no commits yet");
  });

  it("a dirty README editor tab makes the excerpt say it shows the disk, with an Open tab action", () => {
    const html = render({ readmeDirty: true });
    expect(html).toContain("Unsaved edits exist in the editor. This excerpt shows the saved file on disk.");
    expect(html).toContain("Open tab");
    expect(render({ readmeDirty: false })).not.toContain("Unsaved edits exist");
  });

  it("a knowledge place has README and TOP LEVEL only: no action row, no THIS PLACE", () => {
    const html = render({ isWork: false, gitKind: "repo", git: facts("main", null), hasView: true });
    expect(html).toContain("README");
    expect(html).toContain("TOP LEVEL");
    expect(html).not.toContain("THIS PLACE");
    expect(html).not.toContain("as of");
    expect(html).not.toContain("BRANCH");
    expect(html).not.toContain("views/defiance");
  });

  it("caps the table at 40 rows and points at the tree for the rest", () => {
    const many = Array.from({ length: 300 }, (_, i) => file(`f${i}.txt`));
    const html = render({ sheet: sheet(many) });
    expect(html).toContain("and 260 more in the tree →");
    expect(html).not.toContain("f299.txt");
  });
});
