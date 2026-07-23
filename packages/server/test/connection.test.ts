import { describe, expect, test } from "bun:test";
import type {
  Command,
  DomainEvent,
  Mailbox,
  MailboxResult,
  PrincipalId,
  SessionId,
  SessionRef,
  WorkspaceId,
} from "@akko/core";
import { InMemoryEventBus } from "@akko/runtime";
import { GatewayConnection, type GatewaySessions } from "../src/connection.ts";
import type { ServerMessage } from "../src/protocol.ts";

function fakeMailbox(record: Command[], result: MailboxResult = { accepted: true }): Mailbox {
  return {
    async post(command) {
      record.push(command);
      return result;
    },
    pending: () => [],
    size: () => 0,
  };
}

function makeRef(id: string): SessionRef {
  return {
    id: id as SessionId,
    workspaceId: "wsp_1" as WorkspaceId,
    ownerId: "owner" as PrincipalId,
    kind: "conversation",
    createdAt: 0,
    updatedAt: 0,
  };
}

class FakeSessions implements GatewaySessions {
  posted: Command[] = [];
  #known = new Set<string>(["ses_known"]);
  async get(sessionId: SessionId) {
    if (!this.#known.has(sessionId)) throw new Error(`unknown session: ${sessionId}`);
    return { ref: makeRef(sessionId), mailbox: fakeMailbox(this.posted) };
  }
  async getRef(sessionId: SessionId) {
    return this.#known.has(sessionId) ? makeRef(sessionId) : undefined;
  }
  async createConversation() {
    return { ref: makeRef("ses_new"), mailbox: fakeMailbox(this.posted) };
  }
  async list() {
    return [makeRef("ses_known")];
  }
  async getEntries() {
    return [];
  }
  async listModels() {
    return [];
  }
}

function setup() {
  const sent: ServerMessage[] = [];
  const eventBus = new InMemoryEventBus();
  const registry = new FakeSessions();
  const conn = new GatewayConnection({
    principalId: "prn_alice" as PrincipalId,
    send: (m) => sent.push(m),
    registry,
    eventBus,
  });
  return { sent, eventBus, registry, conn };
}

const evt = (sessionId: string): DomainEvent => ({
  type: "session",
  sessionId: sessionId as SessionId,
  patch: {},
});

describe("GatewayConnection", () => {
  test("sends welcome on construction", () => {
    const { sent } = setup();
    expect(sent[0]).toEqual({ t: "welcome", principalId: "prn_alice" });
  });

  test("subscribe confirms, then forwards matching events; unsubscribe stops them", async () => {
    const { sent, eventBus, conn } = setup();
    await conn.handle(JSON.stringify({ t: "subscribe", sessionId: "ses_known" }));
    expect(sent.at(-1)).toEqual({ t: "subscribed", sessionId: "ses_known" });

    eventBus.publish(evt("ses_known"));
    eventBus.publish(evt("ses_other")); // not subscribed
    const events = sent.filter((m) => m.t === "event");
    expect(events).toHaveLength(1);

    await conn.handle(JSON.stringify({ t: "unsubscribe", sessionId: "ses_known" }));
    eventBus.publish(evt("ses_known"));
    expect(sent.filter((m) => m.t === "event")).toHaveLength(1);
  });

  test("command posts an attributed command and acks with the result", async () => {
    const { sent, registry, conn } = setup();
    await conn.handle(
      JSON.stringify({ t: "command", cid: "x1", sessionId: "ses_known", verb: "prompt", args: { text: "hi" } }),
    );
    expect(registry.posted).toHaveLength(1);
    const cmd = registry.posted[0]!;
    expect(cmd.actorId as string).toBe("prn_alice");
    expect(cmd.verb).toBe("prompt");
    expect(cmd.args).toEqual({ text: "hi" });
    expect(sent.at(-1)).toEqual({ t: "ack", cid: "x1", sessionId: "ses_known", result: { accepted: true } });
  });

  test("command to an unknown session yields an error (correlated by cid)", async () => {
    const { sent, conn } = setup();
    await conn.handle(JSON.stringify({ t: "command", cid: "x2", sessionId: "ses_missing", verb: "prompt" }));
    const last = sent.at(-1)!;
    expect(last.t).toBe("error");
    if (last.t === "error") {
      expect(last.cid).toBe("x2");
      expect(last.message).toContain("unknown session");
    }
  });

  test("invalid json yields an error", async () => {
    const { sent, conn } = setup();
    await conn.handle("{ not json");
    expect(sent.at(-1)).toEqual({ t: "error", message: "invalid json" });
  });

  test("close releases subscriptions", async () => {
    const { sent, eventBus, conn } = setup();
    await conn.handle(JSON.stringify({ t: "subscribe", sessionId: "ses_known" }));
    conn.close();
    eventBus.publish(evt("ses_known"));
    expect(sent.filter((m) => m.t === "event")).toHaveLength(0);
  });
});
