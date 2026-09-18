/**
 * What owns what, over the life of one launch.
 *
 * `browser-building.md` section 1: "One process owns one root; changing roots
 * requires restarting with another path. Closing Chrome does not stop the
 * process; Control-C does."
 *
 * The Control-C test stops this file's server, so it comes last and this file
 * has a server of its own.
 */
import { expect, test } from "@playwright/test";
import { makeRoot, parts, serve, type Served } from "./serve";

let server: Served;

test.beforeAll(async () => {
  server = await serve(makeRoot());
});

test.afterAll(() => server?.stop());

test.describe.configure({ mode: "serial" });

test("the root cannot be changed while the process runs", async ({ page, request }) => {
  const { origin, credential } = parts(server.url);
  await page.goto(server.url);
  await expect(page.getByTitle("Home", { exact: true }).first()).toBeVisible();

  // The picker is one door, and it is not there: the rail says the root is
  // this process's rather than offering a control that could only refuse.
  await expect(page.getByRole("button", { name: "Change root…" })).toHaveCount(0);
  await expect(page.locator("nav")).toContainText("One process, one folder");

  // The operation that would replace the handle is the other, and the server
  // has no route for it at all.
  const opened = await request.post(`${origin}/api/v1/open-subject`, {
    headers: { Origin: origin, "X-Alabs-Credential": credential },
    data: { path: "/tmp" },
  });
  expect(opened.status()).toBe(404);

  // The root is what it was, and it is still the one the process opened.
  const after = await request.post(`${origin}/api/v1/bootstrap`, {
    headers: { Origin: origin, "X-Alabs-Credential": credential },
    data: {},
  });
  expect((await after.json()).root.path).toBe(server.root);
});

test("closing Chrome leaves the process running", async ({ browser, request }) => {
  const { origin, credential } = parts(server.url);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.url);
  await expect(page.getByTitle("Home", { exact: true }).first()).toBeVisible();

  // Everything Chrome had: the page, then the whole browsing context.
  await page.close();
  await context.close();

  expect(server.running()).toBe(true);
  const answer = await request.post(`${origin}/api/v1/bootstrap`, {
    headers: { Origin: origin, "X-Alabs-Credential": credential },
    data: {},
  });
  expect(answer.status()).toBe(200);
  expect((await answer.json()).root.path).toBe(server.root);
});

test("the credential is never written down", async ({ page }) => {
  const { credential } = parts(server.url);
  await page.goto(server.url);
  await expect(page.getByTitle("Home", { exact: true }).first()).toBeVisible();
  // Do enough that alabs writes its log and its layout.
  await page.getByTitle("defiance", { exact: true }).first().click();
  await expect(page.getByTitle("defiance/README.md", { exact: true })).toBeVisible();
  await page.getByTitle("defiance/README.md", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "defiance" })).toBeVisible();

  // Not in anything alabs wrote to disk.
  await expect
    .poll(() => server.log().length + 1, { message: "the log should have been written" })
    .toBeGreaterThan(0);
  expect(server.log()).not.toContain(credential);

  // Not anywhere in the page but this tab's session storage.
  const kept = await page.evaluate(() => ({
    url: location.href,
    session: Object.entries(sessionStorage),
    local: Object.entries(localStorage),
    cookie: document.cookie,
    html: document.documentElement.outerHTML,
  }));
  expect(kept.url).not.toContain(credential);
  expect(kept.local).toEqual([]);
  expect(kept.cookie).toBe("");
  expect(kept.html).not.toContain(credential);
  // Two things, and only two: the credential, and this window's own name for
  // itself. The name is not a second credential and admits nothing.
  expect(Object.fromEntries(kept.session)).toEqual({
    "alabs.credential": credential,
    "alabs.session": expect.stringMatching(/^[0-9a-f]{16}$/),
  });
});

// Last: this one stops the server.
test("Control-C stops it, and the port is free again", async () => {
  const { origin } = parts(server.url);
  expect(server.running()).toBe(true);
  await server.interrupt();
  expect(server.running()).toBe(false);

  // Nothing is left holding the address.
  const reachable = await fetch(`${origin}/`, { redirect: "manual" }).then(
    () => true,
    () => false,
  );
  expect(reachable).toBe(false);
});
