import { afterAll, describe, expect, test } from "bun:test";
import type {
  Command,
  Mailbox,
  PrincipalId,
  SessionId,
  SessionRef,
  WorkspaceId,
} from "@akko/core";
import { InMemoryEventBus } from "@akko/runtime";
import { createGatewayServer } from "../src/gateway.ts";
import type { GatewaySessions } from "../src/gateway.ts";
import { testAuth, ownerMemberships } from "./test-auth.ts";

let idSeq = 0;

/** A minimal in-memory sessions backend so the gateway can be exercised without pi. */
class FakeSessions implements GatewaySessions {
  posted: Command[] = [];
  projected: string[] = [];
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
  async getRef(sessionId: SessionId) {
    return this.#refs.get(sessionId);
  }
  async ensureProjected(sessionId: SessionId) {
    if (!this.#refs.has(sessionId)) return false;
    this.projected.push(sessionId);
    return true;
  }
  async get(sessionId: SessionId) {
    const ref = this.#refs.get(sessionId);
    if (!ref) throw new Error(`unknown session: ${sessionId}`);
    return { ref, mailbox: this.#mailbox() };
  }
  async list(workspaceId: WorkspaceId) {
    return [...this.#refs.values()].filter((r) => r.workspaceId === workspaceId);
  }
  async getEntries(sessionId: SessionId) {
    return this.#refs.has(sessionId) ? [] : Promise.reject(new Error(`unknown session: ${sessionId}`));
  }
  async listModels() {
    return [];
  }
}

const eventBus = new InMemoryEventBus();
const registry = new FakeSessions();
const server = createGatewayServer({
  registry,
  eventBus,
  auth: testAuth(),
  memberships: ownerMemberships,
  port: 0,
});
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));


describe("gateway HTTP", () => {
  test("POST /api/sessions creates, GET lists (principal via session)", async () => {
    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "prn_a" },
      body: JSON.stringify({ workspaceId: "wsp_1", title: "hello" }),
    }).then((r) => r.json() as Promise<{ ref: SessionRef }>);
    expect(created.ref.title).toBe("hello");

    const listed = await fetch(`${base}/api/sessions?workspaceId=wsp_1`, {
      headers: { "x-test-principal": "prn_a" },
    }).then((r) => r.json() as Promise<{ sessions: SessionRef[] }>);
    expect(listed.sessions.map((s) => s.id)).toContain(created.ref.id);
  });

  test("unauthenticated request is rejected", async () => {
    const res = await fetch(`${base}/api/sessions?workspaceId=wsp_1`);
    expect(res.status).toBe(401);
  });
});

describe("gateway projection endpoint", () => {
  test("POST /api/sessions/:id/projection backfills the read model for an existing session", async () => {
    const { ref } = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "prn_bob" },
      body: JSON.stringify({ workspaceId: "wsp_ws" }),
    }).then((r) => r.json() as Promise<{ ref: SessionRef }>);

    const res = await fetch(`${base}/api/sessions/${ref.id}/projection`, {
      method: "POST",
      headers: { "x-test-principal": "prn_bob" },
    });
    expect(res.status).toBe(200);
    expect(registry.projected).toContain(ref.id);
  });

  test("projection requires auth and a known session", async () => {
    const anon = await fetch(`${base}/api/sessions/ses_x/projection`, { method: "POST" });
    expect(anon.status).toBe(401);

    const missing = await fetch(`${base}/api/sessions/ses_missing/projection`, {
      method: "POST",
      headers: { "x-test-principal": "prn_bob" },
    });
    expect(missing.status).toBe(404);
  });
});

describe("gateway commands over HTTP", () => {
  test("POST /api/sessions/:id/commands attributes to the cookie principal and returns the decision", async () => {
    const { ref } = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "prn_bob" },
      body: JSON.stringify({ workspaceId: "wsp_ws" }),
    }).then((r) => r.json() as Promise<{ ref: SessionRef }>);

    const res = await fetch(`${base}/api/sessions/${ref.id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "prn_bob" },
      body: JSON.stringify({ verb: "prompt", args: { text: "go" } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { accepted: true } });
    // Attribution is server-side: the body cannot assert an actor (doc 02/16).
    expect(registry.posted.at(-1)?.actorId as string).toBe("prn_bob");
    expect(registry.posted.at(-1)?.verb).toBe("prompt");
  });

  test("commands require authentication and a verb", async () => {
    const { ref } = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "prn_bob" },
      body: JSON.stringify({ workspaceId: "wsp_ws" }),
    }).then((r) => r.json() as Promise<{ ref: SessionRef }>);

    const anon = await fetch(`${base}/api/sessions/${ref.id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verb: "prompt" }),
    });
    expect(anon.status).toBe(401);

    const noVerb = await fetch(`${base}/api/sessions/${ref.id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "prn_bob" },
      body: JSON.stringify({}),
    });
    expect(noVerb.status).toBe(400);
  });
});
