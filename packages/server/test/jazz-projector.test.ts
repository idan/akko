/**
 * Proves the Jazz 2.0 projection path in-process (doc 14): the JazzProjector writes
 * finalized messages as rows into the `messages` table via a backend context connected
 * to a local in-memory Jazz server, and a query reads them back — validating
 * backend-projects -> Jazz relational store on Bun, no external server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJazzContext, type Db } from "jazz-tools/backend";
import { startLocalJazzServer, type LocalJazzServerHandle } from "jazz-tools/testing";
import { app } from "@akko/schema";
import type { CommittedEntry, EntryId, PrincipalId, SessionId, SessionRef, WorkspaceId } from "@akko/core";
import { JazzProjector } from "../src/jazz-projector.ts";

let server: LocalJazzServerHandle;
let db: Db;

beforeAll(async () => {
  server = await startLocalJazzServer({ inMemory: true });
  db = createJazzContext({
    appId: server.appId,
    serverUrl: server.url,
    backendSecret: server.backendSecret,
    driver: { type: "memory" },
  }).asBackend(app.wasmSchema);
});
afterAll(async () => {
  await server?.stop();
});

function ref(id: string, title: string): SessionRef {
  return {
    id: id as SessionId,
    workspaceId: "wsp_1" as WorkspaceId,
    ownerId: "owner" as PrincipalId,
    kind: "conversation",
    title,
    createdAt: 0,
    updatedAt: 0,
  };
}
function entry(id: string, msg: unknown, actorId?: string): CommittedEntry {
  return { id: id as EntryId, parentId: null, entry: msg, actorId: actorId as PrincipalId | undefined, ts: 1 };
}
const userMsg = (text: string) => ({ role: "user", content: text });
const assistantMsg = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("JazzProjector (Jazz 2.0 relational)", () => {
  test("projects finalized messages as queryable rows keyed by sessionId", async () => {
    const projector = new JazzProjector(db);
    const r = ref("ses_p1", "Greeting");
    expect(projector.ensureSession(r)).toBe("ses_p1");
    expect(projector.projectionId(r.id)).toBe("ses_p1");

    await projector.onEntry(r.id, entry("e1", userMsg("my name is Ada"), "prn_alice"));
    await projector.onEntry(r.id, entry("e2", assistantMsg("Hi Ada")));

    const rows = await db.all(app.messages.where({ sessionId: "ses_p1" }));
    expect(rows.map((m) => `${m.role}:${m.text}`)).toEqual(["user:my name is Ada", "assistant:Hi Ada"]);
    expect(rows[0]?.authorId).toBe("prn_alice");
    expect(rows[1]?.authorId).toBe("");
  });

  test("ignores non-conversation entries; rows are isolated per session", async () => {
    const projector = new JazzProjector(db);
    projector.ensureSession(ref("ses_p2", "X"));
    await projector.onEntry("ses_p2" as SessionId, entry("e1", { role: "toolResult", content: "x" }));

    const rows = await db.all(app.messages.where({ sessionId: "ses_p2" }));
    expect(rows.length).toBe(0);
  });
});