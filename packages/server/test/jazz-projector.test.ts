/**
 * Proves the Jazz 2.0 projection path in-process (doc 14): the JazzProjector writes
 * finalized messages as rows into the `messages` table via a backend context connected
 * to a local in-memory Jazz server, and a query reads them back — validating
 * backend-projects -> Jazz relational store on Bun, no external server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJazzContext, type Db } from "jazz-tools/backend";
import { startLocalJazzServer, type LocalJazzServerHandle } from "jazz-tools/testing";
import { InMemoryEventBus } from "@akko/runtime";
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
    // Read-ACL key: every projected row carries the session's workspace (doc 16).
    expect(rows.every((m) => m.workspaceId === "wsp_1")).toBe(true);
  });

  test("ignores non-conversation entries; rows are isolated per session", async () => {
    const projector = new JazzProjector(db);
    projector.ensureSession(ref("ses_p2", "X"));
    await projector.onEntry("ses_p2" as SessionId, entry("e1", { role: "toolResult", content: "x" }));

    const rows = await db.all(app.messages.where({ sessionId: "ses_p2" }));
    expect(rows.length).toBe(0);
  });
});

describe("JazzProjector live activity (thinking + streaming)", () => {
  const emit = (bus: InMemoryEventBus, sessionId: string, event: unknown) =>
    bus.publish({ type: "pi", sessionId: sessionId as SessionId, event } as never);

  // Local-first reads are eventually consistent and **coalesce rapid updates**, so
  // transient states (a brief "thinking" before streaming) are not reliably observable
  // one-shot; we poll for the settled state instead.
  async function poll(sessionId: string, until: (rows: any[]) => boolean, ms = 4000) {
    const deadline = Date.now() + ms;
    let rows: Array<{ kind?: string; userText?: string; text?: string }> = [];
    while (Date.now() < deadline) {
      rows = await db.all(app.activity.where({ sessionId }));
      if (until(rows)) return rows;
      await new Promise((r) => setTimeout(r, 80));
    }
    return rows;
  }

  test("streams the assistant text (with the in-flight user prompt), cleared on finalize", async () => {
    const bus = new InMemoryEventBus();
    const projector = new JazzProjector(db, bus);
    const r = ref("ses_act1", "Act");
    projector.ensureSession(r);

    emit(bus, r.id, { type: "message_start", message: { role: "user", content: "hi there" } });
    emit(bus, r.id, { type: "message_start", message: { role: "assistant" } });
    emit(bus, r.id, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
    emit(bus, r.id, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } });

    const act = await poll("ses_act1", (rows) => rows[0]?.text === "Hello");
    expect(act[0]?.kind).toBe("streaming");
    expect(act[0]?.text).toBe("Hello");
    expect(act[0]?.userText).toBe("hi there"); // the sender's prompt shows before turn-end capture

    // The finalized message lands in `messages`; the ephemeral activity row is retired.
    await projector.onEntry(r.id, entry("e1", assistantMsg("Hello")));
    const cleared = await poll("ses_act1", (rows) => rows.length === 0);
    expect(cleared).toHaveLength(0);
    const msgs = await db.all(app.messages.where({ sessionId: "ses_act1" }));
    expect(msgs.map((m) => m.text)).toContain("Hello");
  });

  test("a thinking-only turn shows the prompt, then clears on turn_end", async () => {
    const bus = new InMemoryEventBus();
    const projector = new JazzProjector(db, bus);
    const r = ref("ses_act2", "Act2");
    projector.ensureSession(r);

    emit(bus, r.id, { type: "message_start", message: { role: "user", content: "ping" } });
    const act = await poll("ses_act2", (rows) => rows.length > 0);
    expect(act[0]?.kind).toBe("thinking");
    expect(act[0]?.userText).toBe("ping");

    emit(bus, r.id, { type: "turn_end" });
    const cleared = await poll("ses_act2", (rows) => rows.length === 0);
    expect(cleared).toHaveLength(0);
  });
});