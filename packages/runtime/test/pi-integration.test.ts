/**
 * Proves the pi integration works end-to-end under Bun, in-repo.
 *
 * - The construct-only part ALWAYS runs (no network/keys): it builds a workspace,
 *   creates a conversation via `createAgentSession`, and checks the runtime/mailbox.
 * - The live prompt part runs only when `AKKO_LIVE=1` AND the model runtime reports an
 *   available (authed) model. It posts a real prompt and asserts assistant text streams
 *   back through the event bus.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrincipalId, WorkspaceId, Workspace } from "@akko/core";
import { InMemoryEventBus } from "../src/event-bus.ts";
import { InMemoryConversationStore } from "../src/conversation-store.ts";
import { HostWorkspaceRuntimeFactory } from "../src/workspace-runtime.ts";
import { AkkoSessionRegistry } from "../src/session-registry.ts";
import { newCommandId, newPrincipalId, newWorkspaceId } from "../src/ids.ts";

const storageRoot = mkdtempSync(join(tmpdir(), "akko-it-"));
afterAll(() => rmSync(storageRoot, { recursive: true, force: true }));

function makeStack() {
  const factory = new HostWorkspaceRuntimeFactory();
  const conversationStore = new InMemoryConversationStore({ cwd: join(storageRoot, "tree") });
  const eventBus = new InMemoryEventBus();
  const registry = new AkkoSessionRegistry({
    workspaceRuntimeFactory: factory,
    conversationStore,
    eventBus,
  });
  const workspace: Workspace = {
    id: newWorkspaceId(),
    name: "test-ws",
    storageRoot,
    isolation: "host",
  };
  registry.registerWorkspace(workspace);
  return { factory, eventBus, registry, workspace };
}

describe("pi integration (construct-only, always runs)", () => {
  test("creates a conversation session via createAgentSession on Bun", async () => {
    const { registry, workspace } = makeStack();
    const owner = newPrincipalId();
    const runtime = await registry.createConversation({
      workspaceId: workspace.id,
      ownerId: owner,
      title: "smoke",
    });

    expect(runtime.ref.kind).toBe("conversation");
    expect(runtime.ref.workspaceId).toBe(workspace.id);
    expect(registry.isLive(runtime.ref.id)).toBe(true);
    expect(runtime.mailbox).toBeDefined();
    // Fresh session: no messages yet.
    expect(runtime.session.messages.length).toBe(0);

    const list = await registry.list(workspace.id, owner);
    expect(list.map((r) => r.id)).toContain(runtime.ref.id);

    await registry.disposeAll();
    expect(registry.isLive(runtime.ref.id)).toBe(false);
  });
});

describe("pi integration (live prompt, gated on AKKO_LIVE=1 + available model)", () => {
  test("streams assistant text back through the event bus", async () => {
    if (process.env.AKKO_LIVE !== "1") {
      console.warn("skipping live prompt test (set AKKO_LIVE=1 to run)");
      return;
    }
    const { factory, eventBus, registry, workspace } = makeStack();
    const { modelRuntime } = await factory
      .get(workspace)
      .then((wr) => ({ modelRuntime: wr.modelRuntime }));
    const available = await modelRuntime.getAvailable();
    if (available.length === 0) {
      console.warn("skipping live prompt test (no available/authed model)");
      return;
    }

    const runtime = await registry.createConversation({
      workspaceId: workspace.id,
      ownerId: newPrincipalId(),
    });

    let text = "";
    const done = new Promise<void>((resolve) => {
      eventBus.subscribe(runtime.ref.id, (e) => {
        if (e.type !== "pi") return;
        const ev = e.event;
        if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
          text += ev.assistantMessageEvent.delta;
        }
        if (ev.type === "agent_end") resolve();
      });
    });

    await runtime.mailbox.post({
      id: newCommandId(),
      sessionId: runtime.ref.id,
      actorId: "tester" as PrincipalId,
      verb: "prompt",
      args: { text: "Reply with exactly: pong" },
      ts: Date.now(),
    });

    await done;
    expect(text.toLowerCase()).toContain("pong");
    await registry.disposeAll();
  }, 60_000);
});

// Reference the type imports so unused-symbol lint stays quiet in strict mode.
export type _Ids = [WorkspaceId, PrincipalId];
