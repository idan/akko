/**
 * A3 — standalone-server integration (doc 14/15): drive the **real** `jazz-worker.ts`
 * exports end-to-end against a standalone Jazz server, closing the gap that these were
 * "covered only by manual probes." Unlike `jazz-projector.test.ts` (which calls
 * `createJazzContext(...).asBackend(...)` inline) and `jazz-read-acl.test.ts` (which calls
 * `deploy(...)` inline), this exercises `deployAkkoSchema` + `createBackendDb` themselves.
 *
 * Full vertical: server + issuer → deploy schema+policies (worker) → backend Db (worker)
 * → JazzProjector projects finalized messages → a workspace-member JWT reads them back
 * through the row policy. In-process (`startLocalJazzServer`), so no external process or
 * model is needed and it runs in the default `bun test`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createJazzContext } from "jazz-tools/backend";
import { startLocalJazzServer, startTestJwtIssuer, type LocalJazzServerHandle, type TestJwtIssuerHandle } from "jazz-tools/testing";
import { app } from "@akko/schema";
import type { CommittedEntry, EntryId, PrincipalId, SessionId, SessionRef, WorkspaceId } from "@akko/core";
import { createBackendDb, deployAkkoSchema, workerConfigFromEnv } from "../src/jazz-worker.ts";
import { JazzProjector } from "../src/jazz-projector.ts";

describe("workerConfigFromEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const clear = () => {
    for (const k of ["JAZZ_SYNC", "JAZZ_APP_ID", "JAZZ_BACKEND_SECRET", "JAZZ_ADMIN_SECRET"]) delete process.env[k];
  };

  test("undefined when the required vars are missing", () => {
    clear();
    expect(workerConfigFromEnv()).toBeUndefined();
  });

  test("undefined when only some required vars are set", () => {
    clear();
    process.env.JAZZ_SYNC = "http://s";
    process.env.JAZZ_APP_ID = "app";
    expect(workerConfigFromEnv()).toBeUndefined(); // missing backend secret
  });

  test("reads the full config, including the optional admin secret", () => {
    clear();
    process.env.JAZZ_SYNC = "http://s";
    process.env.JAZZ_APP_ID = "app";
    process.env.JAZZ_BACKEND_SECRET = "bs";
    process.env.JAZZ_ADMIN_SECRET = "as";
    expect(workerConfigFromEnv()).toEqual({ serverUrl: "http://s", appId: "app", backendSecret: "bs", adminSecret: "as" });
  });

  test("omits the admin secret when unset (projector still enabled)", () => {
    clear();
    process.env.JAZZ_SYNC = "http://s";
    process.env.JAZZ_APP_ID = "app";
    process.env.JAZZ_BACKEND_SECRET = "bs";
    expect(workerConfigFromEnv()).toEqual({ serverUrl: "http://s", appId: "app", backendSecret: "bs", adminSecret: undefined });
  });
});

describe("standalone-server integration (worker deploy + backend Db + projector)", () => {
  let server: LocalJazzServerHandle;
  let issuer: TestJwtIssuerHandle;

  beforeAll(async () => {
    issuer = await startTestJwtIssuer();
    server = await startLocalJazzServer({ inMemory: true, jwksUrl: issuer.jwksUrl, allowLocalFirstAuth: false });
  });
  afterAll(async () => {
    await server?.stop();
    await issuer?.stop();
  });

  const entry = (id: string, msg: unknown, actorId?: string): CommittedEntry => ({
    id: id as EntryId,
    parentId: null,
    entry: msg,
    actorId: actorId as PrincipalId | undefined,
    ts: 1,
  });

  async function poll<T>(fn: () => Promise<T[]>, ms = 4000): Promise<T[]> {
    const deadline = Date.now() + ms;
    let last: T[] = [];
    while (Date.now() < deadline) {
      last = await fn();
      if (last.length > 0) return last;
      await new Promise((r) => setTimeout(r, 150));
    }
    return last;
  }

  test("deployAkkoSchema + createBackendDb project rows a workspace member can read", async () => {
    const config = {
      serverUrl: server.url,
      appId: server.appId,
      backendSecret: server.backendSecret,
      adminSecret: server.adminSecret,
    };

    // Real worker path: publish schema + policies, then get a backend-authenticated Db.
    await deployAkkoSchema(config);
    const backendDb = createBackendDb(config);

    // Project two finalized messages for a wsp_dev session via the real projector.
    const ref: SessionRef = {
      id: "ses_int1" as SessionId,
      workspaceId: "wsp_dev" as WorkspaceId,
      ownerId: "prn_owner" as PrincipalId,
      kind: "conversation",
      createdAt: 0,
      updatedAt: 0,
    };
    const projector = new JazzProjector(backendDb);
    projector.ensureSession(ref);
    await projector.onEntry(ref.id, entry("e1", { role: "user", content: "my name is Ada" }, "prn_owner"));
    await projector.onEntry(ref.id, entry("e2", { role: "assistant", content: [{ type: "text", text: "Hi Ada" }] }));

    // Read back as a wsp_dev member through the deployed row policy (not asBackend).
    const jwt = issuer.jwtForUser("prn_owner", { workspaceId: "wsp_dev" });
    const readerCtx = createJazzContext({
      appId: server.appId,
      serverUrl: server.url,
      backendSecret: server.backendSecret,
      jwksUrl: issuer.jwksUrl,
      driver: { type: "memory" },
    });
    const readerDb = await readerCtx.forRequest(
      new Request("http://x", { headers: { authorization: `Bearer ${jwt}` } }),
      app.wasmSchema,
    );

    const rows = await poll(() => readerDb.all(app.messages.where({ sessionId: "ses_int1" })));
    expect(rows.map((m) => `${m.role}:${m.text}`)).toEqual(["user:my name is Ada", "assistant:Hi Ada"]);
    expect(rows.every((m) => m.workspaceId === "wsp_dev")).toBe(true);
    expect(rows[0]?.authorId).toBe("prn_owner");
    expect(rows[1]?.authorId).toBe("");
  });
});
