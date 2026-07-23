/**
 * End-to-end: real AkkoSessionRegistry wired to the gateway.
 *
 * Proves the full spine composes — HTTP create -> WS subscribe -> (gated) a real prompt
 * command flows browser -> gateway -> mailbox -> pi -> event bus -> gateway -> browser.
 * The offline portion always runs; the live prompt runs only under AKKO_LIVE=1.
 *
 * Note: `AkkoSessionRegistry` satisfies `GatewaySessions` structurally, so this file is
 * also the type-level proof that the runtime and server layers fit together.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommittedEntry, EntryId, PrincipalId, SessionRef, Workspace } from "@akko/core";
import { RoleBasedPolicy } from "@akko/core";
import {
  AkkoSessionRegistry,
  BunSqliteAdapter,
  HostWorkspaceRuntimeFactory,
  InMemoryEventBus,
  InMemoryMembershipStore,
  SqliteConversationStore,
  SqliteSessionIndex,
  newWorkspaceId,
} from "@akko/runtime";
import { createGatewayServer } from "../src/gateway.ts";
import type { HistoryMessage, ServerMessage } from "../src/protocol.ts";
import { testAuth } from "./test-auth.ts";

const storageRoot = mkdtempSync(join(tmpdir(), "akko-e2e-"));
const db = new BunSqliteAdapter(join(storageRoot, "akko.db"));
const eventBus = new InMemoryEventBus();
const conversationStore = new SqliteConversationStore({ db, cwd: join(storageRoot, "tree") });
const memberships = new InMemoryMembershipStore();
const registry = new AkkoSessionRegistry({
  workspaceRuntimeFactory: new HostWorkspaceRuntimeFactory(),
  conversationStore,
  sessionIndex: new SqliteSessionIndex(db),
  memberships,
  policy: new RoleBasedPolicy(),
  eventBus,
});
const workspace: Workspace = { id: newWorkspaceId(), name: "e2e", storageRoot, isolation: "host" };
registry.registerWorkspace(workspace);
memberships.grant({ workspaceId: workspace.id, principalId: "prn_e2e" as PrincipalId, role: "owner" });

const server = createGatewayServer({ registry, eventBus, auth: testAuth(), memberships, port: 0 });
const base = `http://localhost:${server.port}`;
const wsBase = `ws://localhost:${server.port}`;

afterAll(() => {
  server.stop(true);
  db.close();
  rmSync(storageRoot, { recursive: true, force: true });
});

function connect(url: string, principal: string) {
  const ws = new WebSocket(url, { headers: { "x-test-principal": principal } });
  const queue: ServerMessage[] = [];
  const waiters: Array<(m: ServerMessage) => void> = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data)) as ServerMessage;
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = () =>
    new Promise<ServerMessage>((resolve) => {
      const m = queue.shift();
      if (m) resolve(m);
      else waiters.push(resolve);
    });
  return new Promise<{ ws: WebSocket; next: () => Promise<ServerMessage> }>((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, next }));
    ws.addEventListener("error", reject);
  });
}

async function createSession(): Promise<SessionRef> {
  const { ref } = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-principal": "prn_e2e" },
    body: JSON.stringify({ workspaceId: workspace.id }),
  }).then((r) => r.json() as Promise<{ ref: SessionRef }>);
  return ref;
}

describe("gateway <-> real registry (offline, always runs)", () => {
  test("create a real pi-backed session over HTTP and subscribe over WS", async () => {
    const ref = await createSession();
    expect(ref.workspaceId).toBe(workspace.id);
    expect(registry.isLive(ref.id)).toBe(true);

    const { ws, next } = await connect(`${wsBase}/ws`, "prn_e2e");
    expect(await next()).toEqual({ t: "welcome", principalId: "prn_e2e" });
    ws.send(JSON.stringify({ t: "subscribe", sessionId: ref.id }));
    expect(await next()).toEqual({ t: "subscribed", sessionId: ref.id });
    ws.close();
  });

  test("GET /api/sessions/:id/history returns canonical finalized messages", async () => {
    const ref = await createSession();
    const entry = (id: string, parentId: string | null, msg: unknown): CommittedEntry => ({
      id: id as EntryId,
      parentId: parentId as EntryId | null,
      entry: msg,
      ts: Date.now(),
    });
    await conversationStore.persistEntry(ref.id, entry("h1", null, { role: "user", content: "my name is Ada" }));
    await conversationStore.persistEntry(
      ref.id,
      entry("h2", "h1", { role: "assistant", content: [{ type: "text", text: "Hi Ada" }] }),
    );

    const res = await fetch(`${base}/api/sessions/${ref.id}/history`, {
      headers: { "x-test-principal": "prn_e2e" },
    });
    expect(res.status).toBe(200);
    const { messages } = (await res.json()) as { messages: HistoryMessage[] };
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: "h1", role: "user", content: "my name is Ada" });
    expect(messages[1]).toMatchObject({ id: "h2", role: "assistant" });
  });

  test("history for an unknown session is a 404", async () => {
    const res = await fetch(`${base}/api/sessions/ses_nope/history`, {
      headers: { "x-test-principal": "prn_e2e" },
    });
    expect(res.status).toBe(404);
  });
});

describe("gateway <-> real registry (live prompt, gated on AKKO_LIVE=1)", () => {
  test("a prompt command round-trips to streamed assistant text over the WS", async () => {
    if (process.env.AKKO_LIVE !== "1") {
      console.warn("skipping live e2e (set AKKO_LIVE=1)");
      return;
    }
    const ref = await createSession();
    const { ws, next } = await connect(`${wsBase}/ws`, "prn_e2e");
    await next(); // welcome
    ws.send(JSON.stringify({ t: "subscribe", sessionId: ref.id }));
    await next(); // subscribed

    ws.send(
      JSON.stringify({ t: "command", cid: "p1", sessionId: ref.id, verb: "prompt", args: { text: "Reply with exactly: pong" } }),
    );

    let text = "";
    let acked = false;
    for (;;) {
      const m = await next();
      if (m.t === "ack" && m.cid === "p1") acked = true;
      if (m.t === "event" && m.event.type === "pi") {
        const ev = m.event.event;
        if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
          text += ev.assistantMessageEvent.delta;
        }
        if (ev.type === "agent_end") break;
      }
    }
    expect(acked).toBe(true);
    expect(text.toLowerCase()).toContain("pong");
    ws.close();
  }, 60_000);
});
