/**
 * Checkpoint 5: the two release questions the other specs do not answer.
 *
 * What survives a process that is killed outright rather than asked to stop,
 * and what a rollback to the desktop application would find. Neither is about
 * a feature; both are about whether it is safe to start using this every day.
 */
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRoot, serve, type Served } from "./serve";

let server: Served;

test.beforeAll(async () => {
  server = await serve(makeRoot());
  writeFileSync(join(server.root, "defiance/notes.txt"), "what is on disk\n");
});

test.afterAll(() => server?.stop());

test.describe.configure({ mode: "serial" });

const at = (page: Page, title: string) => page.getByTitle(title, { exact: true });
const inTree = (page: Page, title: string) => page.locator("aside.sidebar").getByTitle(title, { exact: true });

const NOTES = "defiance/notes.txt";

/** Open alabs, open `file`, and make its whole buffer `text`. */
async function typeInto(page: Page, text: string, file = NOTES): Promise<void> {
  await page.goto(server.url);
  await expect(at(page, "Home").first()).toBeVisible();
  await at(page, "defiance").first().click();
  await inTree(page, file).click();
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await expect(editor).toContainText(text);
}

test("a process killed outright still leaves behind everything it acknowledged", async ({ page }) => {
  server.forgetLayout();
  server.forgetDrafts();
  await typeInto(page, "typed but never saved");

  // Wait for the acknowledgement, not for a length of time: the promise alabs
  // makes is about revisions that reached the disk, and nothing else.
  await expect
    .poll(() => server.drafts().find((d) => d.relPath === NOTES)?.contents ?? null)
    .toBe("typed but never saved");

  // No Control-C, no shutdown, no flush: the process simply stops existing.
  await server.abruptlyStop();
  expect(server.running()).toBe(false);

  // What was acknowledged is an ordinary file, still there, readable without
  // alabs, and the user's file itself was never touched.
  const kept = server.drafts();
  expect(kept.map((d) => d.relPath)).toEqual([NOTES]);
  expect(kept[0].contents).toBe("typed but never saved");
  expect(readFileSync(join(server.root, NOTES), "utf8")).toBe("what is on disk\n");

  // And the page says what it actually knows rather than pretending: the save
  // that left and was never answered is uncertain, it is not tried again, and
  // the edits stay in the tab.
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".notice")).toContainText("alabs did not hear back from that save");
  await expect(page.locator(".notice")).toContainText("Nothing will be written until you say so");
  await expect(page.locator(".monaco-editor").first()).toContainText("typed but never saved");
  expect(readFileSync(join(server.root, NOTES), "utf8")).toBe("what is on disk\n");

  // A new process over the same state offers the draft back, for the user to
  // decide about, and still writes nothing into the file on its own.
  server = await serve(server.root, server.home);
  await page.goto(server.url);
  await expect(page.locator(".notice")).toContainText("unsaved");
  expect(readFileSync(join(server.root, NOTES), "utf8")).toBe("what is on disk\n");
});

test("stopping the process leaves a root the desktop application can simply open", async ({ page }) => {
  server.forgetLayout();
  server.forgetDrafts();
  // A real browser session: one file saved, one draft still unsaved.
  await typeInto(page, "saved from Chrome\n");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator("footer")).toContainText("0 unsaved");
  await inTree(page, "defiance/src").click();
  await inTree(page, "defiance/src/main.py").click();
  const editor = page.locator(".monaco-editor").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("still being written");
  await expect.poll(() => server.drafts().length).toBe(1);

  const code = await server.interrupt();
  expect(code === 0 || code === null).toBeTruthy();

  // The root is what it always was: the file the browser saved, in its own
  // format, and not one byte of alabs' own state anywhere inside it.
  expect(readFileSync(join(server.root, NOTES), "utf8")).toContain("saved from Chrome");
  const top = readdirSync(server.root).sort();
  expect(top).toEqual(["README.md", "context", "defiance", "definitions", "views", "wiki"]);
  expect(top).not.toContain("alabs-browser");

  // Git sees exactly the edit that was saved, so the same repository opens in
  // the desktop application, in Terminal, or anywhere else, unchanged.
  const status = execFileSync("/usr/bin/git", ["status", "--porcelain=v1"], {
    cwd: join(server.root, "defiance"),
    encoding: "utf8",
  });
  expect(status).toContain("notes.txt");
  expect(status).not.toContain("main.py");

  // The unsaved work is still kept, and kept outside the root: rolling back
  // never takes it, and never writes it into a file on its own either.
  const kept = server.drafts();
  expect(kept.map((d) => d.relPath)).toEqual(["defiance/src/main.py"]);
  expect(kept[0].contents).toBe("still being written");
  expect(server.stateDir).not.toContain(server.root);
  expect(readFileSync(join(server.root, "defiance/src/main.py"), "utf8")).toBe('def hello():\n    return "world"\n');

  // And the same process can be started again on the same folder afterwards:
  // nothing about stopping it was one-way.
  server = await serve(server.root, server.home);
  await page.goto(server.url);
  await expect(at(page, "Home").first()).toBeVisible();
});
