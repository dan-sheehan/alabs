/**
 * What checkpoint 4 promises: a real day's *work* is practical in Chrome.
 *
 * Search inside a place, see what has changed in a repository, hand a task to
 * a coding tool, keep the layout across a reload, and pick up a change made
 * outside alabs through Refresh. Each of these already existed on the desktop;
 * what is checked here is that the browser reaches the same operations,
 * through the one narrow API, against a real root.
 */
import { expect, test, type Page } from "@playwright/test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRoot, serve, type Served } from "./serve";

let server: Served;

test.beforeAll(async () => {
  server = await serve(makeRoot());
});

test.beforeEach(() => server.forgetLayout());

test.afterAll(() => server?.stop());

const at = (page: Page, title: string) => page.getByTitle(title, { exact: true });

/** The file tree and the tab strip name the same paths; tree clicks are scoped. */
const inTree = (page: Page, title: string) => page.locator("aside.sidebar").getByTitle(title, { exact: true });

const rootName = () => server.root.split("/").pop()!;

async function open(page: Page): Promise<void> {
  await page.goto(server.url);
  await expect(at(page, "Home").first()).toBeVisible();
  await expect(page.locator("body")).toContainText(rootName());
}

async function enterDefiance(page: Page): Promise<void> {
  await at(page, "defiance").first().click();
  await expect(inTree(page, "defiance/README.md")).toBeVisible();
}

/** One search from the sidebar, waited out to its summary line. */
async function search(page: Page, query: string): Promise<void> {
  const sidebar = page.locator("aside.sidebar");
  const box = sidebar.getByLabel("Search in defiance");
  if ((await box.count()) === 0) await sidebar.getByRole("button", { name: "Search", exact: true }).click();
  await box.fill(query);
  await box.press("Enter");
  await expect(sidebar.locator(".search-note")).not.toContainText("Searching…");
}

/** The one API probe the page can make, with this tab's own credential. */
async function probe(page: Page, route: string, body: unknown): Promise<{ status: number; text: string }> {
  return page.evaluate(
    async ([route, body]) => {
      const response = await fetch(`/api/v1/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Alabs-Credential": sessionStorage.getItem("alabs.credential") ?? "",
          "X-Alabs-Session": sessionStorage.getItem("alabs.session") ?? "",
        },
        body: body as string,
      });
      return { status: response.status, text: await response.text() };
    },
    [route, JSON.stringify(body)] as const,
  );
}

test.describe("search", () => {
  test("finds text in the place, opens the hit at its line, and replaces itself", async ({ page }) => {
    await open(page);
    await enterDefiance(page);

    await search(page, "hello");
    await expect(page.locator(".search-note")).toContainText("1 match");
    await expect(page.locator(".search-results")).toContainText("src/main.py");

    // The hit opens the real file, in Monaco, at the line that matched.
    await at(page, "defiance/src/main.py:1").click();
    await expect(page.locator(".monaco-editor").first()).toContainText("def hello():");

    // A second search replaces the first outright: nothing of the old one is
    // left, and a late batch of it could not be shown if one arrived.
    await search(page, "world");
    await expect(page.locator(".search-results")).not.toContainText("def hello");
    await expect(page.locator(".search-note")).toContainText("1 match");

    // A query with nothing to find says so rather than leaving the old hits.
    await search(page, "nothing-here-at-all");
    await expect(page.locator(".search-note")).toContainText("No matches in defiance");
  });

  test("is bound to the place: the root beside it is never walked", async ({ page }) => {
    writeFileSync(join(server.root, "README.md"), "# Test root\n\nthe-needle lives here\n");
    await open(page);
    await enterDefiance(page);
    await search(page, "the-needle");
    await expect(page.locator(".search-note")).toContainText("No matches in defiance");

    // And the scope cannot be widened from the page: a scope that is not a
    // folder inside the root is refused before anything is streamed at all.
    const refused = await probe(page, "search-subject", { query: "the-needle", searchId: 99, scope: ".." });
    expect(refused.status).toBe(422);
    expect(refused.text).toContain("scope");
  });
});

test.describe("Git and the handoff", () => {
  test("Changes lists what is not yet committed, and a task packet records the baseline", async ({ page, context }) => {
    // A change made outside alabs, which is how work actually arrives.
    appendFileSync(join(server.root, "defiance/src/main.py"), '\ndef goodbye():\n    return "later"\n');
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page);
    await enterDefiance(page);

    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await expect(page.locator(".changes-header")).toContainText("Not yet committed");
    const row = page.locator(".changes-list").getByTitle("src/main.py", { exact: true });
    await expect(row).toContainText("changed");

    // One file's comparison: both sides come from Git, through the same
    // bounded helper, and neither is a file this page may fetch.
    await row.click();
    await expect(page.locator(".changes-diff")).toContainText("def goodbye():");

    // The handoff. A rendered Markdown tab is a context candidate, so the
    // README is opened first and then ticked.
    await page.getByRole("tab", { name: "⌂ Overview" }).click();
    await inTree(page, "defiance/README.md").click();
    await page.getByRole("tab", { name: "⌂ Overview" }).click();
    await page.getByRole("button", { name: "Task…", exact: true }).click();
    await page.getByPlaceholder("What should the coding tool do in defiance?").fill("Add a farewell to the module.");
    await page.locator(".task-row", { hasText: "defiance/README.md" }).getByRole("checkbox").check();
    await page.getByRole("button", { name: "Copy task packet" }).click();
    await expect(page.getByRole("status")).toContainText("Task packet copied · 1 context file");

    const packet = await page.evaluate(() => navigator.clipboard.readText());
    expect(packet).toContain("Work folder: defiance");
    expect(packet).toContain(`Root: ${server.root}`);
    expect(packet).toContain("Add a farewell to the module.");
    expect(packet).toContain("defiance/README.md");

    // Copying recorded the commit the tool is starting from, so the Changes
    // tab can now answer the two questions that need one.
    await page.getByRole("tab", { name: "⌂ Overview" }).click();
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    // The working copy was already dirty when the packet was copied, so the
    // question alabs can answer honestly is what has been committed since —
    // and it says when the task started, until the next Refresh.
    await expect(page.locator(".changes-header")).toContainText("Commits since task started");
    await expect(page.locator(".changes-header")).toContainText("Task started");
  });

  test("the Terminal handoff is a real operation, behind the same gate as every other", async ({ page }) => {
    await open(page);
    await enterDefiance(page);
    await page.getByRole("button", { name: "Task…", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open in Terminal" })).toBeEnabled();

    // Deliberately not clicked: it would open Terminal.app on whoever runs
    // these tests. What is checked here is that the operation exists on the
    // server — a 404 would be the page saying it cannot do this yet — and
    // that a place outside the root never reaches the program.
    const outside = await probe(page, "open-terminal", { place: "../defiance" });
    expect(outside.status).toBe(422);
  });
});

test.describe("the keys alabs takes in Chrome", () => {
  test("Refresh, Home and Search are alabs'; reload stays Chrome's on Shift", async ({ page }) => {
    await open(page);
    await enterDefiance(page);
    // A marker that only survives while this document does, so a reload is
    // told apart from alabs acting on the key.
    await page.evaluate(() => ((window as unknown as { __alive?: boolean }).__alive = true));

    // Command-R is alabs' Refresh from disk, not Chrome's reload.
    await page.keyboard.press("ControlOrMeta+r");
    await expect(page.getByRole("status")).toContainText("Refresh:");
    expect(await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive ?? false)).toBe(true);

    // Command-Shift-F opens search in the place and puts the cursor in it.
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await expect(page.locator("aside.sidebar").getByLabel("Search in defiance")).toBeFocused();
    await page.keyboard.press("Escape");

    // Command-0 goes Home.
    await page.keyboard.press("ControlOrMeta+0");
    await expect(page.locator("footer")).toContainText("Home");
    expect(await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive ?? false)).toBe(true);

    // And Shift is the way back to Chrome's own reload: alabs does not act on
    // that one at all, so the browser is left holding it. (Whether Chrome then
    // reloads is Chrome's business and cannot be driven from here — a
    // synthetic key never reaches the browser's own shortcut handling.)
    await page.evaluate(() => {
      const w = window as unknown as { __keptShiftR?: boolean };
      w.__keptShiftR = true;
      addEventListener(
        "keydown",
        (e) => {
          if (e.key.toLowerCase() === "r" && e.shiftKey && (e.metaKey || e.ctrlKey) && e.defaultPrevented) {
            w.__keptShiftR = false;
          }
        },
        true,
      );
    });
    await page.keyboard.press("ControlOrMeta+Shift+r");
    expect(await page.evaluate(() => (window as unknown as { __keptShiftR?: boolean }).__keptShiftR ?? false)).toBe(true);
    await expect(at(page, "Home").first()).toBeVisible();
  });
});

test.describe("layout", () => {
  test("is remembered, and never chooses the root", async ({ page }) => {
    await open(page);
    await enterDefiance(page);
    const stored = page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/save-ui-state") && (r.request().postData() ?? "").includes("defiance/src/main.py"),
    );
    await inTree(page, "defiance/src").click();
    await inTree(page, "defiance/src/main.py").click();
    await expect(page.locator("footer")).toContainText("defiance · 1 tab");
    await stored;

    // What was remembered belongs to the root the server owns.
    const kept = await probe(page, "load-ui-state", {});
    const layout = JSON.parse(JSON.parse(kept.text) as string) as { root: string };
    expect(layout.root).toBe(server.root);

    // A layout file naming another root is still only a layout: the root
    // comes from the server's bootstrap, and a layout belonging to a
    // different root is dropped rather than applied to this one.
    writeFileSync(join(server.stateDir, "ui-state.json"), JSON.stringify({ ...layout, root: "/somewhere/else" }));
    await page.reload();
    await expect(at(page, "Home").first()).toBeVisible();
    await expect(page.locator("nav")).toContainText(server.root);
    await expect(page.locator("nav")).not.toContainText("/somewhere/else");
    await enterDefiance(page);
    await expect(page.locator("footer")).toContainText("defiance · 0 tabs");
  });

  test("comes back after a reload, for the place it was made in", async ({ page }) => {
    await open(page);
    await enterDefiance(page);
    const stored = page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/save-ui-state") && (r.request().postData() ?? "").includes("defiance/src/main.py"),
    );
    await inTree(page, "defiance/src").click();
    await inTree(page, "defiance/src/main.py").click();
    await stored;

    await page.reload();
    await at(page, "defiance").first().click();
    await expect(page.locator("footer")).toContainText("defiance · 1 tab");
    await expect(page.locator(".monaco-editor").first()).toContainText("def hello():");
  });
});

test.describe("changes made outside alabs", () => {
  test("are picked up by Refresh, and only by Refresh", async ({ page }) => {
    writeFileSync(join(server.root, "defiance/src/main.py"), 'def hello():\n    return "world"\n');
    await open(page);
    await enterDefiance(page);
    await inTree(page, "defiance/src").click();
    await inTree(page, "defiance/src/main.py").click();
    const editor = page.locator(".monaco-editor").first();
    await expect(editor).toContainText('return "world"');

    writeFileSync(join(server.root, "defiance/src/main.py"), 'def hello():\n    return "elsewhere"\n');
    // Nothing watches the disk: until Refresh is pressed the tab is exactly
    // what it was, which is the point of the manual return path.
    await expect(editor).toContainText('return "world"');

    await at(page, "Refresh from disk").click();
    await expect(page.getByRole("status")).toContainText("1 file changed on disk");
    await expect(editor).toContainText('return "elsewhere"');
    await expect(page.locator("footer")).toContainText("0 unsaved");
  });
});
