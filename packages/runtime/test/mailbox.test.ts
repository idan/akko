import { describe, expect, test } from "bun:test";
import {
  ALLOW,
  deny,
  type Command,
  type CommandId,
  type CommandVerb,
  type PrincipalId,
  type SessionId,
} from "@akko/core";
import { AkkoMailbox } from "../src/mailbox.ts";

let seq = 0;
function cmd(actor: string, verb: CommandVerb, args: unknown = {}): Command {
  return {
    id: `c${seq++}` as CommandId,
    sessionId: "s" as SessionId,
    actorId: actor as PrincipalId,
    verb,
    args,
    ts: Date.now(),
  };
}

describe("AkkoMailbox", () => {
  test("applies commands in post order, preserving attribution", async () => {
    const applied: Array<{ actor: string; verb: string }> = [];
    const mb = new AkkoMailbox({
      authorize: () => ALLOW,
      apply: async (c) => {
        applied.push({ actor: c.actorId, verb: c.verb });
      },
    });

    const results = await Promise.all([
      mb.post(cmd("alice", "prompt")),
      mb.post(cmd("bob", "steer")),
      mb.post(cmd("alice", "followUp")),
    ]);

    expect(results.every((r) => r.accepted)).toBe(true);
    expect(applied).toEqual([
      { actor: "alice", verb: "prompt" },
      { actor: "bob", verb: "steer" },
      { actor: "alice", verb: "followUp" },
    ]);
  });

  test("serializes: a slow apply does not interleave", async () => {
    const order: string[] = [];
    const mb = new AkkoMailbox({
      authorize: () => ALLOW,
      apply: async (c) => {
        order.push(`start:${c.verb}`);
        await new Promise((r) => setTimeout(r, c.verb === "prompt" ? 20 : 1));
        order.push(`end:${c.verb}`);
      },
    });
    await Promise.all([mb.post(cmd("a", "prompt")), mb.post(cmd("a", "steer"))]);
    expect(order).toEqual(["start:prompt", "end:prompt", "start:steer", "end:steer"]);
  });

  test("denied commands are rejected and never applied", async () => {
    const applied: string[] = [];
    const mb = new AkkoMailbox({
      authorize: (c) => (c.verb === "abort" ? deny("viewers cannot abort") : ALLOW),
      apply: async (c) => {
        applied.push(c.verb);
      },
    });

    const ok = await mb.post(cmd("a", "prompt"));
    const blocked = await mb.post(cmd("v", "abort"));

    expect(ok.accepted).toBe(true);
    expect(blocked.accepted).toBe(false);
    expect(blocked.reason).toBe("viewers cannot abort");
    expect(applied).toEqual(["prompt"]);
  });

  test("apply throwing rejects that command but continues the queue", async () => {
    const applied: string[] = [];
    const mb = new AkkoMailbox({
      authorize: () => ALLOW,
      apply: async (c) => {
        if (c.verb === "steer") throw new Error("boom");
        applied.push(c.verb);
      },
    });
    const [a, b, c] = await Promise.all([
      mb.post(cmd("a", "prompt")),
      mb.post(cmd("a", "steer")),
      mb.post(cmd("a", "followUp")),
    ]);
    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(false);
    expect(b.reason).toBe("boom");
    expect(c.accepted).toBe(true);
    expect(applied).toEqual(["prompt", "followUp"]);
  });

  test("pending() and size() reflect the queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const mb = new AkkoMailbox({
      authorize: () => ALLOW,
      apply: async () => {
        await gate;
      },
    });
    const p1 = mb.post(cmd("alice", "prompt"));
    const p2 = mb.post(cmd("bob", "steer"));
    // first is draining, second is queued
    expect(mb.size()).toBeGreaterThanOrEqual(1);
    expect(mb.pending().some((x) => x.actorId === "bob")).toBe(true);
    release();
    await Promise.all([p1, p2]);
    expect(mb.size()).toBe(0);
  });
});
