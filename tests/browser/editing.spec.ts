/**
 * What checkpoint 3 promises about *changing* files, in real Chrome: one
 * window edits, saving goes through the same protections the desktop
 * application has always had, and everything that is not an ordinary save —
 * a stale stamp, an outside change, a missing file, a collision, a path that
 * would leave the root — is refused or made explicit rather than guessed at.
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRoot, parts, serve, type Served } from "./serve";

let server: Served;

test.beforeAll(async () => {
  server = await serve(makeRoot());
});

test.beforeEach(() => {
  server.forgetLayout();
  // Unsaved work from one test must not be offered to the next: this file is
  // about changing files, and `recovery.spec.ts` is about keeping drafts.
  server.forgetDrafts();
});

test.afterAll(() => server?.stop());

const at = (page: Page, title: string) => page.getByTitle(title, { exact: true });

/**
 * A row in the file tree. Scoped to the sidebar because once a file is open
 * its tab carries the same title, and these tests mean the tree.
 */
const inTree = (page: Page, title: string) => page.locator("aside.sidebar").getByTitle(title, { exact: true });

/**
 * Show `child` in the tree, opening `folder` only if it is not already open.
 * The layout is remembered per root and shared by every window, so a folder
 * left open by an earlier test must not be clicked shut by a later one.
 */
async function expand(page: Page, folder: string, child: string): Promise<void> {
  // A toggle, so it may have to be pressed twice: whether the folder starts
  // open depends on a layout written a moment ago by another window.
  await expect
    .poll(
      async () => {
        if (await inTree(page, child).isVisible()) return true;
        await inTree(page, folder).click();
        return inTree(page, child).isVisible();
      },
      { message: `${child} should be showing in the tree` },
    )
    .toBe(true);
}

const SOURCE = "defiance/src/main.py";
const onDisk = (relPath: string) => readFileSync(join(server.root, relPath), "utf8");

async function open(page: Page): Promise<void> {
  await page.goto(server.url);
  await expect(at(page, "Home").first()).toBeVisible();
}

/**
 * Open the source file in Monaco. Its contents are whatever an earlier test
 * in this file left there, so what is waited for is the buffer being the one
 * for this file, not any particular text in it.
 */
async function openSource(page: Page): Promise<void> {
  await open(page);
  await at(page, "defiance").first().click();
  await expand(page, "defiance/src", SOURCE);
  await inTree(page, SOURCE).click();
  await expect(page.locator(`.monaco-editor[data-uri$="/${SOURCE}"]`)).toBeVisible();
}

/**
 * Replace the whole buffer with `text`, so what ends up on disk is exactly
 * what the test names. Select-all and type, rather than placing a cursor:
 * where a click lands in Monaco is not something a test should depend on.
 */
async function type(page: Page, text: string): Promise<void> {
  const editor = page.locator(".monaco-editor").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await expect(editor).toContainText(text);
  await expect(page.locator("footer")).toContainText("1 unsaved");
}

test.describe("saving", () => {
  test("the editor takes edits and Save writes them through the existing protections", async ({ page }) => {
    await openSource(page);
    expect(onDisk(SOURCE)).toContain("def hello():");
    await type(page, "# edited in Chrome");

    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator("body")).toContainText("Saved src/main.py.");
    await expect(page.locator("footer")).toContainText("0 unsaved");

    expect(onDisk(SOURCE)).toBe("# edited in Chrome");
    // Saving is what finishes the draft, and only then.
    await expect.poll(() => server.drafts().map((d) => d.relPath)).toEqual([]);
  });

  test("a file changed on disk since it was opened refuses the save and keeps the edits", async ({ page }) => {
    writeFileSync(join(server.root, "defiance/stale.txt"), "the version alabs read\n");
    await open(page);
    await at(page, "defiance").first().click();
    await inTree(page, "defiance/stale.txt").click();
    await expect(page.locator(".monaco-editor").first()).toContainText("the version alabs read");
    await type(page, "my edit");

    // Something else replaces the file while the buffer is open.
    writeFileSync(join(server.root, "defiance/stale.txt"), "a version alabs never saw\n");

    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator("body")).toContainText("changed on disk");
    // Nothing was written over, and the edits are still in the tab.
    expect(onDisk("defiance/stale.txt")).toBe("a version alabs never saw\n");
    await expect(page.locator("footer")).toContainText("1 unsaved");
    // And the unsaved text is still being kept.
    await expect.poll(() => server.drafts().map((d) => d.relPath)).toContain("defiance/stale.txt");
  });

  test("Refresh shows an outside change, and never overwrites a buffer with it", async ({ page }) => {
    writeFileSync(join(server.root, "defiance/outside.txt"), "first\n");
    await open(page);
    await at(page, "defiance").first().click();
    await inTree(page, "defiance/outside.txt").click();
    await expect(page.locator(".monaco-editor").first()).toContainText("first");
    await type(page, "mine");

    writeFileSync(join(server.root, "defiance/outside.txt"), "theirs\n");
    await at(page, "Refresh from disk").click();
    await expect(page.locator("body")).toContainText("changed on disk");
    // The buffer still holds what was typed: a Refresh reports, it does not
    // resolve.
    await expect(page.locator(".monaco-editor").first()).toContainText("mine");
    await expect(page.locator("footer")).toContainText("1 unsaved");
  });

  test("a file that has vanished asks before recreating it, and never does so on its own", async ({ page }) => {
    writeFileSync(join(server.root, "defiance/vanishes.txt"), "here for now\n");
    await open(page);
    await at(page, "defiance").first().click();
    await inTree(page, "defiance/vanishes.txt").click();
    await expect(page.locator(".monaco-editor").first()).toContainText("here for now");
    await type(page, "kept in the tab");

    rmSync(join(server.root, "defiance/vanishes.txt"));
    await page.keyboard.press("ControlOrMeta+s");

    // Asked, not done: the file is still gone while the question stands.
    await expect(page.getByRole("dialog", { name: "Recreate file" })).toBeVisible();
    expect(existsSync(join(server.root, "defiance/vanishes.txt"))).toBe(false);
    await page.getByRole("button", { name: "Keep in tab only" }).click();
    expect(existsSync(join(server.root, "defiance/vanishes.txt"))).toBe(false);
    await expect(page.locator("footer")).toContainText("1 unsaved");

    // Asked again, and answered: now it comes back, with what was typed.
    await page.keyboard.press("ControlOrMeta+s");
    await page.getByRole("button", { name: "Recreate file" }).click();
    await expect(page.locator("body")).toContainText("Recreated");
    expect(onDisk("defiance/vanishes.txt")).toBe("kept in the tab");
  });
});

test.describe("a save that is never answered", () => {
  /**
   * The hard one. A refusal is the server saying no; silence is not. The
   * write may have gone through in full and only the answer been lost, so
   * alabs may not try again — it has to go back to the disk and look.
   */
  test("when the write never left, alabs says the file is untouched and does not try again", async ({ page }) => {
    writeFileSync(join(server.root, "defiance/silent.txt"), "untouched\n");
    const sent: string[] = [];
    page.on("request", (r) => r.url().endsWith("/api/v1/save-file") && sent.push(r.url()));
    // The request never reaches the server, so the file cannot have changed.
    await page.route("**/api/v1/save-file", (route) => route.abort("connectionfailed"));

    await open(page);
    await at(page, "defiance").first().click();
    await inTree(page, "defiance/silent.txt").click();
    await expect(page.locator(".monaco-editor").first()).toContainText("untouched");
    await type(page, "never left the page");
    await page.keyboard.press("ControlOrMeta+s");

    await expect(page.locator("body")).toContainText("is unchanged on disk, so nothing was written");
    expect(onDisk("defiance/silent.txt")).toBe("untouched\n");
    await expect(page.locator("footer")).toContainText("1 unsaved");
    // One attempt, and one only: nothing is retried on a guess.
    expect(sent).toHaveLength(1);
    // And the unsaved text is still kept, because nothing was confirmed saved.
    await expect.poll(() => server.drafts().map((d) => d.relPath)).toContain("defiance/silent.txt");
  });

  test("when the write may have happened, alabs says so and leaves it to the user", async ({ page }) => {
    writeFileSync(join(server.root, "defiance/lost.txt"), "before\n");
    const saves: string[] = [];
    page.on("request", (r) => r.url().endsWith("/api/v1/save-file") && saves.push(r.url()));
    // The server really carries the save out; the page never hears back. This
    // is exactly the case alabs must not resolve by itself.
    await page.route("**/api/v1/save-file", async (route) => {
      await route.fetch();
      await route.abort("connectionfailed");
    });

    await open(page);
    await at(page, "defiance").first().click();
    await inTree(page, "defiance/lost.txt").click();
    await expect(page.locator(".monaco-editor").first()).toContainText("before");
    await type(page, "did this land?");
    await page.keyboard.press("ControlOrMeta+s");

    await expect(page.locator("body")).toContainText("has changed on disk since");
    // The write did land, and alabs neither claims it nor undoes it.
    expect(onDisk("defiance/lost.txt")).toBe("did this land?");
    expect(saves).toHaveLength(1);
    await expect(page.locator("footer")).toContainText("1 unsaved");
    // Nothing was confirmed, so the draft stays.
    await expect.poll(() => server.drafts().map((d) => d.relPath)).toContain("defiance/lost.txt");

    // The way out is the user's: Refresh shows what is really there.
    await page.unroute("**/api/v1/save-file");
    await at(page, "Refresh from disk").click();
    await expect(page.locator("body")).toContainText("Refresh:");
  });
});

test.describe("making things", () => {
  test("a new file and a new folder appear, and a name already taken is refused", async ({ page }) => {
    await open(page);
    await at(page, "defiance").first().click();
    await expect(inTree(page, "defiance/README.md")).toBeVisible();

    await at(page, "New File").click();
    await page.getByPlaceholder("name.ext").fill("fresh.txt");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(inTree(page, "defiance/fresh.txt")).toBeVisible();
    expect(onDisk("defiance/fresh.txt")).toBe("");

    // The same name again: refused, and the file that is there is untouched.
    writeFileSync(join(server.root, "defiance/fresh.txt"), "written by hand\n");
    await at(page, "New File").click();
    await page.getByPlaceholder("name.ext").fill("fresh.txt");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator("body")).toContainText("already exists");
    expect(onDisk("defiance/fresh.txt")).toBe("written by hand\n");
    await page.getByRole("button", { name: "Cancel" }).click();

    await at(page, "New Folder").click();
    await page.getByPlaceholder("name").fill("fresh-folder");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(inTree(page, "defiance/fresh-folder")).toBeVisible();
  });
});

test.describe("the root boundary, now that writing is possible", () => {
  test("nothing can be written outside the root, by path or through a link", async ({ request }) => {
    const { origin, credential } = parts(server.url);
    const outside = join(server.root, "..", "escaped.txt");
    rmSync(outside, { force: true });
    // A link inside the root that points out of it.
    const link = join(server.root, "defiance", "escape-link");
    rmSync(link, { force: true });
    symlinkSync(outside, link);
    writeFileSync(outside, "not alabs' to touch\n");

    const send = (route: string, data: Record<string, unknown>) =>
      request.post(`${origin}/api/v1/${route}`, {
        headers: { Origin: origin, "X-Alabs-Credential": credential, "X-Alabs-Session": "probe" },
        data,
      });
    // This probe holds editing, so what follows is refused by the path rules
    // and not merely by who is asking.
    expect((await send("claim-writing", { takeOver: true })).status()).toBe(200);

    for (const relPath of ["../escaped.txt", "/etc/alabs-escape", "defiance/../../escaped.txt"]) {
      const answer = await send("create-file", { parentRel: "", name: relPath });
      expect(answer.status(), relPath).toBe(422);
    }
    for (const relPath of ["../escaped.txt", "defiance/../../escaped.txt"]) {
      const answer = await send("recreate-file", { relPath, content: "escaped" });
      expect(answer.status(), relPath).toBe(422);
    }
    // Through the link: a save follows it to a file outside the root, which
    // the root handle refuses to reach at all.
    const through = await send("read-file", { relPath: "defiance/escape-link" });
    expect(through.status()).toBe(422);

    expect(readFileSync(outside, "utf8")).toBe("not alabs' to touch\n");
    rmSync(outside, { force: true });
    rmSync(link, { force: true });
    await send("release-writing", {});
  });
});

test.describe("one window edits", () => {
  test("a popup with copied session storage cannot inherit its opener's writing role", async ({ page }) => {
    await openSource(page);
    const popupReady = page.waitForEvent("popup");
    await page.evaluate(() => window.open(location.href, "_blank"));
    const popup = await popupReady;
    try {
      await expect(popup.locator("body")).toContainText("Another alabs window is editing");
      const first = await page.evaluate(() => sessionStorage.getItem("alabs.session"));
      const second = await popup.evaluate(() => sessionStorage.getItem("alabs.session"));
      expect(second).not.toBe(first);
    } finally {
      await popup.close();
    }
  });

  test("a second window opens read-only, takes over when told to, and the first is then refused", async ({ browser }) => {
    const first = await browser.newContext();
    const firstPage = await first.newPage();
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    try {
      await openSource(firstPage);
      await type(firstPage, "# the first window");

      // A second window, in a browsing context of its own: read-only, and it
      // says so rather than filling a buffer that cannot be saved.
      await secondPage.goto(server.url);
      await expect(at(secondPage, "Home").first()).toBeVisible();
      await expect(secondPage.locator("body")).toContainText("Another alabs window is editing");
      await at(secondPage, "defiance").first().click();
      await expand(secondPage, "defiance/src", SOURCE);
      await inTree(secondPage, SOURCE).click();
      const readOnly = secondPage.locator(`.monaco-editor[data-uri$="/${SOURCE}"]`);
      await expect(readOnly).toBeVisible();
      // Read-only asserted by behaviour rather than by whichever input element
      // Monaco chose: typing into it changes nothing, so no buffer fills with
      // edits that have nowhere to go.
      await readOnly.click();
      await secondPage.keyboard.type("must not appear");
      await expect(readOnly).not.toContainText("must not appear");
      await expect(secondPage.locator("footer")).toContainText("0 unsaved");

      // The user takes over, explicitly.
      await secondPage.getByRole("button", { name: "Take over editing" }).click();
      await expect(secondPage.locator("body")).toContainText("This window is editing now");

      // The first window only finds out when it tries to write. Its edits
      // are still there, and nothing of them reached the file.
      const before = onDisk(SOURCE);
      await firstPage.keyboard.press("ControlOrMeta+s");
      await expect(firstPage.locator("body")).toContainText("Another alabs window is editing");
      expect(onDisk(SOURCE)).toBe(before);
      await expect(firstPage.locator("footer")).toContainText("1 unsaved");
      // And losing editing never loses the work: it is still kept.
      await expect.poll(() => server.drafts().map((d) => d.relPath)).toContain(SOURCE);

      // The window that took over can write.
      await type(secondPage, "# the second window");
      await secondPage.keyboard.press("ControlOrMeta+s");
      await expect(secondPage.locator("body")).toContainText("Saved src/main.py.");
      expect(onDisk(SOURCE)).toBe("# the second window");
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("editing is decided where the change runs, not by whether a control was clickable", async ({ request }) => {
    const { origin, credential } = parts(server.url);
    const send = (session: string, route: string, data: Record<string, unknown>) =>
      request.post(`${origin}/api/v1/${route}`, {
        headers: { Origin: origin, "X-Alabs-Credential": credential, "X-Alabs-Session": session },
        data,
      });
    expect((await send("one", "claim-writing", { takeOver: true })).status()).toBe(200);

    // A window that never asked, asking the operation directly.
    const refused = await send("two", "create-file", { parentRel: "", name: "sneaked-in.txt" });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toContain("another alabs window is editing");
    expect(existsSync(join(server.root, "sneaked-in.txt"))).toBe(false);

    // A request that will not even say which window it is.
    const nameless = await request.post(`${origin}/api/v1/create-file`, {
      headers: { Origin: origin, "X-Alabs-Credential": credential },
      data: { parentRel: "", name: "nameless.txt" },
    });
    expect(nameless.status()).toBe(422);
    expect(existsSync(join(server.root, "nameless.txt"))).toBe(false);

    await send("one", "release-writing", {});
  });
});
