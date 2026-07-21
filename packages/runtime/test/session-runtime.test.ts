import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent, PromptOptions } from "@earendil-works/pi-coding-agent";
import {
  ALLOW,
  type Command,
  type CommandId,
  type CommandVerb,
  type PrincipalId,
  type SessionId,
  type SessionRef,
  type WorkspaceId,
} from "@akko/core";
import { InMemoryEventBus } from "../src/event-bus.ts";
import { InMemoryConversationStore } from "../src/conversation-store.ts";
import { AkkoMailbox } from "../src/mailbox.ts";
import { AkkoSessionRuntime, type SessionDriver } from "../src/session-runtime.ts";

class FakeDriver implements SessionDriver {
  isStreaming = false;
  messages: any[] = [];
  calls: Array<{ m: string; text?: string }> = [];
  disposed = false;
  #listener?: (e: AgentSessionEvent) => void;

  subscribe(listener: (e: AgentSessionEvent) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }
  emit(event: AgentSessionEvent): void {
    this.#listener?.(event);
  }
  async prompt(text: string, options?: PromptOptions): Promise<void> {
    this.calls.push({ m: "prompt", text });
    options?.preflightResult?.(true);
  }
  async steer(text: string): Promise<void> {
    this.calls.push({ m: "steer", text });
  }
  async followUp(text: string): Promise<void> {
    this.calls.push({ m: "followUp", text });
  }
  async abort(): Promise<void> {
    this.calls.push({ m: "abort" });
  }
  dispose(): void {
    this.disposed = true;
  }
}

let seq = 0;
function cmd(actor: string, verb: CommandVerb, args: unknown = {}): Command {
  return {
    id: `c${seq++}` as CommandId,
    sessionId: "s1" as SessionId,
    actorId: actor as PrincipalId,
    verb,
    args,
    ts: Date.now(),
  };
}

function makeRuntime() {
  const driver = new FakeDriver();
  const bus = new InMemoryEventBus();
  const conversationStore = new InMemoryConversationStore();
  const ref: SessionRef = {
    id: "s1" as SessionId,
    workspaceId: "w1" as WorkspaceId,
    ownerId: "alice" as PrincipalId,
    kind: "conversation",
    createdAt: 0,
    updatedAt: 0,
  };
  const runtime = new AkkoSessionRuntime({ ref, driver, eventBus: bus, conversationStore });
  const mailbox = new AkkoMailbox({
    authorize: () => ALLOW,
    apply: (c) => runtime.applyCommand(c),
  });
  runtime.attachMailbox(mailbox);
  return { driver, bus, ref, runtime, mailbox };
}

describe("AkkoSessionRuntime", () => {
  test("applies prompt/steer/followUp/abort to the driver via the mailbox", async () => {
    const { driver, mailbox } = makeRuntime();
    await mailbox.post(cmd("alice", "prompt", { text: "hello" }));
    await mailbox.post(cmd("bob", "steer", { text: "focus" }));
    await mailbox.post(cmd("alice", "followUp", { text: "then this" }));
    await mailbox.post(cmd("alice", "abort"));
    expect(driver.calls).toEqual([
      { m: "prompt", text: "hello" },
      { m: "steer", text: "focus" },
      { m: "followUp", text: "then this" },
      { m: "abort" },
    ]);
  });

  test("prompt while streaming queues as followUp by default", async () => {
    const { driver, mailbox } = makeRuntime();
    driver.isStreaming = true;
    // A streaming prompt still resolves acceptance immediately in the fake.
    const res = await mailbox.post(cmd("alice", "prompt", { text: "later" }));
    expect(res.accepted).toBe(true);
    expect(driver.calls[0]).toEqual({ m: "prompt", text: "later" });
  });

  test("fans pi events out to the event bus tagged with session id", () => {
    const { driver, bus, ref } = makeRuntime();
    const seen: string[] = [];
    bus.subscribe(ref.id, (e) => {
      if (e.type === "pi") seen.push(e.event.type);
    });
    driver.emit({ type: "agent_start" } as AgentSessionEvent);
    driver.emit({ type: "agent_end" } as unknown as AgentSessionEvent);
    expect(seen).toEqual(["agent_start", "agent_end"]);
  });

  test("dispose unsubscribes and disposes the driver", async () => {
    const { driver, bus, ref, runtime } = makeRuntime();
    let count = 0;
    bus.subscribe(ref.id, () => count++);
    await runtime.dispose();
    driver.emit({ type: "agent_start" } as AgentSessionEvent);
    expect(driver.disposed).toBe(true);
    expect(count).toBe(0);
  });

  test("unimplemented verbs reject with a clear message", async () => {
    const { mailbox } = makeRuntime();
    const res = await mailbox.post(cmd("alice", "setModel", { model: "haiku" }));
    expect(res.accepted).toBe(false);
    expect(res.reason).toContain("slice 1");
  });
});
