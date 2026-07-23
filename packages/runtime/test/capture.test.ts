import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent, PromptOptions } from "@earendil-works/pi-coding-agent";
import {
  ALLOW,
  type CommittedEntry,
  type CommandId,
  type PrincipalId,
  type SessionId,
  type SessionRef,
  type WorkspaceId,
} from "@akko/core";
import { InMemoryEventBus } from "../src/event-bus.ts";
import { AkkoMailbox } from "../src/mailbox.ts";
import { AkkoSessionRuntime, type SessionDriver } from "../src/session-runtime.ts";
import { InMemoryConversationStore } from "../src/conversation-store.ts";

class FakeDriver implements SessionDriver {
  isStreaming = false;
  messages: any[] = [];
  #listener?: (e: AgentSessionEvent) => void;
  subscribe(l: (e: AgentSessionEvent) => void) {
    this.#listener = l;
    return () => {
      this.#listener = undefined;
    };
  }
  emit(e: AgentSessionEvent) {
    this.#listener?.(e);
  }
  async prompt(_t: string, o?: PromptOptions) {
    o?.preflightResult?.(true);
  }
  async steer() {}
  async followUp() {}
  async setModel() {}
  async abort() {}
  dispose() {}
}

/** A conversation store that records what was persisted. */
class SpyStore extends InMemoryConversationStore {
  persisted: CommittedEntry[] = [];
  override async persistEntry(sessionId: SessionId, entry: CommittedEntry): Promise<void> {
    this.persisted.push(entry);
    await super.persistEntry(sessionId, entry);
  }
}

const ref: SessionRef = {
  id: "ses_cap" as SessionId,
  workspaceId: "wsp_1" as WorkspaceId,
  ownerId: "alice" as PrincipalId,
  kind: "conversation",
  createdAt: 0,
  updatedAt: 0,
};

describe("AkkoSessionRuntime entry capture", () => {
  test("captures new messages on turn end, attributing user messages to the prompt actor", async () => {
    const driver = new FakeDriver();
    const store = new SpyStore();
    const bus = new InMemoryEventBus();
    const runtime = new AkkoSessionRuntime({ ref, driver, eventBus: bus, conversationStore: store });
    const mailbox = new AkkoMailbox({ authorize: () => ALLOW, apply: (c) => runtime.applyCommand(c) });
    runtime.attachMailbox(mailbox);

    const entryEvents: string[] = [];
    bus.subscribe(ref.id, (e) => {
      if (e.type === "entry") entryEvents.push((e.entry.entry as any).role);
    });

    // Alice prompts; the model produces a user echo + assistant reply.
    await mailbox.post({
      id: "c1" as CommandId,
      sessionId: ref.id,
      actorId: "alice" as PrincipalId,
      verb: "prompt",
      args: { text: "hello" },
      ts: Date.now(),
    });
    driver.messages = [
      { role: "user", content: "hello", timestamp: Date.now() },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
    ];
    driver.emit({ type: "agent_end" } as unknown as AgentSessionEvent);
    await runtime.dispose(); // awaits the capture chain

    expect(store.persisted.map((e) => (e.entry as any).role)).toEqual(["user", "assistant"]);
    expect(store.persisted[0]!.actorId).toBe("alice"); // user attributed to prompter
    expect(store.persisted[1]!.actorId).toBeUndefined(); // assistant has no actor
    expect(store.persisted[1]!.parentId).toBe(store.persisted[0]!.id); // linked
    expect(entryEvents).toEqual(["user", "assistant"]);
  });

  test("does not re-persist already-captured messages", async () => {
    const driver = new FakeDriver();
    const store = new SpyStore();
    const bus = new InMemoryEventBus();
    const runtime = new AkkoSessionRuntime({ ref, driver, eventBus: bus, conversationStore: store });
    runtime.attachMailbox(new AkkoMailbox({ authorize: () => ALLOW, apply: (c) => runtime.applyCommand(c) }));

    driver.messages = [{ role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 1 }];
    driver.emit({ type: "turn_end" } as unknown as AgentSessionEvent);
    driver.messages = [
      { role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "b" }], timestamp: 2 },
    ];
    driver.emit({ type: "turn_end" } as unknown as AgentSessionEvent);
    await runtime.dispose();

    expect(store.persisted.length).toBe(2);
  });

  test("rehydrated runtime (persistedCount seeded) does not re-capture restored messages", async () => {
    const driver = new FakeDriver();
    driver.messages = [
      { role: "user", content: "old", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "old reply" }], timestamp: 2 },
    ];
    const store = new SpyStore();
    const bus = new InMemoryEventBus();
    const runtime = new AkkoSessionRuntime({
      ref,
      driver,
      eventBus: bus,
      conversationStore: store,
      persistedCount: driver.messages.length,
    });
    runtime.attachMailbox(new AkkoMailbox({ authorize: () => ALLOW, apply: (c) => runtime.applyCommand(c) }));

    driver.emit({ type: "agent_end" } as unknown as AgentSessionEvent);
    await runtime.dispose();
    expect(store.persisted.length).toBe(0); // restored messages are not re-persisted
  });
});
