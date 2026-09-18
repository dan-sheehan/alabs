/**
 * One `alabs-serve` process on one disposable root, for one spec file.
 *
 * Both the root and the server's own state folder are thrown away
 * afterwards: the state folder is isolated by giving the child a `HOME` of
 * its own, which is the same mechanism the server uses in earnest, so a test
 * can never read or overwrite the real browser state.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const binary = join(repo, "src-tauri/target/release/alabs-serve");
const assets = join(repo, "dist-browser");

/** One recovery record as `recovery.rs` writes it. */
export interface KeptDraft {
  version: number;
  root: string;
  relPath: string;
  stamp: { identity: string; mtime_secs: number; mtime_nanos: number; len: number } | null;
  revision: number;
  serverId: string;
  sessionId: string;
  updatedAt: number;
  contents: string;
}

export interface Served {
  /** The address the launcher would open, credential and all. */
  url: string;
  /** The alabs root this process owns. */
  root: string;
  /** The server's own state folder, inside the disposable home. */
  stateDir: string;
  /** The disposable home this server keeps its state under. */
  home: string;
  /**
   * The recovery records on disk right now, whatever wrote them. Read as
   * files, deliberately: the point of the disk copy is that it is an ordinary
   * file somebody can open without alabs.
   */
  drafts(): KeptDraft[];
  /** The mode of the recovery folder and of each record, for the permission check. */
  draftModes(): { folder: number | null; records: number[] };
  /**
   * Make the recovery folder refuse writes, or let it accept them again.
   * The way to stand a real storage failure up without breaking the machine.
   */
  breakRecovery(): void;
  fixRecovery(): void;
  /**
   * Throw away every kept draft, so one test's unsaved work is not offered to
   * the next one. Only tests do this; alabs itself never removes a record
   * except after a confirmed save or an explicit discard.
   */
  forgetDrafts(): void;
  /**
   * Forget the remembered layout. The state folder outlives one test, so
   * without this a test would start inside whatever place the test before
   * it left open.
   */
  forgetLayout(): void;
  /** Everything the process has written to its own log, or "" when it has none. */
  log(): string;
  /** True while the process is still running. */
  running(): boolean;
  /** What Control-C does: resolves to the exit code once it has stopped. */
  interrupt(): Promise<number | null>;
  /**
   * What a crash, a kernel panic or `kill -9` does: the process goes without
   * running another line. Nothing is flushed and nothing is cleaned up, which
   * is the only honest way to check what was already safely on the disk.
   */
  abruptlyStop(): Promise<void>;
  stop(): void;
}

/**
 * A small alabs root: one work place with a readme, a source file, a saved
 * Visual View, and a Git repository; the three knowledge folders. The readme
 * and the map both carry a script, so every run checks that neither runs.
 */
export function makeRoot(): string {
  // Canonical, because that is the path the server reads back from its own
  // handle and reports: on macOS the temp folder is reached through a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alabs-e2e-root-")));
  for (const dir of ["context", "wiki", "definitions", "views/defiance", "defiance/src"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "README.md"), "# Test root\n\nA disposable alabs root.\n");
  writeFileSync(
    join(root, "defiance/README.md"),
    [
      "# defiance",
      "",
      "A work place with a readme and a saved view.",
      "",
      '<script>window.__mdScript = true</script>',
      '<img src=x onerror="window.__mdAttr = true">',
      "",
      "[a link](https://example.com)",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "defiance/src/main.py"), 'def hello():\n    return "world"\n');
  writeFileSync(join(root, "wiki/notes.md"), "# Wiki notes\n\nKnowledge beside the work.\n");
  writeFileSync(join(root, "definitions/terms.md"), "A definition.\n");
  writeFileSync(join(root, "context/brief.md"), "Context material.\n");
  writeFileSync(
    join(root, "views/defiance/map.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">' +
      '<script>window.__svgScript = true</script>' +
      '<rect width="400" height="200" fill="#111" onload="window.__svgAttr = true"/>' +
      '<g data-landmark="src"><text x="20" y="40" fill="#ddd">src</text></g></svg>',
  );
  writeFileSync(
    join(root, "views/defiance/view.json"),
    JSON.stringify({ version: 1, place: "defiance", landmarks: [{ name: "src", note: "the source", paths: ["defiance/src"] }] }),
  );
  const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: join(root, "defiance"), stdio: "ignore" });
  git("init", "-q", ".");
  git("add", "-A");
  git("-c", "user.email=e2e@alabs.test", "-c", "user.name=e2e", "commit", "-qm", "first");
  return root;
}

/**
 * Start one server on `root` and wait for the address it prints. `home` is
 * given when a test restarts a server over the same state, so what was kept
 * before is still there.
 */
export async function serve(root: string, existingHome?: string): Promise<Served> {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), "alabs-e2e-home-"));
  const child: ChildProcessWithoutNullStreams = spawn(binary, [root], {
    env: { ...process.env, HOME: home, ALABS_ASSETS: assets },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const fail = (why: string) => reject(new Error(`alabs-serve did not start: ${why}\n${output}`));
    const timer = setTimeout(() => fail("no address within 10s"), 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (output += chunk));
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const found = /^open:\s+(\S+)$/m.exec(output);
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(`it exited with ${code}`);
    });
  });
  const stateDir = join(home, "Library/Application Support/alabs-browser");
  const recoveryDir = join(stateDir, "recovery");
  return {
    url,
    root,
    stateDir,
    home,
    drafts() {
      if (!existsSync(recoveryDir)) return [];
      return readdirSync(recoveryDir)
        .filter((name) => name.endsWith(".json") && !name.startsWith("."))
        .map((name) => JSON.parse(readFileSync(join(recoveryDir, name), "utf8")) as KeptDraft)
        .sort((a, b) => a.relPath.localeCompare(b.relPath));
    },
    draftModes() {
      if (!existsSync(recoveryDir)) return { folder: null, records: [] };
      return {
        folder: statSync(recoveryDir).mode & 0o777,
        records: readdirSync(recoveryDir)
          .filter((name) => name.endsWith(".json"))
          .map((name) => statSync(join(recoveryDir, name)).mode & 0o777),
      };
    },
    breakRecovery() {
      mkdirSync(recoveryDir, { recursive: true });
      // Readable, so what is already kept can still be listed and handed
      // back; not writable, so nothing new can be.
      chmodSync(recoveryDir, 0o500);
    },
    fixRecovery() {
      if (existsSync(recoveryDir)) chmodSync(recoveryDir, 0o700);
    },
    forgetDrafts() {
      if (existsSync(recoveryDir)) rmSync(recoveryDir, { recursive: true, force: true });
    },
    forgetLayout() {
      rmSync(join(home, "Library/Application Support/alabs-browser/ui-state.json"), { force: true });
    },
    log() {
      const path = join(home, "Library/Application Support/alabs-browser/alabs.log");
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    },
    running() {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      try {
        // Signal 0 asks the kernel whether the process is there, and sends nothing.
        process.kill(child.pid!, 0);
        return true;
      } catch {
        return false;
      }
    },
    interrupt() {
      return new Promise<number | null>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
        child.once("exit", (code) => resolve(code));
        child.kill("SIGINT");
      });
    },
    abruptlyStop() {
      return new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });
    },
    stop() {
      child.kill("SIGINT");
      if (existsSync(recoveryDir)) chmodSync(recoveryDir, 0o700);
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The origin and credential of a running server, for direct API probes. */
export function parts(url: string): { origin: string; credential: string } {
  const at = new URL(url);
  return { origin: at.origin, credential: at.hash.replace(/^#c=/, "") };
}
