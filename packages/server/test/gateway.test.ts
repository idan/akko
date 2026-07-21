import { afterAll, describe, expect, test } from "bun:test";
import type {
  Command,
  DomainEvent,
  Mailbox,
  PrincipalId,
  SessionId,
  SessionRef,
  WorkspaceId,
} from "@akko/core";
import { InMemoryEventBus } from "@akko/runtime";
import { createGatewayServer } from "../src/gateway.ts";
import type { GatewaySessions } from "../src/connection.ts";
import type { ServerMessage } from "../src/protocol.ts";

let idSeq = 0;

/** A minimal in-memory sessions backend so the gateway can be exercised without pi. */
class FakeSessions implements GatewaySessions {
  posted: Command[] = [];
  #refs = new Map<string, SessionRef>();

  #mailbox(): Mailbox {
    return { post: async (c) => { this.posted.push(c); return { accepted: true }; }, pending: () => [], size: () => 0 };
  }
  async createConversation(input: { workspaceId: WorkspaceId; ownerId: PrincipalId; title?: string }) {
    const ref: SessionRef = {
      id: `ses_${idSeq++}` as SessionId,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      kind: "conversation",
      title: input.title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.#refs.set(ref.id, ref);
    return { ref, mailbox: this.#mailbox() };
  }
  async get(sessionId: SessionId) {
    const ref = this.#refs.get(sessionId);
    if (!ref) throw new Error(`unknown session: ${sessionId}`);
    return { ref, mailbox: this.#mailbox() };
  }
  async list(workspaceId: WorkspaceId) {
    return [...this.#refs.values()].filter((r) => r.workspaceId === workspaceId);
  }
}

const eventBus = new InMemoryEventBus();
const registry = new FakeSessions();
const server = createGatewayServer({ registry, eventBus, port: 0 });
const base = `http://localhost:${server.port}`;
const wsBase = `ws://localhost:${server.port}`;
afterAll(() => server.stop(true));

/** Wrap a WebSocket with an async message queue. */
function connect(url: string) {
  const ws = new WebSocket(url);
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

describe("gateway HTTP", () => {
  test("POST /api/sessions creates, GET lists (principal via header)", async () => {
    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-akko-principal": "prn_a" },
      body: JSON.stringify({ workspaceId: "wsp_1", title: "hello" }),
    }).then((r) => r.json() as Promise<{ ref: SessionRef }>);
    expect(created.ref.title).toBe("hello");

    const listed = await fetch(`${base}/api/sessions?workspaceId=wsp_1`, {
      headers: { "x-akko-principal": "prn_a" },
    }).then((r) => r.json() as Promise<{ sessions: SessionRef[] }>);
    expect(listed.sessions.map((s) => s.id)).toContain(created.ref.id);
  });

  test("missing principal is rejected", async () => {
    const res = await fetch(`${base}/api/sessions?workspaceId=wsp_1`);
    expect(res.status).toBe(401);
  });
});

describe("gateway WebSocket (real Bun.serve)", () => {
  test("welcome, subscribe, event fan-out, and command ack over the wire", async () => {
    // Create a session to talk to.
    const { ref } = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-akko-principal": "prn_bob" },
      body: JSON.stringify({ workspaceId: "wsp_ws" }),
    }).then((r) => r.json() as Promise<{ ref: SessionRef }>);

    const { ws, next } = await connect(`${wsBase}/ws?principal=prn_bob`);

    const welcome = await next();
    expect(welcome).toEqual({ t: "welcome", principalId: "prn_bob" });

    ws.send(JSON.stringify({ t: "subscribe", sessionId: ref.id }));
    expect(await next()).toEqual({ t: "subscribed", sessionId: ref.id });

    // Server-side event should fan out to the subscribed client.
    const domainEvent: DomainEvent = { type: "session", sessionId: ref.id, patch: { note: "hi" } };
    eventBus.publish(domainEvent);
    const evented = await next();
    expect(evented.t).toBe("event");
    if (evented.t === "event") expect(evented.event).toEqual(domainEvent);

    // Command over the wire is attributed to the connection principal and acked.
    ws.send(JSON.stringify({ t: "command", cid: "c9", sessionId: ref.id, verb: "prompt", args: { text: "go" } }));
    const ack = await next();
    expect(ack).toEqual({ t: "ack", cid: "c9", sessionId: ref.id, result: { accepted: true } });
    expect(registry.posted.at(-1)?.actorId as string).toBe("prn_bob");

    ws.close();
  });
});
