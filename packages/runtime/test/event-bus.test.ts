import { describe, expect, test } from "bun:test";
import type { DomainEvent, SessionId } from "@akko/core";
import { InMemoryEventBus } from "../src/event-bus.ts";

const sid = (s: string) => s as SessionId;
const piEvent = (sessionId: SessionId): DomainEvent => ({
  type: "session",
  sessionId,
  patch: { hello: true },
});

describe("InMemoryEventBus", () => {
  test("delivers events to subscribers of the same session", () => {
    const bus = new InMemoryEventBus();
    const received: DomainEvent[] = [];
    bus.subscribe(sid("a"), (e) => received.push(e));
    bus.publish(piEvent(sid("a")));
    expect(received).toHaveLength(1);
  });

  test("isolates by session id", () => {
    const bus = new InMemoryEventBus();
    let count = 0;
    bus.subscribe(sid("a"), () => count++);
    bus.publish(piEvent(sid("b")));
    expect(count).toBe(0);
  });

  test("unsubscribe stops delivery", () => {
    const bus = new InMemoryEventBus();
    let count = 0;
    const off = bus.subscribe(sid("a"), () => count++);
    bus.publish(piEvent(sid("a")));
    off();
    bus.publish(piEvent(sid("a")));
    expect(count).toBe(1);
  });

  test("supports multiple subscribers", () => {
    const bus = new InMemoryEventBus();
    let a = 0;
    let b = 0;
    bus.subscribe(sid("s"), () => a++);
    bus.subscribe(sid("s"), () => b++);
    bus.publish(piEvent(sid("s")));
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
