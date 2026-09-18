import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// Which runtime this build talks to. `ALABS_RUNTIME=browser` builds the
// assets `alabs-serve` serves to Chrome; anything else builds the desktop
// application. Only the selected file is bundled, so the browser build
// never imports Tauri.
const runtime = process.env.ALABS_RUNTIME === "browser" ? "browser" : "desktop";
const runtimeFile = new URL(`./src/runtime.${runtime}.ts`, import.meta.url).pathname;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  resolve: {
    alias: { "alabs-runtime": runtimeFile },
  },

  // The unit tests live beside the code they test. `tests/browser` is
  // Playwright's, driven by `npx playwright test` against a real Chrome, and
  // must not be collected here.
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
