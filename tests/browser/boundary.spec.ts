/**
 * The boundary around the operations, probed directly rather than through the
 * page: what a page on this machine could try if it went looking for alabs.
 *
 * Every one of these must be refused before any operation runs. `request`
 * here is Playwright's own client, so it sends exactly the headers named and
 * nothing a browser would add on its own.
 */
import { expect, test } from "@playwright/test";
import { makeRoot, parts, serve, type Served } from "./serve";

let server: Served;
let origin: string;
let credential: string;

test.beforeAll(async () => {
  server = await serve(makeRoot());
  ({ origin, credential } = parts(server.url));
});

test.afterAll(() => server?.stop());

const REFUSED = "this request did not come from the alabs page this process launched";

test("a request with the credential, this origin and this host is admitted", async ({ request }) => {
  const answer = await request.post(`${origin}/api/v1/bootstrap`, {
    headers: { Origin: origin, "X-Alabs-Credential": credential },
    data: {},
  });
  expect(answer.status()).toBe(200);
  expect(await answer.json()).toMatchObject({ root: { path: server.root }, canEdit: true });
  // The process names its own lifetime, and it is not a second credential.
  const { serverId } = await (
    await request.post(`${origin}/api/v1/bootstrap`, { headers: { Origin: origin, "X-Alabs-Credential": credential }, data: {} })
  ).json();
  expect(serverId).toMatch(/^[0-9a-f]{32}$/);
  expect(serverId).not.toBe(credential);
});

test.describe("refused before anything runs", () => {
  const cases: Array<[string, () => Record<string, string>]> = [
    ["no credential", () => ({ Origin: origin })],
    ["a wrong credential", () => ({ Origin: origin, "X-Alabs-Credential": "0".repeat(64) })],
    ["a credential of the wrong length", () => ({ Origin: origin, "X-Alabs-Credential": credential.slice(0, 32) })],
    ["a foreign origin", () => ({ Origin: "https://evil.example", "X-Alabs-Credential": credential })],
    ["a null origin", () => ({ Origin: "null", "X-Alabs-Credential": credential })],
    ["no origin at all", () => ({ "X-Alabs-Credential": credential })],
    ["a foreign host", () => ({ Origin: origin, Host: "alabs.example", "X-Alabs-Credential": credential })],
  ];
  for (const [name, headers] of cases) {
    test(name, async ({ request }) => {
      const answer = await request.post(`${origin}/api/v1/list-dir`, { headers: headers(), data: { relPath: "" } });
      expect(answer.status()).toBe(403);
      expect((await answer.json()).error).toBe(REFUSED);
    });
  }

  test("an operation this server does not have, even with the credential", async ({ request }) => {
    // `open-subject` above all: there is no route that could replace the
    // root this process opened, with or without a credential.
    for (const route of ["open-subject", "move-item", "trash-item", "nonsense"]) {
      const answer = await request.post(`${origin}/api/v1/${route}`, {
        headers: { Origin: origin, "X-Alabs-Credential": credential },
        data: {},
      });
      expect(answer.status(), route).toBe(404);
      expect((await answer.json()).error, route).toBe("alabs has no such operation");
    }
  });
});

test.describe("the operations that change files are behind the same door", () => {
  // Admission comes first: a request that is not from this page is refused
  // before anything asks whether it is the window that edits.
  const writes: Array<[string, Record<string, unknown>]> = [
    ["save-file", { relPath: "README.md", content: "x", expected: { identity: "1:1", mtime_secs: 0, mtime_nanos: 0, len: 0 } }],
    ["recreate-file", { relPath: "new.md", content: "x" }],
    ["create-file", { parentRel: "", name: "new.md" }],
    ["create-dir", { parentRel: "", name: "new" }],
    ["claim-writing", { takeOver: true }],
    ["recovery-put", { relPath: "a.md", stamp: null, revision: 1, contents: "x" }],
    ["recovery-drop", { relPath: "a.md", revision: 1 }],
    ["recovery-list", {}],
  ];
  for (const [route, data] of writes) {
    test(`${route} is refused from a foreign origin, before it runs`, async ({ request }) => {
      const answer = await request.post(`${origin}/api/v1/${route}`, {
        headers: { Origin: "https://evil.example", "X-Alabs-Credential": credential, "X-Alabs-Session": "probe" },
        data,
      });
      expect(answer.status()).toBe(403);
      expect((await answer.json()).error).toBe(REFUSED);
    });
  }
});

test.describe("the root boundary still holds over HTTP", () => {
  const outside = ["../..", "/etc/passwd", "defiance/../../..", "defiance/../../../../etc/hosts"];
  for (const relPath of outside) {
    test(`${relPath} is refused`, async ({ request }) => {
      const answer = await request.post(`${origin}/api/v1/read-file`, {
        headers: { Origin: origin, "X-Alabs-Credential": credential },
        data: { relPath },
      });
      expect(answer.status()).toBe(422);
      expect((await answer.json()).error).toContain("outside the subject");
    });
  }

  test("only the built assets are web resources; the root is not", async ({ request }) => {
    for (const path of ["/README.md", "/defiance/src/main.py", "/assets/../../package.json", "/../../../etc/passwd"]) {
      const answer = await request.get(`${origin}${path}`, { maxRedirects: 0 });
      expect(answer.status(), path).toBe(404);
    }
  });
});

test("an oversized body is refused, and nothing it carried is kept", async ({ request }) => {
  const send = (text: string) =>
    request.post(`${origin}/api/v1/save-ui-state`, {
      headers: { Origin: origin, "X-Alabs-Credential": credential, "Content-Type": "application/json" },
      data: JSON.stringify({ text }),
    });
  // The layout's own cap is 1 MB, and it is the core that says so, whatever
  // the transport was willing to carry.
  const tooMuchLayout = await send("a".repeat(2 * 1024 * 1024));
  expect(tooMuchLayout.status()).toBe(422);
  expect((await tooMuchLayout.json()).error).toContain("too large");

  // And a body past what the transport will carry at all is refused as it
  // arrives, so the server may answer 413 or simply stop listening while the
  // client is still writing. Either is a refusal.
  const refusal = await send("a".repeat(20 * 1024 * 1024)).then(
    (answer) => answer.status(),
    () => "closed" as const,
  );
  expect([413, "closed"]).toContain(refusal);

  await expect(send("{}")).resolves.toBeTruthy();
  const stored = await request.post(`${origin}/api/v1/load-ui-state`, {
    headers: { Origin: origin, "X-Alabs-Credential": credential },
    data: {},
  });
  expect(await stored.json()).toBe("{}");
});

test("a file alabs will open is a file alabs can save and can keep a draft of", async ({ request }) => {
  // The transport must carry the largest thing one operation can mean: a
  // whole 2 MB file. What comes back is the core's own answer — a refusal
  // about the stamp, or the draft being stored — never a refusal about size.
  const big = "x".repeat(2 * 1024 * 1024);
  const headers = { Origin: origin, "X-Alabs-Credential": credential, "X-Alabs-Session": "probe" };

  const saved = await request.post(`${origin}/api/v1/save-file`, {
    headers,
    data: { relPath: "README.md", content: big, expected: { identity: "1:1", mtime_secs: 0, mtime_nanos: 0, len: 0 } },
  });
  expect(saved.status()).toBe(409);
  expect((await saved.json()).error).toContain("another alabs window is editing");

  const kept = await request.post(`${origin}/api/v1/recovery-put`, {
    headers,
    data: { relPath: "big.txt", stamp: null, revision: 1, contents: big },
  });
  expect(kept.status()).toBe(200);
  expect(await kept.json()).toEqual({ revision: 1 });
  await request.post(`${origin}/api/v1/recovery-drop`, { headers, data: { relPath: "big.txt", revision: 1 } });
});

test("the served page carries the policy that keeps it from being framed or reaching out", async ({ request }) => {
  const answer = await request.get(`${origin}/`);
  const csp = answer.headers()["content-security-policy"];
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(answer.headers()["x-content-type-options"]).toBe("nosniff");
  expect(answer.headers()["referrer-policy"]).toBe("no-referrer");
  // No CORS: nothing off this origin is ever invited in.
  expect(answer.headers()["access-control-allow-origin"]).toBeUndefined();
});

test("no preflight is ever answered, so the credential header cannot cross an origin", async ({ request }) => {
  // The credential travels in a custom header, which a cross-origin page can
  // only send after a successful preflight. None is granted, from any origin,
  // and no response anywhere carries a CORS header.
  for (const from of ["https://evil.example", origin, "null"]) {
    const answer = await request.fetch(`${origin}/api/v1/list-dir`, {
      method: "OPTIONS",
      headers: {
        Origin: from,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-alabs-credential",
      },
    });
    expect(answer.status(), from).toBe(403);
    for (const [name] of Object.entries(answer.headers())) {
      expect(name.toLowerCase().startsWith("access-control"), `${from} -> ${name}`).toBe(false);
    }
  }
});
