/**
 * What checkpoint 3 promises about *unsaved* work, in real Chrome.
 *
 * This is the file Vitest cannot stand in for: it needs real IndexedDB, a real
 * reload, real tabs being closed, a real process being restarted, and a real
 * folder on disk that can be made to refuse writes. Everything here is about
 * one rule — nothing is ever said to be kept unless something actually kept
 * it, and nothing kept is thrown away unless the file has it or the user said
 * to throw it away.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRoot, serve, type Served } from "./serve";

let server: Served;

test.beforeAll(async () => {
  server = await serve(makeRoot());
});

test.beforeEach(() => {
  server.forgetLayout();
  server.fixRecovery();
  // Each test types its own unsaved work; nothing carries over.
  server.forgetDrafts();
});

test.afterAll(() => server?.stop());

test.describe.configure({ mode: "serial" });

const at = (page: Page, title: string) => page.getByTitle(title, { exact: true });

/** A row in the file tree; once a file is open its tab carries the same title. */
const inTree = (page: Page, title: string) => page.locator("aside.sidebar").getByTitle(title, { exact: true });

const NOTES = "defiance/notes.txt";
const onDisk = (relPath: string) => readFileSync(join(server.root, relPath), "utf8");

/**
 * Open alabs, open `file`, and make its whole buffer `text`, so what is kept
 * is exactly what the test names rather than whatever a cursor position made
 * of it.
 */
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
  await expect(page.locator("footer")).toContainText("1 unsaved");
}

/** What the browser's own storage holds for this root, read from the page. */
async function inBrowser(page: Page): Promise<Array<{ relPath: string; contents: string; revision: number }>> {
  return page.evaluate(
    () =>
      new Promise<Array<{ relPath: string; contents: string; revision: number }>>((resolve, reject) => {
        const open = indexedDB.open("alabs-drafts");
        open.onerror = () => reject(new Error("could not open the draft database"));
        open.onsuccess = () => {
          const db = open.result;
          const all = db.transaction("drafts", "readonly").objectStore("drafts").getAll();
          all.onerror = () => reject(new Error("could not read the drafts"));
          all.onsuccess = () =>
            resolve(
              (all.result as Array<{ relPath: string; contents: string; revision: number }>).map((d) => ({
                relPath: d.relPath,
                contents: d.contents,
                revision: d.revision,
              })),
            );
        };
      }),
  );
}

/** Wait until the draft for `relPath` on disk says `contents`. */
async function keptOnDisk(relPath: string, contents: string) {
  await expect
    .poll(() => server.drafts().find((d) => d.relPath === relPath)?.contents ?? null, {
      message: `the draft for ${relPath} should reach the disk`,
    })
    .toBe(contents);
}

test.beforeAll(() => {
  writeFileSync(join(server.root, NOTES), "what is on disk\n");
});

test("what is typed reaches both stores, and says which of them has it", async ({ page }) => {
  await typeInto(page, "kept while typing");
  await keptOnDisk(NOTES, "kept while typing");

  // In the browser too, at the same revision.
  await expect.poll(async () => (await inBrowser(page)).map((d) => d.relPath)).toContain(NOTES);
  const browser = (await inBrowser(page)).find((d) => d.relPath === NOTES)!;
  const disk = server.drafts().find((d) => d.relPath === NOTES)!;
  expect(browser.contents).toBe(disk.contents);
  expect(browser.revision).toBe(disk.revision);
  // It carries which root, which server lifetime and which window made it.
  expect(disk.root).toBe(server.root);
  expect(disk.serverId).toMatch(/^[0-9a-f]{32}$/);
  expect(disk.sessionId).toMatch(/^[0-9a-f]{16}$/);
});

test("a draft on disk is alabs' own, and nobody else's to read", async ({ page }) => {
  await typeInto(page, "nobody else's to read");
  await keptOnDisk(NOTES, "nobody else's to read");
  const modes = server.draftModes();
  expect(modes.folder).toBe(0o700);
  expect(modes.records.length).toBeGreaterThan(0);
  for (const mode of modes.records) expect(mode).toBe(0o600);
});

test("an unreadable browser draft survives later edits and saves for that path", async ({ page }) => {
  const file = "defiance/unreadable.txt";
  writeFileSync(join(server.root, file), "source file\n");
  await typeInto(page, "older recoverable text", file);
  await keptOnDisk(file, "older recoverable text");
  await page.evaluate(({ root, relPath }) => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open("alabs-drafts");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("drafts", "readwrite");
      const store = tx.objectStore("drafts");
      const row = store.get([root, relPath]);
      row.onsuccess = () => store.put({ ...row.result, revision: "unreadable revision" });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { root: server.root, relPath: file });

  const editor = page.locator(".monaco-editor").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("new text for this file");
  await keptOnDisk(file, "new text for this file");
  expect((await inBrowser(page)).find((d) => d.relPath === file)?.contents).toBe("older recoverable text");
  await expect(page.locator("body")).toContainText("not everywhere it wanted to");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator("footer")).toContainText("0 unsaved");
  await expect.poll(() => server.drafts().length).toBe(0);
  expect((await inBrowser(page)).find((d) => d.relPath === file)?.contents).toBe("older recoverable text");
});

test("a reload offers what was typed, and writes nothing to the file", async ({ page }) => {
  await typeInto(page, "survives a reload");
  await keptOnDisk(NOTES, "survives a reload");
  const before = onDisk(NOTES);

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Unsaved work from before" })).toBeVisible();
  await expect(page.locator(".recovery-row")).toContainText(NOTES);
  // Offered, not applied: the file is exactly as it was.
  expect(onDisk(NOTES)).toBe(before);

  // Opening it shows the kept text beside the file, still unsaved.
  await page.getByRole("button", { name: "Open" }).first().click();
  await expect(page.locator(".monaco-editor").first()).toContainText("survives a reload");
  await expect(page.locator("footer")).toContainText("1 unsaved");
  expect(onDisk(NOTES)).toBe(before);
});

test("a closed tab, reopened, still has it", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await typeInto(page, "survives the tab closing");
    await keptOnDisk(NOTES, "survives the tab closing");
    await page.close();

    // A new tab in the same browser: a different window as far as editing
    // goes, and the same drafts as far as recovery goes.
    const again = await context.newPage();
    await again.goto(server.url);
    await expect(again.getByRole("dialog", { name: "Unsaved work from before" })).toBeVisible();
    await expect(again.locator(".recovery-row")).toContainText(NOTES);
  } finally {
    await context.close();
  }
});

test("clearing the browser's data does not take what reached the disk", async ({ browser }) => {
  const first = await browser.newContext();
  let home: string;
  try {
    const page = await first.newPage();
    await typeInto(page, "only the disk copy is left");
    await keptOnDisk(NOTES, "only the disk copy is left");
    home = server.home;
  } finally {
    await first.close();
  }

  // A browsing context with no storage of its own: exactly what clearing the
  // browser's data leaves behind.
  const fresh = await browser.newContext();
  try {
    const page = await fresh.newPage();
    expect(await inBrowser(page).catch(() => [])).toEqual([]);
    await page.goto(server.url);
    await expect(page.getByRole("dialog", { name: "Unsaved work from before" })).toBeVisible();
    await page.getByRole("button", { name: "Open" }).first().click();
    await expect(page.locator(".monaco-editor").first()).toContainText("only the disk copy is left");
  } finally {
    await fresh.close();
  }
  expect(home).toBe(server.home);
});

test("a restarted server still has it, and knows it is not the same server", async ({ browser }) => {
  const context = await browser.newContext();
  let firstServerId: string;
  try {
    const page = await context.newPage();
    await typeInto(page, "survives a restart");
    await keptOnDisk(NOTES, "survives a restart");
    firstServerId = server.drafts().find((d) => d.relPath === NOTES)!.serverId;
  } finally {
    await context.close();
  }

  // Control-C, then `npm run browser` again over the same state.
  const home = server.home;
  const root = server.root;
  await server.interrupt();
  server = await serve(root, home);

  const after = await browser.newContext();
  try {
    const page = await after.newPage();
    await page.goto(server.url);
    await expect(page.getByRole("dialog", { name: "Unsaved work from before" })).toBeVisible();
    await page.getByRole("button", { name: "Open" }).first().click();
    await expect(page.locator(".monaco-editor").first()).toContainText("survives a restart");
    // Editing is free again: the window that held it went with the process.
    await expect(page.locator("body")).not.toContainText("Another alabs window is editing");
    // And this is a different lifetime, which the page can tell.
    const bootstrap = await page.evaluate(async () => {
      const response = await fetch("/api/v1/bootstrap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Alabs-Credential": sessionStorage.getItem("alabs.credential") ?? "",
          "X-Alabs-Session": sessionStorage.getItem("alabs.session") ?? "",
        },
        body: "{}",
      });
      return (await response.json()) as { serverId: string; canEdit: boolean };
    });
    expect(bootstrap.serverId).not.toBe(firstServerId);
    expect(bootstrap.canEdit).toBe(true);
  } finally {
    await after.close();
  }
});

test("a draft goes only when the file has it, or the user throws it away", async ({ page }) => {
  await typeInto(page, "about to be saved");
  await keptOnDisk(NOTES, "about to be saved");

  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator("body")).toContainText("Saved notes.txt.");
  expect(onDisk(NOTES)).toBe("about to be saved");
  // Gone from both stores, and only now.
  await expect.poll(() => server.drafts().map((d) => d.relPath)).not.toContain(NOTES);
  await expect.poll(async () => (await inBrowser(page)).map((d) => d.relPath)).not.toContain(NOTES);

  // And the other way out: the user says to throw it away.
  await typeInto(page, "about to be discarded");
  await keptOnDisk(NOTES, "about to be discarded");
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Unsaved work from before" })).toBeVisible();
  const before = onDisk(NOTES);
  await page.getByRole("button", { name: "Discard" }).first().click();
  await expect.poll(() => server.drafts().map((d) => d.relPath)).not.toContain(NOTES);
  // Discarding a draft never touches the file.
  expect(onDisk(NOTES)).toBe(before);
});

test("a draft is not thrown away by a save that was refused", async ({ page }) => {
  writeFileSync(join(server.root, "defiance/contested.txt"), "the version alabs read\n");
  await typeInto(page, "my edit", "defiance/contested.txt");
  await keptOnDisk("defiance/contested.txt", "my edit");

  // Something else replaces the file, so the save is refused.
  writeFileSync(join(server.root, "defiance/contested.txt"), "a version alabs never saw\n");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator("body")).toContainText("changed on disk");

  // The save did not happen, so the draft is still kept. This is the rule:
  // a record goes after a *confirmed* save, never after an attempted one.
  expect(server.drafts().find((d) => d.relPath === "defiance/contested.txt")?.contents).toBe("my edit");
});

test("when the disk will not keep a draft, alabs says so and evicts nothing", async ({ page }) => {
  await page.goto(server.url);
  await expect(at(page, "Home").first()).toBeVisible();
  // Something already kept, so the refusal can be seen not to take it.
  await typeInto(page, "kept before the folder broke");
  await keptOnDisk(NOTES, "kept before the folder broke");
  const kept = server.drafts().length;
  expect(kept).toBeGreaterThan(0);

  // The recovery folder refuses writes from here on.
  server.breakRecovery();
  const editor = page.locator(".monaco-editor").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("the disk will not take this");

  // Said out loud rather than quietly looking as safe as it was.
  await expect(page.locator("body")).toContainText("not everywhere it wanted to");
  // Nothing was deleted to make room, and nothing already kept was lost.
  expect(server.drafts().length).toBe(kept);
  expect(server.drafts()[0].contents).toBe("kept before the folder broke");
  // The text is still here, and there is a way to get it out.
  await expect(editor).toContainText("the disk will not take this");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save a copy…" }).first().click();
  expect((await download).suggestedFilename()).toBe("notes.txt");
  server.fixRecovery();
});

test("when nothing will keep a draft, alabs says that, and hands the text over", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    // A profile that gives alabs no storage at all: private browsing, or
    // site data blocked.
    await context.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", {
        configurable: true,
        get() {
          throw new Error("site data is blocked in this profile");
        },
      });
    });
    const page = await context.newPage();
    await page.goto(server.url);
    await expect(at(page, "Home").first()).toBeVisible();
    // alabs cannot read this profile's storage, so it says so at once rather
    // than starting as though there were nothing to find.
    const told = page.getByRole("dialog", { name: "Unsaved work from before" });
    await expect(told).toBeVisible();
    await expect(told).toContainText("could not read");
    await page.getByRole("button", { name: "Later" }).click();
    server.breakRecovery();

    await at(page, "defiance").first().click();
    await inTree(page, NOTES).click();
    const editor = page.locator(".monaco-editor").first();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("nowhere to keep this");

    // The one thing recovery must never do is look safe when it is not.
    await expect(page.locator("body")).toContainText("could not keep your unsaved work");
    await expect(editor).toContainText("nowhere to keep this");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save a copy…" }).first().click();
    expect((await download).suggestedFilename()).toBe("notes.txt");
  } finally {
    server.fixRecovery();
    await context.close();
  }
});

test("a draft whose file has gone opens as missing, and recreating it stays the user's call", async ({ page }) => {
  const doomed = "defiance/doomed.txt";
  writeFileSync(join(server.root, doomed), "here for now\n");
  await typeInto(page, "kept after the file went", doomed);
  await keptOnDisk(doomed, "kept after the file went");

  // The file goes away while alabs is not looking, and the page is reloaded.
  const { rmSync } = await import("node:fs");
  rmSync(join(server.root, doomed));
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Unsaved work from before" })).toBeVisible();
  await page.getByRole("button", { name: "Open" }).first().click();

  await expect(page.locator("body")).toContainText("not on disk");
  await expect(page.locator(".monaco-editor").first()).toContainText("kept after the file went");
  // Still not there: opening a draft never writes a file.
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(server.root, doomed))).toBe(false);

  // And bringing it back is asked about, as it always is.
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("dialog", { name: "Recreate file" })).toBeVisible();
  expect(existsSync(join(server.root, doomed))).toBe(false);
  await page.getByRole("button", { name: "Recreate file" }).click();
  await expect(page.locator("body")).toContainText("Recreated");
  expect(onDisk(doomed)).toBe("kept after the file went");
});
