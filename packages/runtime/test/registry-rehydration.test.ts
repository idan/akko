import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommittedEntry, EntryId, SessionId, Workspace } from "@akko/core";
import { InMemoryEventBus } from "../src/event-bus.ts";
import { BunSqliteAdapter } from "../src/sqlite-bun.ts";
import { SqliteConversationStore } from "../src/sqlite-conversation-store.ts";
import { SqliteSessionIndex } from "../src/session-index.ts";
import { HostWorkspaceRuntimeFactory } from "../src/workspace-runtime.ts";
import { AkkoSessionRegistry } from "../src/session-registry.ts";
import { newPrincipalId, newWorkspaceId } from "../src/ids.ts";

const storageRoot = mkdtempSync(join(tmpdir(), "akko-reh-"));
afterAll(() => rmSync(storageRoot, { recursive: true, force: true }));

function makeStack() {
  const db = new BunSqliteAdapter(join(storageRoot, "akko.db"));
  const conversationStore = new SqliteConversationStore({ db, cwd: join(storageRoot, "tree") });
  const sessionIndex = new SqliteSessionIndex(db);
  const eventBus = new InMemoryEventBus();
  const registry = new AkkoSessionRegistry({
    workspaceRuntimeFactory: new HostWorkspaceRuntimeFactory(),
    conversationStore,
    sessionIndex,
    eventBus,
  });
  const workspace: Workspace = {
    id: newWorkspaceId(),
    name: "reh-ws",
    storageRoot,
    isolation: "host",
  };
  registry.registerWorkspace(workspace);
  return { db, conversationStore, sessionIndex, registry, workspace };
}

function committed(id: string, parentId: string | null, msg: unknown): CommittedEntry {
  return { id: id as EntryId, parentId: parentId as CommittedEntry["parentId"], entry: msg, ts: Date.now() };
}

describe("registry rehydration (durable/liveness split)", () => {
  test("evicts liveness, then rebuilds a cold session from durable state", async () => {
    const { conversationStore, registry, workspace } = makeStack();
    const owner = newPrincipalId();

    const runtime1 = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner });
    const sessionId = runtime1.ref.id;

    // Simulate committed conversation content landing in the durable store.
    await conversationStore.persistEntry(
      sessionId,
      committed("e1", null, { role: "user", content: "my name is Ada", timestamp: Date.now() }),
    );
    await conversationStore.persistEntry(
      sessionId,
      committed("e2", "e1", {
        role: "assistant",
        content: [{ type: "text", text: "Hi Ada" }],
        provider: "x",
        model: "y",
        usage: {},
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    );

    // Drop liveness.
    await registry.evict(sessionId);
    expect(registry.isLive(sessionId)).toBe(false);

    // Rehydrate: a fresh runtime, same ref, conversation restored from SQLite.
    const runtime2 = await registry.get(sessionId);
    expect(runtime2).not.toBe(runtime1);
    expect(runtime2.ref.id).toBe(sessionId);
    expect(registry.isLive(sessionId)).toBe(true);
    expect(runtime2.session.messages.length).toBe(2);
    expect((runtime2.session.messages[0] as any).role).toBe("user");

    await registry.disposeAll();
  });

  test("list() reads durable refs (survives eviction)", async () => {
    const { registry, workspace } = makeStack();
    const owner = newPrincipalId();
    const r = await registry.createConversation({ workspaceId: workspace.id, ownerId: owner, title: "keep" });
    await registry.evict(r.ref.id);

    const refs = await registry.list(workspace.id, owner);
    expect(refs.map((x) => x.id)).toContain(r.ref.id);
    expect(refs.find((x) => x.id === r.ref.id)?.title).toBe("keep");
    await registry.disposeAll();
  });

  test("get() on an unknown session rejects", async () => {
    const { registry } = makeStack();
    await expect(registry.get("ses_missing" as SessionId)).rejects.toThrow("unknown session");
  });
});
