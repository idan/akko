/**
 * The registry must make the read model **complete at boot** (doc 14): every session
 * already in the durable index gets its metadata projected when its workspace is
 * registered. Without this, the reactive session list only contains sessions this
 * process happened to touch, so a client sees the full list from canonical storage
 * momentarily and then a shorter projected one.
 */
import { describe, expect, test } from "bun:test";
import type { SessionId, SessionRef, Workspace } from "@akko/core";
import { InMemoryEventBus } from "../src/event-bus.ts";
import { InMemoryConversationStore } from "../src/conversation-store.ts";
import { InMemorySessionIndex } from "../src/session-index.ts";
import { HostWorkspaceRuntimeFactory } from "../src/workspace-runtime.ts";
import { AkkoSessionRegistry, createSessionTouchSink } from "../src/session-registry.ts";
import type { SessionProjector } from "../src/session-projector.ts";
import { newPrincipalId, newWorkspaceId } from "../src/ids.ts";

/** Records what the registry asks the projector to do. */
class SpyProjector implements SessionProjector {
  meta: string[] = [];
  ensured: string[] = [];
  ensureSession(ref: SessionRef): string {
    this.ensured.push(ref.id);
    return ref.id;
  }
  projectSessionMeta(ref: SessionRef): void {
    this.meta.push(ref.id);
  }
  projectionId(id: SessionId): string {
    return id;
  }
  async onEntry(): Promise<void> {}
  async rebuild(): Promise<void> {}
  async drop(): Promise<void> {}
}

describe("registry read-model projection", () => {
  test("projects metadata for pre-existing sessions when a workspace is registered", () => {
    const workspaceId = newWorkspaceId();
    const sessionIndex = new InMemorySessionIndex();
    const now = Date.now();
    // Two sessions already in the durable index (i.e. from a previous process).
    for (const id of ["ses_old1", "ses_old2"]) {
      sessionIndex.upsertRef({
        id: id as SessionId,
        workspaceId,
        ownerId: newPrincipalId(),
        kind: "conversation",
        title: id,
        createdAt: now,
        updatedAt: now,
      });
    }
    // A session in a different workspace must NOT be projected here.
    sessionIndex.upsertRef({
      id: "ses_other" as SessionId,
      workspaceId: newWorkspaceId(),
      ownerId: newPrincipalId(),
      kind: "conversation",
      createdAt: now,
      updatedAt: now,
    });

    const projector = new SpyProjector();
    const registry = new AkkoSessionRegistry({
      workspaceRuntimeFactory: new HostWorkspaceRuntimeFactory(),
      conversationStore: new InMemoryConversationStore(),
      sessionIndex,
      eventBus: new InMemoryEventBus(),
      projector,
    });

    const workspace: Workspace = { id: workspaceId, name: "w", storageRoot: "/tmp/x", isolation: "host" };
    registry.registerWorkspace(workspace);

    expect(projector.meta.sort()).toEqual(["ses_old1", "ses_old2"]);
    // Metadata only — no history backfill / live subscription for untouched sessions.
    expect(projector.ensured).toEqual([]);
  });

  test("committing an entry touches updatedAt and re-projects, so the list orders by recency", async () => {
    const index = new InMemorySessionIndex();
    const sessionId = "ses_touch" as SessionId;
    index.upsertRef({
      id: sessionId,
      workspaceId: newWorkspaceId(),
      ownerId: newPrincipalId(),
      kind: "conversation",
      createdAt: 1,
      updatedAt: 1, // stale
    });
    const projector = new SpyProjector();
    const sink = createSessionTouchSink({ sessionId, index, projector });

    await sink.onEntry(sessionId, { id: "e1" as never, parentId: null, entry: {}, ts: 1 });

    expect(index.getRef(sessionId)!.updatedAt).toBeGreaterThan(1);
    expect(projector.meta).toEqual([sessionId]); // row refreshed for the reactive list
  });
});
