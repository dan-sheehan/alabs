import { defineConfig } from "@playwright/test";

/**
 * Real Chrome, against a real `alabs-serve`, on a disposable root.
 *
 * `channel: "chrome"` uses the Google Chrome installed on this Mac rather
 * than a bundled build, because Chrome is what this release is for. Nothing
 * here is downloaded and nothing ships: this is a development-only check.
 *
 * One worker, and never in parallel: a server owns one fixed port, so two
 * runs would fight over it. A real alabs running on that port makes these
 * tests fail to start, which is the honest outcome.
 */
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "line" : "list",
  timeout: 30_000,
  use: {
    channel: "chrome",
    // Every test gets a fresh, isolated profile; nothing touches the
    // browser the user works in.
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
});
