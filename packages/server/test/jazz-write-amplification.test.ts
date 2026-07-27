/**
 * Measures **write amplification** of the live `activity` projection (doc 15, the
 * measurement gating unify step 3): how many Jazz row-writes a streaming turn costs.
 *
 * This is the number that decides whether Jazz can carry token-by-token streaming as the
 * *sole* read model, or whether the WebSocket has to stay for it. Every activity write is
 * a CoValue transaction synced to every subscriber, so the cost scales with observers.
 *
 * It uses a counting `Db` stub rather than a real server: we are measuring the projector's
 * coalescing policy (`STREAM_FLUSH_MS`), not Jazz's throughput, and a stub makes the
 * result deterministic and fast.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryEventBus } from "@akko/runtime";
import { app } from "@akko/schema";
import type { PrincipalId, SessionId, SessionRef, WorkspaceId } from "@akko/core";
import { JazzProjector } from "../src/jazz-projector.ts";

const STREAM_FLUSH_MS = 40; // mirrors the projector constant

/** Counts writes per table so we can separate activity churn from message rows. */
function countingDb() {
  const writes: Record<string, number> = {};
  const label = (t: unknown) =>
    t === app.activity ? "activity" : t === app.sessions ? "sessions" : t === app.messages ? "messages" : "other";
  const db = {
    upsert: (table: unknown, ..._rest: unknown[]) => {
      const key = label(table);
      writes[key] = (writes[key] ?? 0) + 1;
      return { id: "row" };
    },
    insert: () => ({ id: "row" }),
    delete: () => {},
    query: () => [],
  };
  return { db, writes, total: () => Object.values(writes).reduce((a, b) => a + b, 0) };
}

const ref: SessionRef = {
  id: "ses_amp" as SessionId,
  workspaceId: "wsp_dev" as WorkspaceId,
  ownerId: "prn_owner" as PrincipalId,
  kind: "conversation",
  createdAt: 1,
  updatedAt: 1,
};

/**
 * Emits `tokens` text deltas spread over `durationMs`, as pi would during a turn.
 * Returns the **measured** elapsed ms: sleep overhead makes the real turn longer than
 * nominal, and the flush ceiling is a function of wall-clock time, not the nominal figure.
 */
async function streamTurn(bus: InMemoryEventBus, tokens: number, durationMs: number): Promise<number> {
  const started = Date.now();
  bus.publish({
    sessionId: ref.id,
    type: "pi",
    event: { type: "message_start", message: { role: "assistant", content: [] } },
  } as never);
  const gap = durationMs / tokens;
  for (let i = 0; i < tokens; i++) {
    bus.publish({
      sessionId: ref.id,
      type: "pi",
      event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "tok " } },
    } as never);
    await Bun.sleep(gap);
  }
  const elapsed = Date.now() - started;
  bus.publish({ sessionId: ref.id, type: "pi", event: { type: "turn_end" } } as never);
  await Bun.sleep(STREAM_FLUSH_MS * 2); // let the trailing flush land
  return elapsed;
}

describe("jazz write amplification (unify step 3 gate)", () => {
  test("streamed tokens coalesce to a bounded write rate, not one write per token", async () => {
    const { db, writes, total } = countingDb();
    const bus = new InMemoryEventBus();
    const projector = new JazzProjector(db as never, { eventBus: bus });
    projector.ensureSession(ref);

    const setupWrites = total(); // session row + any initial activity
    const tokens = 400;
    const durationMs = 2000; // 200 tok/s — faster than a real model, a pessimistic case
    const elapsed = await streamTurn(bus, tokens, durationMs);

    const turnWrites = total() - setupWrites;
    expect(turnWrites).toBeGreaterThan(0); // guard: a silent no-op would pass every bound below
    const ceiling = Math.ceil(elapsed / STREAM_FLUSH_MS) + 4; // + start/idle/slack

    // The point of the measurement: writes track *elapsed time*, not token count.
    expect(turnWrites).toBeLessThan(tokens / 4);
    expect(turnWrites).toBeLessThanOrEqual(ceiling);

    const perSecond = turnWrites / (elapsed / 1000);
    console.log(
      `[write-amplification] ${tokens} tokens over ${elapsed}ms -> ${turnWrites} row writes ` +
        `(${perSecond.toFixed(1)}/s, ceiling ${ceiling}); tables=${JSON.stringify(writes)}`,
    );
    // Sanity: the whole turn is one logical row being upserted, so this is 1 row * N revisions.
    expect(perSecond).toBeLessThanOrEqual(1000 / STREAM_FLUSH_MS + 1);
  });

  test("a slow turn costs writes proportional to its duration, independent of token rate", async () => {
    const { db, total } = countingDb();
    const bus = new InMemoryEventBus();
    const projector = new JazzProjector(db as never, { eventBus: bus });
    projector.ensureSession(ref);

    const setupWrites = total();
    const elapsed = await streamTurn(bus, 40, 1000); // 40 tok/s — realistic model pace
    const turnWrites = total() - setupWrites;
    expect(turnWrites).toBeGreaterThan(0);

    // One flush per 40ms of wall clock, and far below one-write-per-token (40).
    expect(turnWrites).toBeLessThanOrEqual(Math.ceil(elapsed / STREAM_FLUSH_MS) + 4);
    console.log(`[write-amplification] 40 tokens over ${elapsed}ms -> ${turnWrites} row writes`);
  });
});
