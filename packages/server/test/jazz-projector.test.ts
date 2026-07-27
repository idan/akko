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
function entry(id: string, msg: unknown, actorId?: string, ts = 1): CommittedEntry {
  return { id: id as EntryId, parentId: null, entry: msg, actorId: actorId as PrincipalId | undefined, ts };
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
    await projector.onEntry(r.id, entry("e2", assistantMsg("Hi Ada"), undefined, 2));

    const rows = await db.all(app.messages.where({ sessionId: "ses_p1" }));
    // Row ids are content-derived, so storage order is arbitrary — the UI orders by
    // `createdAt` (see JazzMessageList). Assert on the chronologically-ordered view.
    const ordered = [...rows].sort((a, b) => Number(new Date(a.createdAt)) - Number(new Date(b.createdAt)));
    expect(ordered.map((m) => `${m.role}:${m.text}`)).toEqual(["user:my name is Ada", "assistant:Hi Ada"]);
    expect(ordered[0]?.authorId).toBe("prn_alice");
    expect(ordered[1]?.authorId).toBe("");
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

  test("backfills canonical history on ensureSession, idempotently (doc 04 recreatable)", async () => {
    // Canonical history exists (e.g. in SQLite) but was never projected — exactly the
    // state after an --in-memory sync server restart, or a session rehydrated elsewhere.
    const canonical: CommittedEntry[] = [
      entry("c1", userMsg("first question"), "prn_alice"),
      entry("c2", assistantMsg("first answer")),
      entry("c3", { role: "toolResult", content: "ignored" }),
    ];
    const projector = new JazzProjector(db, { getEntries: async () => canonical });
    const r = ref("ses_backfill", "Backfill");

    projector.ensureSession(r); // triggers the one-time backfill
    let rows: Array<{ text?: string; workspaceId?: string; authorId?: string }> = [];
    for (let i = 0; i < 25 && rows.length < 2; i++) {
      rows = await db.all(app.messages.where({ sessionId: "ses_backfill" }));
      if (rows.length < 2) await new Promise((res) => setTimeout(res, 80));
    }
    expect(rows.map((m) => m.text).sort()).toEqual(["first answer", "first question"]);
    expect(rows.every((m) => m.workspaceId === "wsp_1")).toBe(true); // ACL key is stamped

    // Rebuilding again must not duplicate (deterministic per-entry row ids).
    await projector.rebuild(r.id);
    await projector.rebuild(r.id);
    const after = await db.all(app.messages.where({ sessionId: "ses_backfill" }));
    expect(after).toHaveLength(2);
  });
});

describe("JazzProjector session metadata (reactive session list)", () => {
  test("projects the session row on ensureSession and refreshes it on metadata change", async () => {
    const projector = new JazzProjector(db);
    const r = { ...ref("ses_meta", "First title"), model: "anthropic/claude", ownerId: "prn_owner" as never };
    projector.ensureSession(r);

    const poll = async (want: (rows: any[]) => boolean) => {
      let rows: any[] = [];
      for (let i = 0; i < 25; i++) {
        rows = await db.all(app.sessions.where({ sessionId: "ses_meta" }));
        if (want(rows)) return rows;
        await new Promise((res) => setTimeout(res, 80));
      }
      return rows;
    };

    const rows = await poll((x) => x.length > 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("First title");
    expect(rows[0]?.model).toBe("anthropic/claude");
    expect(rows[0]?.workspaceId).toBe("wsp_1"); // read-ACL key
    expect(rows[0]?.ownerId).toBe("prn_owner");

    // A metadata change (e.g. setModel) re-projects the SAME row — no duplicates.
    projector.ensureSession({ ...r, model: "openai/gpt", title: "Renamed", updatedAt: Date.now() });
    const updated = await poll((x) => x[0]?.model === "openai/gpt");
    expect(updated).toHaveLength(1);
    expect(updated[0]?.model).toBe("openai/gpt");
    expect(updated[0]?.title).toBe("Renamed");
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
    const projector = new JazzProjector(db, { eventBus: bus });
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

    // The finalized message lands in `messages`; the ephemeral activity row is retired
    // to `idle` (never deleted — a Jazz delete tombstones the id forever).
    await projector.onEntry(r.id, entry("e1", assistantMsg("Hello")));
    const cleared = await poll("ses_act1", (rows) => rows[0]?.kind === "idle");
    expect(cleared[0]?.kind).toBe("idle");
    const msgs = await db.all(app.messages.where({ sessionId: "ses_act1" }));
    expect(msgs.map((m) => m.text)).toContain("Hello");
  });

  test("a SECOND turn still streams (regression: deleting tombstoned the activity id)", async () => {
    const bus = new InMemoryEventBus();
    const projector = new JazzProjector(db, { eventBus: bus });
    const r = ref("ses_act3", "Two turns");
    projector.ensureSession(r);

    // Turn 1: stream, then finalize (retires the row).
    emit(bus, r.id, { type: "message_start", message: { role: "user", content: "q1" } });
    emit(bus, r.id, { type: "message_start", message: { role: "assistant" } });
    emit(bus, r.id, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer one" } });
    expect((await poll("ses_act3", (rows) => rows[0]?.text === "answer one"))[0]?.text).toBe("answer one");
    await projector.onEntry(r.id, entry("t1", assistantMsg("answer one"), undefined, 1));
    await poll("ses_act3", (rows) => rows[0]?.kind === "idle");

    // Turn 2 on the SAME session reuses the same derived activity id. Previously this
    // failed with `WriteError: row already deleted`, so the live view worked exactly once.
    emit(bus, r.id, { type: "message_start", message: { role: "user", content: "q2" } });
    emit(bus, r.id, { type: "message_start", message: { role: "assistant" } });
    emit(bus, r.id, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer two" } });
    const second = await poll("ses_act3", (rows) => rows[0]?.text === "answer two");
    expect(second[0]?.kind).toBe("streaming");
    expect(second[0]?.text).toBe("answer two");
    expect(second[0]?.userText).toBe("q2");
  });

  test("a thinking-only turn shows the prompt, then clears on turn_end", async () => {
    const bus = new InMemoryEventBus();
    const projector = new JazzProjector(db, { eventBus: bus });
    const r = ref("ses_act2", "Act2");
    projector.ensureSession(r);

    emit(bus, r.id, { type: "message_start", message: { role: "user", content: "ping" } });
    const act = await poll("ses_act2", (rows) => rows.length > 0);
    expect(act[0]?.kind).toBe("thinking");
    expect(act[0]?.userText).toBe("ping");

    emit(bus, r.id, { type: "turn_end" });
    const cleared = await poll("ses_act2", (rows) => rows[0]?.kind === "idle");
    expect(cleared[0]?.kind).toBe("idle");
  });
});