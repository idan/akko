/**
 * Read-ACL verification (doc 16): does the `messages` row policy actually filter by the
 * reader's `workspaceId` JWT claim? Runs fully in-process against a local Jazz server +
 * Jazz's own test JWT issuer, so it needs no browser and no external IdP.
 *
 * Backend inserts rows for two workspaces (privileged, bypasses policy). A user whose JWT
 * carries `workspaceId: wsp_a` reads via `forRequest(bearer jwt)` and must see ONLY wsp_a
 * rows — proving `ctx.session.workspaceId` maps to the claim and enforces isolation.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJazzContext, type Db } from "jazz-tools/backend";
import { startLocalJazzServer, startTestJwtIssuer, deploy, type LocalJazzServerHandle, type TestJwtIssuerHandle } from "jazz-tools/testing";
import { app, permissions } from "@akko/schema";

let server: LocalJazzServerHandle;
let issuer: TestJwtIssuerHandle;
let backend: Db;

beforeAll(async () => {
  issuer = await startTestJwtIssuer();
  server = await startLocalJazzServer({ inMemory: true, jwksUrl: issuer.jwksUrl, allowLocalFirstAuth: false });
  await deploy({ serverUrl: server.url, appId: server.appId, adminSecret: server.adminSecret, schema: app.wasmSchema, permissions } as Parameters<typeof deploy>[0]);
  backend = createJazzContext({ appId: server.appId, serverUrl: server.url, backendSecret: server.backendSecret, driver: { type: "memory" } }).asBackend(app.wasmSchema);

  const row = (sessionId: string, workspaceId: string, text: string) => ({
    sessionId, workspaceId, role: "user", text, createdAt: new Date(), authorId: "prn_x",
  });
  backend.insert(app.messages, row("ses_a", "wsp_a", "alpha one"));
  backend.insert(app.messages, row("ses_a", "wsp_a", "alpha two"));
  backend.insert(app.messages, row("ses_b", "wsp_b", "beta one"));
  await new Promise((r) => setTimeout(r, 300)); // let the backend writes sync
});

afterAll(async () => {
  await server?.stop();
  await issuer?.stop();
});

function readerFor(workspaceId: string): Promise<Db> {
  const jwt = issuer.jwtForUser("prn_alice", { workspaceId });
  const ctx = createJazzContext({ appId: server.appId, serverUrl: server.url, backendSecret: server.backendSecret, jwksUrl: issuer.jwksUrl, driver: { type: "memory" } });
  return ctx.forRequest(new Request("http://x", { headers: { authorization: `Bearer ${jwt}` } }), app.wasmSchema);
}

async function poll<T>(fn: () => Promise<T[]>, opts: { want: boolean; ms?: number }): Promise<T[]> {
  const deadline = Date.now() + (opts.ms ?? 4000);
  let last: T[] = [];
  while (Date.now() < deadline) {
    last = await fn();
    if (opts.want && last.length > 0) return last; // wait for rows to sync in
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}

describe("Jazz read-ACL (workspaceId claim)", () => {
  test("a wsp_a reader sees only wsp_a rows", async () => {
    const db = await readerFor("wsp_a");
    const rows = await poll(() => db.all(app.messages.where({ sessionId: "ses_a" })), { want: true });
    expect(rows.map((m) => m.text).sort()).toEqual(["alpha one", "alpha two"]);
    const foreign = await db.all(app.messages.where({ sessionId: "ses_b" }));
    expect(foreign).toHaveLength(0);
  });

  test("a wsp_b reader cannot see wsp_a rows", async () => {
    const db = await readerFor("wsp_b");
    // Give sync ample time; wsp_a rows must NEVER appear for a wsp_b reader.
    const rows = await poll(() => db.all(app.messages.where({ sessionId: "ses_a" })), { want: false });
    expect(rows).toHaveLength(0);
  });
});
