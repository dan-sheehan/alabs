/**
 * `npm run browser -- "/absolute/path/to/alabs-root"`
 *
 * Builds what the browser needs, starts the one local process that owns that
 * root, and opens Chrome on the address it prints. Everything the process
 * says goes straight to this terminal. Closing Chrome does not stop it;
 * Control-C does.
 *
 * Nothing here decides anything about the root: the path is handed to
 * `alabs-serve`, which opens it, and refuses to start if it cannot.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(repo, "dist-browser");
const server = resolve(repo, "src-tauri/target/release/alabs-serve");

const [root] = process.argv.slice(2);
if (!root) {
  console.error('usage: npm run browser -- "/absolute/path/to/alabs-root"');
  process.exit(1);
}
if (!root.startsWith("/")) {
  console.error(`the alabs root must be an absolute path: ${root}`);
  process.exit(1);
}

/** Run one build step, showing its output. A failed step stops the launch. */
function step(what, command, args, env) {
  console.log(`· ${what}`);
  const done = spawnSync(command, args, { cwd: repo, stdio: "inherit", env: { ...process.env, ...env } });
  if (done.status !== 0) {
    console.error(`\n${what} failed. Nothing was started.`);
    process.exit(done.status ?? 1);
  }
}

step("checking types", "npx", ["tsc", "--noEmit"]);
step("building the browser assets", "npx", ["vite", "build", "--outDir", "dist-browser", "--emptyOutDir"], {
  ALABS_RUNTIME: "browser",
});
// Cargo reuses its cache, so this is only slow the first time. The server is
// built without Tauri: `--no-default-features` is what makes that true.
step("building alabs-serve", "cargo", [
  "build",
  "--release",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--no-default-features",
  "--features",
  "serve",
  "--bin",
  "alabs-serve",
]);

const child = spawn(server, [root], {
  cwd: repo,
  env: { ...process.env, ALABS_ASSETS: assets },
  stdio: ["inherit", "pipe", "inherit"],
});

/**
 * Chrome, and only Chrome: this release is Chrome-only, so alabs does not
 * quietly hand the address to whatever browser happens to be the default.
 */
function openChrome(url) {
  const opened = spawnSync("/usr/bin/open", ["-a", "Google Chrome", url], { stdio: "ignore" });
  if (opened.status !== 0) {
    console.log("Could not open Google Chrome. Open this address in Chrome yourself:");
    console.log(`  ${url}`);
  }
}

// The address carries this launch's credential, so it comes from the process
// rather than being guessed here.
let opened = false;
let pending = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    const match = /^open:\s+(\S+)$/.exec(line);
    if (match && !opened) {
      opened = true;
      openChrome(match[1]);
    }
  }
});

child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
