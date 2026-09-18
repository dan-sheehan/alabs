/** Browser generation uses the shared Raven workflow and real file operations.
 * Deterministic failures stub only inference. ALABS_TEST_OLLAMA=1 additionally
 * exercises the actual configured local model on this disposable material.
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRoot, serve, type Served } from "./serve";

test.use({ actionTimeout: 10_000 });

let server: Served;
test.beforeEach(async () => { server = await serve(makeRoot()); });
test.afterEach(() => server?.stop());
const at = (page: Page, title: string) => page.getByTitle(title, { exact: true });
const raven = (page: Page) => page.getByRole("button", { name: "Run Raven", exact: true });
const viewDir = () => join(server.root, "views/defiance");
const savedPair = () => ["map.svg", "view.json"].map((name) => readFileSync(join(viewDir(), name), "utf8"));
const placeMap = {
  version: 1, title: "defiance", summary: "A work place with a readme and a saved view.",
  groups: [{ id: "source", label: "Source", note: "" }],
  landmarks: [{ id: "hello", groupId: "source", label: "hello", note: "", paths: ["src/main.py"] }],
  connections: [],
};
const rootMap = {
  version: 1, title: "alabs root",
  places: [{ placeId: "defiance", description: "A work place with a readme and a saved view.", highlightIds: ["hello"] }],
  knowledge: [{ role: "Context" }, { role: "Wiki" }, { role: "Definitions" }],
};
async function openView(page: Page) {
  await page.goto(server.url);
  await at(page, "Open the visual view of defiance").click();
  await expect(page.locator(".view-canvas svg")).toBeVisible();
}

async function probe(page: Page, route: string, body: unknown) {
  return page.evaluate(async ({ route, body }) => {
    const response = await fetch(`/api/v1/${route}`, {
      method: "POST", headers: {
        "Content-Type": "application/json",
        "X-Alabs-Credential": sessionStorage.getItem("alabs.credential") ?? "",
        "X-Alabs-Session": sessionStorage.getItem("alabs.session") ?? "",
      }, body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  }, { route, body });
}

test("Raven reads incrementally, saves portable place and Home maps, and Refresh never generates", async ({ page }) => {
  const prompts: string[] = [];
  let rootCalls = 0;
  const remote: string[] = [];
  page.on("request", (req) => { if (!req.url().startsWith("http://127.0.0.1:43821/")) remote.push(req.url()); });
  writeFileSync(join(server.root, "defiance/.env"), "SYNTHETIC_PRIVATE_VALUE=never-in-the-prompt\n");
  await page.route("**/api/v1/generate-local-model-json", async (route) => {
    const args = route.request().postDataJSON();
    expect(args.model).toBe("qwen3.5:9b");
    expect(args.expectedSession).toBeGreaterThan(0);
    prompts.push(args.prompt);
    const isRoot = args.prompt.startsWith("=== ALABS ROOT ===");
    if (isRoot) rootCalls += 1;
    const value = isRoot ? (rootCalls === 1 ? { ...rootMap, knowledge: ["Context", "Wiki", "Definitions"] } : rootMap) :
      prompts.length === 1 ? { action: "read", path: "src/main.py" } : placeMap;
    await route.fulfill({ json: { kind: "answer", model: args.model, text: JSON.stringify(value) } });
  });
  await openView(page);
  expect(prompts).toHaveLength(0);
  const source = readFileSync(join(server.root, "defiance/src/main.py"), "utf8");
  await raven(page).click();
  await expect.poll(() => savedPair()[1]).toContain('"hello"');
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('return "world"');
  expect(prompts.join("\n")).not.toContain("never-in-the-prompt");
  await expect(page.locator(".view-canvas svg")).toContainText("hello");
  await page.locator(".view-canvas [data-landmark]").first().click();
  await page.locator(".view-inspector").getByTitle("defiance/src/main.py", { exact: true }).click();
  await expect(page.locator(".monaco-editor").first()).toContainText("def hello():");
  await at(page, "Home").first().click();
  await raven(page).click();
  const rootFile = join(server.root, "views/.root/view.json");
  await expect.poll(() => existsSync(rootFile)).toBe(true);
  expect(rootCalls).toBe(2);
  const map = JSON.parse(readFileSync(rootFile, "utf8"));
  expect(map.places.map((p: { placeId: string }) => p.placeId)).toEqual(["defiance"]);
  expect(map.knowledge.map((k: { role: string }) => k.role)).toEqual(["context", "wiki", "definitions"]);
  const calls = prompts.length;
  await page.locator(".root-view").getByRole("button", { name: "Refresh", exact: true }).click();
  await at(page, "Open the visual view of defiance").click();
  await expect(page.locator(".view-canvas svg")).toContainText("hello");
  expect(prompts).toHaveLength(calls);
  expect(readFileSync(join(server.root, "defiance/src/main.py"), "utf8")).toBe(source);
  expect(remote).toEqual([]);
});

for (const failure of ["unavailable", "not_installed", "timeout", "invalid"] as const) {
  test(`a ${failure} model preserves the saved pair and ordinary navigation`, async ({ page }) => {
    const before = savedPair();
    await page.route("**/api/v1/generate-local-model-json", (route) => route.fulfill({ json:
      failure === "invalid" ? { kind: "answer", model: "qwen3.5:9b", text: "not a map" } : { kind: failure, model: "qwen3.5:9b" },
    }));
    await openView(page);
    await raven(page).click();
    await expect(page.locator(".view-build-status")).toContainText(failure === "unavailable" ? "Local model unavailable" : failure === "not_installed" ? "Raven needs qwen3.5:9b" : "could not be built");
    expect(savedPair()).toEqual(before);
    await expect(page.locator(".view-canvas svg")).toContainText("src");
    await at(page, "defiance").first().click();
    await page.locator("aside.sidebar").getByTitle("defiance/README.md", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "defiance" })).toBeVisible();
  });
}

test("a takeover during inference refuses the old window's generated pair", async ({ page, context }) => {
  const before = savedPair();
  let arrived!: () => void;
  const pending = new Promise<void>((resolve) => { arrived = resolve; });
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  await page.route("**/api/v1/generate-local-model-json", async (route) => {
    arrived(); await held;
    await route.fulfill({ json: { kind: "answer", model: "qwen3.5:9b", text: JSON.stringify(placeMap) } });
  });
  await openView(page);
  await raven(page).click(); await pending;
  const other = await context.newPage();
  await other.goto(server.url);
  const taken = await probe(other, "claim-writing", { takeOver: true });
  expect(taken.value.writing).toBe(true);
  finish();
  await expect(page.locator(".view-build-status")).toContainText("could not be built");
  expect(savedPair()).toEqual(before);
});

test("a read-only window explains ownership before starting Raven", async ({ page, context }) => {
  await openView(page);
  const other = await context.newPage();
  let calls = 0;
  await other.route("**/api/v1/generate-local-model-json", (route) => route.fulfill({ json: { kind: "unavailable" } }));
  other.on("request", (r) => { if (r.url().endsWith("/generate-local-model-json")) calls += 1; });
  await openView(other);
  await raven(other).click();
  await expect(other.locator(".notice")).toContainText("Another alabs window is editing");
  expect(calls).toBe(0);
  expect(savedPair()[1]).not.toContain('"hello"');
});

/** Stop promptly on an explicit failure rather than waiting for a file that
 * the application has already said it will not write. Success criteria stay
 * actual files and a rendered map; a failure is never treated as a pass.
 */
async function generated(page: Page, ready: () => boolean, timeout: number) {
  let state = "pending";
  await expect.poll(async () => {
    state = ready() ? "built" : /could not be built|Local model unavailable|Raven needs/.test(await page.locator("main").innerText()) ? "failed" : "pending";
    return state;
  }, { timeout }).not.toBe("pending");
  expect(state, server.log()).toBe("built");
}

test("actual configured Ollama model generates a place map and Home map in Chrome", async ({ page }, testInfo) => {
  test.skip(process.env.ALABS_TEST_OLLAMA !== "1", "Run with ALABS_TEST_OLLAMA=1 for local model acceptance");
  test.setTimeout(2_200_000);
  const responses: { status: number; kind: string }[] = [];
  page.on("response", async (r) => {
    if (r.url().endsWith("/generate-local-model-json")) responses.push({ status: r.status(), kind: (await r.json()).kind });
  });
  await openView(page);
  const installed = await probe(page, "list-local-models", {});
  expect(installed.status).toBe(200);
  expect(installed.value.names).toContain("qwen3.5:9b");
  const before = savedPair();
  await raven(page).click();
  await generated(page, () => savedPair()[1] !== before[1], 900_000);
  const facts = JSON.parse(savedPair()[1]);
  expect(facts.landmarks.length).toBeGreaterThan(0);
  for (const landmark of facts.landmarks) {
    for (const path of landmark.paths) expect(existsSync(join(server.root, "defiance", path))).toBe(true);
  }
  await expect(page.locator(".view-canvas svg")).toBeVisible();
  writeFileSync(testInfo.outputPath("generated-place.json"), savedPair()[1]);
  writeFileSync(testInfo.outputPath("generated-place.svg"), savedPair()[0]);
  await page.screenshot({ path: testInfo.outputPath("live-place.png") });
  await at(page, "Home").first().click();
  await raven(page).click();
  const rootFile = join(server.root, "views/.root/view.json");
  await generated(page, () => existsSync(rootFile), 1_220_000);
  const home = JSON.parse(readFileSync(rootFile, "utf8"));
  expect(home.places.map((p: { placeId: string }) => p.placeId)).toEqual(["defiance"]);
  await expect(page.locator(".root-view .view-canvas svg")).toBeVisible();
  writeFileSync(testInfo.outputPath("generated-root.json"), JSON.stringify(home, null, 2));
  writeFileSync(testInfo.outputPath("generated-root.svg"), readFileSync(join(server.root, "views/.root/map.svg")));
  writeFileSync(testInfo.outputPath("generation.log"), server.log());
  await page.screenshot({ path: testInfo.outputPath("live-root.png") });
  expect(responses.length).toBeGreaterThanOrEqual(2);
  expect(responses.every((r) => r.status === 200 && r.kind === "answer")).toBe(true);
});

test("actual configured Ollama model answers an explicit Wiki question in Chrome", async ({ page }, testInfo) => {
  test.skip(process.env.ALABS_TEST_OLLAMA !== "1", "Run with ALABS_TEST_OLLAMA=1 for local model acceptance");
  test.setTimeout(150_000);
  await page.goto(server.url);
  await at(page, "wiki").first().click();
  await page.getByRole("button", { name: "Choose a local model…" }).click();
  await page.getByLabel("Local model", { exact: true }).selectOption("qwen3.5:9b");
  await page.getByPlaceholder("What do I want to know?").fill("What does wiki/notes.md say? Answer in one short sentence.");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".ask-answer")).not.toBeEmpty({ timeout: 130_000 });
  writeFileSync(testInfo.outputPath("wiki-answer.txt"), await page.locator(".ask-answer").innerText());
});
