/**
 * End-to-end: real AkkoSessionRegistry wired to the gateway.
 *
 * Proves the full spine composes — HTTP create -> HTTP command -> (gated) a real prompt
 * flows browser -> gateway -> mailbox -> pi -> event bus -> projector/read model.
 * Commands are HTTP-only now (doc 15, unify step 3); the event bus is still the in-process
 * fan-out that feeds the Jazz projector, so the live test observes it directly.
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

/** Shape of the pi stream events this test folds (kept local; the wire type is gone). */
type PiStreamEvent = {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
};
import type { HistoryMessage } from "../src/protocol.ts";
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

afterAll(() => {
  server.stop(true);
  db.close();
  rmSync(storageRoot, { recursive: true, force: true });
});


async function createSession(): Promise<SessionRef> {
  const { ref } = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-principal": "prn_e2e" },
    body: JSON.stringify({ workspaceId: workspace.id }),
  }).then((r) => r.json() as Promise<{ ref: SessionRef }>);
  return ref;
}

describe("gateway <-> real registry (offline, always runs)", () => {
  test("create a real pi-backed session over HTTP", async () => {
    const ref = await createSession();
    expect(ref.workspaceId).toBe(workspace.id);
    expect(registry.isLive(ref.id)).toBe(true);
  });

  test("a command posted over HTTP reaches the real mailbox and is attributed", async () => {
    const ref = await createSession();
    const res = await fetch(`${base}/api/sessions/${ref.id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "prn_e2e" },
      body: JSON.stringify({ verb: "setModel", args: { model: "anthropic/claude-sonnet-4-5" } }),
    });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { accepted: boolean } };
    expect(result.accepted).toBe(true);
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
  test("a prompt posted over HTTP streams assistant text onto the event bus", async () => {
    if (process.env.AKKO_LIVE !== "1") {
      console.warn("skipping live e2e (set AKKO_LIVE=1)");
      return;
    }
    const ref = await createSession();

    // The event bus is what the Jazz projector consumes, so asserting on it is asserting
    // on the source the read model is built from.
    let text = "";
    const done = new Promise<void>((resolve) => {
      const unsub = eventBus.subscribe(ref.id, (event) => {
        if (event.type !== "pi") return;
        const ev = (event as { event: PiStreamEvent }).event;
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          text += ev.assistantMessageEvent.delta;
        }
        if (ev.type === "agent_end") {
          unsub();
          resolve();
        }
      });
    });

    const res = await fetch(`${base}/api/sessions/${ref.id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "prn_e2e" },
      body: JSON.stringify({ verb: "prompt", args: { text: "Reply with exactly: pong" } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { accepted: boolean } }).result.accepted).toBe(true);

    await done;
    expect(text.toLowerCase()).toContain("pong");
  }, 60_000);
});
