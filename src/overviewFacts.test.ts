import { languageForFile } from "./language";
import { describe, expect, it, vi } from "vitest";
import {
  branchText,
  clockTime,
  EXCERPT_CHARS,
  fileKind,
  findReadme,
  KIND_TEXT,
  lastCommitText,
  readmeExcerpt,
  readOverview,
  relativeTime,
  TOP_LEVEL_ROWS,
  topLevelRows,
  topLevelSummary,
  whereGitText,
} from "./overviewFacts";
import { NEVER_ON_SCREEN } from "./notices";
import type { Commit, Entry, GitInspection, GitOutcome } from "./subject";

const dir = (name: string): Entry => ({ name, rel_path: `p/${name}`, is_dir: true });
const file = (name: string): Entry => ({ name, rel_path: `p/${name}`, is_dir: false });

describe("README excerpt", () => {
  it("skips the title and returns the first prose paragraph on one line", () => {
    expect(readmeExcerpt("# Defiance\n\nA corpus tool.\nIt validates records.\n\nMore later.")).toBe("A corpus tool. It validates records.");
    expect(readmeExcerpt("No heading here.\r\n\r\nSecond.")).toBe("No heading here.");
  });

  it("cuts at the character cap with an ellipsis, and a heading-only file keeps its heading", () => {
    const long = "x".repeat(EXCERPT_CHARS + 50);
    const excerpt = readmeExcerpt(`# T\n\n${long}`);
    expect(excerpt).toHaveLength(EXCERPT_CHARS + 1);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(readmeExcerpt("# Only a title")).toBe("# Only a title");
    expect(readmeExcerpt("")).toBe("");
  });

  it("finds README.md in any letter case, files only, and nothing else", () => {
    expect(findReadme([dir("README.md"), file("Readme.MD"), file("readme.txt")])?.name).toBe("Readme.MD");
    expect(findReadme([file("readme.txt"), dir("docs")])).toBeNull();
  });
});

describe("TOP LEVEL rows", () => {
  it("keeps listing order, names kinds from the listing, and caps the rows", () => {
    const entries = [dir("src"), file("main.py"), file("notes.md"), file("data.bin"), file("Makefile")];
    const { rows, more } = topLevelRows(entries);
    expect(rows.map((r) => r.kind)).toEqual(["folder", "python", "markdown", "file", "text"]);
    expect(more).toBe(0);
    expect(topLevelSummary(entries)).toBe("1 folder · 4 files");
    const many = Array.from({ length: TOP_LEVEL_ROWS + 260 }, (_, i) => file(`f${i}.txt`));
    const capped = topLevelRows(many);
    expect(capped.rows).toHaveLength(TOP_LEVEL_ROWS);
    expect(capped.more).toBe(260);
  });

  it("never invents a kind from a name", () => {
    expect(fileKind("architecture")).toBe("file");
    expect(fileKind("ingest.py")).toBe("python");
  });
});

describe("Step 4: git facts copy", () => {
  const facts = (branch: GitOutcome<string>, last: GitOutcome<Commit | null>): GitInspection => ({ kind: "facts", branch, last });
  const now = 1_000_000;

  it("shows the branch, the quoted last commit with a spelled-out relative time, and no commits yet", () => {
    const git = facts({ kind: "ok", value: "main" }, { kind: "ok", value: { subject: "fix ingestion", time: now - 2 * 86400 } });
    expect(branchText(git)).toBe("main");
    expect(lastCommitText(git, now)).toBe('"fix ingestion" · 2 days ago');
    expect(whereGitText(git, now)).toBe("git · main · 2 days ago");
    const fresh = facts({ kind: "ok", value: "main" }, { kind: "ok", value: null });
    expect(lastCommitText(fresh, now)).toBe("no commits yet");
    expect(whereGitText(fresh, now)).toBe("git · main");
    const detached = facts({ kind: "ok", value: "" }, { kind: "ok", value: null });
    expect(branchText(detached)).toBe("detached");
  });

  it("names every failure in DESIGN.md words, in place, and never abbreviates", () => {
    expect(branchText(facts({ kind: "timeout" }, { kind: "timeout" }))).toBe("Git took too long");
    expect(lastCommitText(facts({ kind: "too_large" }, { kind: "too_large" }), now)).toBe("Git returned too much to show");
    expect(branchText(facts({ kind: "failed", reason: "not a git repository" }, { kind: "ok", value: null }))).toBe(
      "Git could not read this folder: not a git repository",
    );
    expect(branchText({ kind: "unavailable" })).toBe("Git is unavailable on this Mac.");
    expect(lastCommitText({ kind: "linked" }, now)).toBe("Linked Git directory · not supported yet");
    expect(branchText({ kind: "refused", reason: ".git/info/attributes is present" })).toBe("Git could not read this folder: .git/info/attributes is present");
    expect(branchText({ kind: "error", reason: "cannot access d: No such file or directory (os error 2)" })).toBe(
      "Git could not read this folder: cannot access d: No such file or directory",
    );
    expect(whereGitText({ kind: "unavailable" }, now)).toBe("git");
    expect(whereGitText({ kind: "none" }, now)).toBeNull();
    expect(whereGitText({ kind: "linked" }, now)).toBeNull();
    expect(whereGitText(null, now)).toBeNull();
    expect(KIND_TEXT).toEqual({ repo: "git repository", linked: "Linked Git directory · not supported yet", none: "folder" });
  });

  it("never shows the words DESIGN.md section 7 bans", () => {
    const samples = [
      branchText({ kind: "unavailable" }),
      branchText({ kind: "linked" }),
      branchText(facts({ kind: "timeout" }, { kind: "timeout" })),
      branchText(facts({ kind: "too_large" }, { kind: "too_large" })),
      branchText(facts({ kind: "ok", value: "" }, { kind: "ok", value: null })),
      lastCommitText(facts({ kind: "ok", value: "main" }, { kind: "ok", value: null }), now),
      whereGitText(facts({ kind: "ok", value: "main" }, { kind: "ok", value: { subject: "x", time: now - 90 } }), now) ?? "",
      ...Object.values(KIND_TEXT),
    ];
    for (const shown of samples) {
      for (const word of NEVER_ON_SCREEN) {
        const found = word === word.toUpperCase() ? shown.includes(word) : shown.toLowerCase().includes(word.toLowerCase());
        expect(found, `"${shown}" contains "${word}"`).toBe(false);
      }
    }
  });

  it("spells out relative times and the clock", () => {
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now + 100, now)).toBe("just now");
    expect(relativeTime(now - 61, now)).toBe("1 minute ago");
    expect(relativeTime(now - 3600 * 5, now)).toBe("5 hours ago");
    expect(relativeTime(now - 86400, now)).toBe("1 day ago");
    expect(relativeTime(now - 86400 * 13, now)).toBe("13 days ago");
    expect(relativeTime(now - 86400 * 21, now)).toBe("3 weeks ago");
    expect(relativeTime(now - 86400 * 100, now)).toBe("3 months ago");
    expect(relativeTime(now - 86400 * 800, now)).toBe("2 years ago");
    expect(relativeTime(now - 86400 * 2, now)).not.toBe("2d");
    expect(clockTime(new Date(2026, 8, 14, 15, 42))).toBe("3:42 pm");
    expect(clockTime(new Date(2026, 8, 14, 0, 5))).toBe("12:05 am");
    expect(clockTime(new Date(2026, 8, 14, 12, 0))).toBe("12:00 pm");
  });
});

describe("Step 4: readOverview", () => {
  const io = (entries: Entry[], content: string | Error = "# T\n\nHello.") => ({
    listDir: vi.fn(async () => entries),
    readFile: vi.fn(async () => {
      if (content instanceof Error) throw content;
      return { content };
    }),
  });

  it("reads one listing and the README when present, and nothing else", async () => {
    const deps = io([dir("src"), file("README.md"), file("notes.md")]);
    const sheet = await readOverview(deps, "p");
    expect(deps.listDir).toHaveBeenCalledTimes(1);
    expect(deps.listDir).toHaveBeenCalledWith("p");
    expect(deps.readFile).toHaveBeenCalledTimes(1);
    expect(deps.readFile).toHaveBeenCalledWith("p/README.md");
    expect(sheet.readme).toEqual({ name: "README.md", relPath: "p/README.md", text: "# T\n\nHello." });
    expect(sheet.entries).toHaveLength(3);
  });

  it("reads nothing but the listing when there is no README, and reports an unreadable one", async () => {
    const none = io([dir("src"), file("notes.md")]);
    expect((await readOverview(none, "p")).readme).toBeNull();
    expect(none.readFile).not.toHaveBeenCalled();
    const broken = io([file("README.md")], new Error("file is larger than 2 MB: p/README.md"));
    expect((await readOverview(broken, "p")).readme).toEqual({ name: "README.md", relPath: "p/README.md", text: null });
  });

  it("rejects when the listing fails", async () => {
    const deps = { listDir: vi.fn(async () => Promise.reject("cannot access p: No such file or directory")), readFile: vi.fn() };
    await expect(readOverview(deps, "p")).rejects.toBe("cannot access p: No such file or directory");
    expect(deps.readFile).not.toHaveBeenCalled();
  });
});


describe("file kind is a name hint, not a promise of editor support", () => {
  it.each([".DS_Store", "photo.png", "archive.zip", "data.bin", "something.custom", "README", "file."])("uses file for unknown %s", (name) => {
    expect(fileKind(name)).toBe("file");
    expect(languageForFile(name)).toBe("plaintext");
  });
  it.each([["notes.TXT", "text"], ["Makefile", "text"], ["README.MD", "markdown"], ["notes.markdown", "markdown"], ["page.htm", "html"], ["page.HTML", "html"]])("keeps known %s consistent", (name, kind) => {
    expect(fileKind(name)).toBe(kind);
  });
});
