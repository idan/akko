import { describe, expect, test } from "bun:test";
import { applyEvent, emptyConversation, markAwaiting, seedHistory, type WireEvent } from "../src/lib/conversation.ts";

const pi = (event: unknown): WireEvent => ({ type: "pi", sessionId: "s1", event });

describe("conversation reducer", () => {
  test("assistant message streams text across deltas and finalizes on end", () => {
    let s = emptyConversation();
    s = applyEvent(s, pi({ type: "message_start", message: { role: "assistant" } }));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.streaming).toBe(true);

    s = applyEvent(s, pi({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } }));
    s = applyEvent(s, pi({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } }));
    expect(s.messages[0]!.text).toBe("Hello");
    expect(s.messages[0]!.streaming).toBe(true);

    s = applyEvent(s, pi({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } }));
    expect(s.messages[0]!.streaming).toBe(false);
    expect(s.messages[0]!.text).toBe("Hello");
  });

  test("user message is captured from message_start with string or block content", () => {
    let s = emptyConversation();
    s = applyEvent(s, pi({ type: "message_start", message: { role: "user", content: "hi there" } }));
    expect(s.messages[0]).toMatchObject({ role: "user", text: "hi there", streaming: false });

    s = applyEvent(s, pi({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "block" }] } }));
    expect(s.messages[1]!.text).toBe("block");
  });

  test("ignores non-pi events and unrelated pi events", () => {
    const s0 = emptyConversation();
    expect(applyEvent(s0, { type: "session", sessionId: "s1" })).toBe(s0);
    expect(applyEvent(s0, pi({ type: "turn_start" }))).toBe(s0);
    // text_delta with no active assistant message is a no-op
    expect(applyEvent(s0, pi({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }))).toBe(s0);
  });

  test("interleaves user then assistant in order", () => {
    let s = emptyConversation();
    s = applyEvent(s, pi({ type: "message_start", message: { role: "user", content: "q" } }));
    s = applyEvent(s, pi({ type: "message_start", message: { role: "assistant" } }));
    s = applyEvent(s, pi({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } }));
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[1]!.text).toBe("a");
  });

  test("seedHistory builds finalized messages and drops non-chat roles", () => {
    const s = seedHistory(emptyConversation(), [
      { id: "e1", role: "user", content: "my name is Ada" },
      { id: "e2", role: "assistant", content: [{ type: "text", text: "Hi Ada" }] },
      { id: "e3", role: "tool", content: "ignored" },
    ]);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toMatchObject({ id: "e1", role: "user", text: "my name is Ada", streaming: false });
    expect(s.messages[1]).toMatchObject({ id: "e2", role: "assistant", text: "Hi Ada", streaming: false });
  });

  test("awaiting is set on send and cleared when the assistant starts streaming", () => {
    let s = markAwaiting(emptyConversation());
    expect(s.awaiting).toBe(true);
    // user echo keeps us waiting for the assistant
    s = applyEvent(s, pi({ type: "message_start", message: { role: "user", content: "hi" } }));
    expect(s.awaiting).toBe(true);
    // assistant begins -> thinking indicator clears
    s = applyEvent(s, pi({ type: "message_start", message: { role: "assistant" } }));
    expect(s.awaiting).toBe(false);
  });

  test("a user message from the wire raises awaiting for observer tabs (no local send)", () => {
    // Observer starts idle; a peer's prompt arrives purely as wire events.
    let s = emptyConversation();
    s = applyEvent(s, pi({ type: "message_start", message: { role: "user", content: "from peer" } }));
    expect(s.awaiting).toBe(true);
    s = applyEvent(s, pi({ type: "message_start", message: { role: "assistant" } }));
    expect(s.awaiting).toBe(false);
  });

  test("turn_end clears a lingering awaiting (turn produced no streamed text)", () => {
    let s = markAwaiting(emptyConversation());
    s = applyEvent(s, pi({ type: "turn_end" }));
    expect(s.awaiting).toBe(false);
  });
});