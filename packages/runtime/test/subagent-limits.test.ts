import { describe, expect, test } from "bun:test";
import { DEFAULT_SUBAGENT_LIMITS, limitsFromEnv, SubagentLimiter } from "../src/subagent-limits.ts";

describe("SubagentLimiter", () => {
  test("admits up to the per-parent cap, then refuses with an actionable reason", () => {
    const limiter = new SubagentLimiter({ perParent: 2, global: 10, maxDepth: 1 });

    expect(limiter.admit("p1", 1).allowed).toBe(true);
    expect(limiter.admit("p1", 1).allowed).toBe(true);

    const third = limiter.admit("p1", 1);
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.reason).toContain("this session's subagent limit (2)");
      expect(third.reason).toContain("inline"); // tells the model what it can do instead
    }
  });

  test("the per-parent cap is per parent, not shared", () => {
    const limiter = new SubagentLimiter({ perParent: 1, global: 10, maxDepth: 1 });
    expect(limiter.admit("p1", 1).allowed).toBe(true);
    expect(limiter.admit("p2", 1).allowed).toBe(true); // a different session is unaffected
    expect(limiter.admit("p1", 1).allowed).toBe(false);
  });

  test("the global cap applies across parents and names itself", () => {
    const limiter = new SubagentLimiter({ perParent: 5, global: 2, maxDepth: 1 });
    limiter.admit("p1", 1);
    limiter.admit("p2", 1);

    const refused = limiter.admit("p3", 1);
    expect(refused.allowed).toBe(false);
    // The distinction matters: "someone else is busy" calls for a different reaction
    // than "you personally are at your limit".
    if (!refused.allowed) expect(refused.reason).toContain("global subagent limit (2)");
  });

  test("depth beyond the cap is refused (backstop; children get no spawn tool anyway)", () => {
    const limiter = new SubagentLimiter({ perParent: 5, global: 5, maxDepth: 1 });
    const nested = limiter.admit("child", 2);
    expect(nested.allowed).toBe(false);
    if (!nested.allowed) expect(nested.reason).toContain("nest deeper");
  });

  test("releasing a slot frees capacity", () => {
    const limiter = new SubagentLimiter({ perParent: 1, global: 1, maxDepth: 1 });
    const first = limiter.admit("p1", 1);
    expect(limiter.admit("p1", 1).allowed).toBe(false);

    first.release?.();
    expect(limiter.running("p1")).toBe(0);
    expect(limiter.admit("p1", 1).allowed).toBe(true);
  });

  test("double release is idempotent and cannot free another session's slot", () => {
    const limiter = new SubagentLimiter({ perParent: 2, global: 2, maxDepth: 1 });
    const a = limiter.admit("p1", 1);
    limiter.admit("p2", 1);

    a.release?.();
    a.release?.(); // a buggy caller must not corrupt the accounting

    expect(limiter.running()).toBe(1); // p2 still holds its slot
    expect(limiter.running("p1")).toBe(0);
  });

  test("tracks totals across parents", () => {
    const limiter = new SubagentLimiter({ perParent: 2, global: 5, maxDepth: 1 });
    limiter.admit("p1", 1);
    limiter.admit("p1", 1);
    limiter.admit("p2", 1);
    expect(limiter.running()).toBe(3);
    expect(limiter.running("p1")).toBe(2);
    expect(limiter.running("p2")).toBe(1);
  });
});

describe("limitsFromEnv", () => {
  test("defaults when unset", () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_SUBAGENT_LIMITS);
  });

  test("reads overrides", () => {
    expect(
      limitsFromEnv({
        AKKO_SUBAGENT_MAX_PER_PARENT: "1",
        AKKO_SUBAGENT_MAX_GLOBAL: "4",
        AKKO_SUBAGENT_MAX_DEPTH: "2",
      }),
    ).toEqual({ perParent: 1, global: 4, maxDepth: 2 });
  });

  test("ignores garbage rather than disabling the cap", () => {
    // A typo'd env var must not silently mean "unlimited".
    expect(limitsFromEnv({ AKKO_SUBAGENT_MAX_GLOBAL: "lots" }).global).toBe(
      DEFAULT_SUBAGENT_LIMITS.global,
    );
    expect(limitsFromEnv({ AKKO_SUBAGENT_MAX_GLOBAL: "-3" }).global).toBe(
      DEFAULT_SUBAGENT_LIMITS.global,
    );
  });
});
