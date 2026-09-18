/**
 * What checkpoint 2 promises: a real day's *reading* works in real Chrome,
 * against a real root, and nothing hostile in that root gets to run.
 */
import { expect, test, type Page } from "@playwright/test";
import { makeRoot, parts, serve, type Served } from "./serve";

let server: Served;

test.beforeAll(async () => {
  server = await serve(makeRoot());
});

test.beforeEach(() => server.forgetLayout());

test.afterAll(() => server?.stop());

/** The last segment of the root path, which is what Home shows. */
const rootName = () => server.root.split("/").pop()!;

/**
 * alabs names its rows and controls with `title`, so that is what these
 * tests click: it is the same string a person reads on hover, and it does
 * not move when the visible glyphs do.
 */
const at = (page: Page, title: string) => page.getByTitle(title, { exact: true });

/** Open alabs the way the launcher does, and wait for Home. */
async function open(page: Page): Promise<void> {
  await page.goto(server.url);
  await expect(at(page, "Home").first()).toBeVisible();
  await expect(page.locator("body")).toContainText(rootName());
}

/** Enter the work place and wait for its file tree. */
async function enterDefiance(page: Page): Promise<void> {
  await at(page, "defiance").first().click();
  await expect(at(page, "defiance/README.md")).toBeVisible();
}

test.describe("launching", () => {
  test("opens the root the process owns, and takes the credential out of the address", async ({ page }) => {
    await open(page);
    // The address bar is clean: the credential is not in the URL that a
    // screenshot, a bookmark or a shared link would carry.
    expect(page.url()).toBe(`${parts(server.url).origin}/`);
    expect(page.url()).not.toContain(parts(server.url).credential);
    await expect(at(page, "defiance").first()).toBeVisible();
    // The root came from the server, and nothing in the page can change it.
    // The rail says so where the picker would be, rather than offering a
    // control that could only refuse.
    await expect(page.locator("body")).toContainText(rootName());
    await expect(page.getByRole("button", { name: "Change root…" })).toHaveCount(0);
    await expect(page.locator("nav")).toContainText("One process, one folder");
  });

  test("a tab opened without the credential says so instead of half-working", async ({ page }) => {
    await page.goto(`${parts(server.url).origin}/`);
    await expect(page.locator("body")).toContainText("This page was not opened by alabs");
  });

  test("a reload keeps working and brings the layout back", async ({ page }) => {
    await open(page);
    await enterDefiance(page);
    // The layout is written a moment after it changes, into the server's own
    // state folder. Wait for the write that carries this tab rather than for
    // a length of time, so the reload is reading a layout that includes it.
    const stored = page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/save-ui-state") && (r.request().postData() ?? "").includes("defiance/README.md"),
    );
    await at(page, "defiance/README.md").click();
    await expect(page.locator("footer")).toContainText("defiance · 1 tab");
    await stored;

    await page.reload();
    await expect(page.locator("body")).not.toContainText("This page was not opened by alabs");
    await at(page, "defiance").first().click();
    await expect(page.locator("footer")).toContainText("defiance · 1 tab");
    await expect(page.getByRole("heading", { name: "defiance" })).toBeVisible();
  });
});

test.describe("reading", () => {
  test("shows the saved map, renders Markdown, and opens the real file in Monaco", async ({ page }) => {
    await open(page);

    // The saved Visual View opens from its file alone; no model is involved.
    await at(page, "Open the visual view of defiance").click();
    await expect(page.locator("svg text", { hasText: "src" }).first()).toBeVisible();

    // Markdown is rendered from the real file and sanitized on the way.
    await enterDefiance(page);
    await at(page, "defiance/README.md").click();
    await expect(page.getByRole("heading", { name: "defiance" })).toBeVisible();
    // A link in project documentation renders as its text and nothing more:
    // documentation in the root never becomes something that can navigate
    // this page somewhere else.
    await expect(page.locator("main")).toContainText("a link");
    await expect(page.getByRole("link", { name: "a link" })).toHaveCount(0);

    // Monaco holds the real file, unchanged, and nothing about opening it
    // touches the disk.
    await at(page, "defiance/src").click();
    await at(page, "defiance/src/main.py").click();
    const editor = page.locator(".monaco-editor").first();
    await expect(editor).toContainText("def hello():");
    await expect(page.locator("footer")).toContainText("0 unsaved");
  });

  test("the three knowledge folders stay reachable", async ({ page }) => {
    await open(page);
    for (const [folder, shown, file] of [
      ["context", "Context", "context/brief.md"],
      ["wiki", "Wiki", "wiki/notes.md"],
      ["definitions", "Definitions", "definitions/terms.md"],
    ]) {
      await at(page, folder).first().click();
      await expect(page.locator("footer")).toContainText(shown);
      await expect(at(page, file)).toBeVisible();
    }
  });

  test("what Chrome cannot do yet says so, and changes nothing", async ({ page }) => {
    await open(page);
    await enterDefiance(page);
    // Delete and Move stay deferred: external file operations are Finder's,
    // followed by Refresh. The page has no control for either and the server
    // has no route for either, so asking directly is the only way to check —
    // and it changes nothing.
    const refused = await page.evaluate(async () => {
      const send = (route: string) =>
        fetch(`/api/v1/${route}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Alabs-Credential": sessionStorage.getItem("alabs.credential") ?? "",
            "X-Alabs-Session": sessionStorage.getItem("alabs.session") ?? "",
          },
          body: JSON.stringify({ relPath: "defiance/README.md" }),
        }).then((r) => r.status);
      return { trash: await send("trash-item"), move: await send("move-item") };
    });
    expect(refused).toEqual({ trash: 404, move: 404 });
    await at(page, "Refresh from disk").click();
    await expect(at(page, "defiance/README.md")).toBeVisible();
  });
});

test.describe("hostile content", () => {
  test("neither a script in Markdown nor one in a saved map ever runs", async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", (d) => dialogs.push(d.message()));
    await open(page);
    await at(page, "Open the visual view of defiance").click();
    await expect(page.locator("svg text", { hasText: "src" }).first()).toBeVisible();
    await at(page, "defiance/README.md").click();
    await expect(page.getByRole("heading", { name: "defiance" })).toBeVisible();

    const ran = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        mdScript: w.__mdScript ?? null,
        mdAttr: w.__mdAttr ?? null,
        svgScript: w.__svgScript ?? null,
        svgAttr: w.__svgAttr ?? null,
        scripts: document.querySelectorAll("main script").length,
        handlers: document.querySelectorAll("main [onerror], main [onload], main [onclick]").length,
      };
    });
    expect(ran).toEqual({ mdScript: null, mdAttr: null, svgScript: null, svgAttr: null, scripts: 0, handlers: 0 });
    expect(dialogs).toEqual([]);
  });
});

test.describe("offline", () => {
  test("a whole session asks for nothing but this origin, and loads nothing remote", async ({ page }) => {
    const { origin } = parts(server.url);
    const local = (url: string) => url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:");
    const foreign: string[] = [];
    page.on("request", (r) => local(r.url()) || foreign.push(r.url()));
    // A page that tried to reach out and was stopped by the policy would
    // still be a page that tried; count those too.
    const blocked: string[] = [];
    page.on("requestfailed", (r) => local(r.url()) || blocked.push(r.url()));

    await open(page);
    // The surfaces that could plausibly pull something in: a rendered map, a
    // Markdown file with a link in it, and Monaco with its language workers.
    await at(page, "Open the visual view of defiance").click();
    await expect(page.locator("svg text", { hasText: "src" }).first()).toBeVisible();
    await at(page, "defiance/README.md").click();
    await expect(page.getByRole("heading", { name: "defiance" })).toBeVisible();
    await at(page, "defiance/src").click();
    await at(page, "defiance/src/main.py").click();
    await expect(page.locator(".monaco-editor").first()).toContainText("def hello():");
    await at(page, "wiki").first().click();
    await expect(at(page, "wiki/notes.md")).toBeVisible();

    expect(foreign).toEqual([]);
    expect(blocked).toEqual([]);

    // What the page actually loaded, as the browser recorded it, rather than
    // what it was seen asking for.
    const loaded: string[] = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((e) => e.name),
    );
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((url) => !local(url))).toEqual([]);
  });
});
