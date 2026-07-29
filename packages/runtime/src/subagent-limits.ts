/**
 * Concurrency limits for subagents (doc 03).
 *
 * Delegation multiplies token spend and in-flight model calls, so spawning is capped.
 * Hitting a cap is an **error returned to the model**, never a queue: with blocking
 * spawns a queue is a resource deadlock waiting to happen the moment we allow depth > 1
 * (parents holding slots while waiting for slots), and it would hang silently mid-turn.
 * An LLM caller can read a refusal and adapt — serialize, narrow the task, or do the work
 * inline — which a queue denies it the chance to do.
 *
 * Caps are resolved through a function rather than read from constants so a future
 * per-provider policy slots in without touching callers: a locally-served model may only
 * manage 2–3 concurrent calls, while a hosted provider is happy with far more.
 */

/** Why a spawn was refused — the message names the cap so the model can react usefully. */
export type SpawnRefusal = { allowed: false; reason: string };
export type SpawnDecision = { allowed: true } | SpawnRefusal;

export interface SubagentLimits {
  /** Max children running concurrently for one parent session. */
  perParent: number;
  /** Max children running concurrently across the whole process. */
  global: number;
  /**
   * How deep delegation may nest. 1 = conversations may spawn, children may not.
   * Depth is enforced by *withholding the tool* from children, so this is a backstop.
   */
  maxDepth: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
  perParent: 3,
  global: 8,
  maxDepth: 1,
};

/** Read limits from the environment, falling back to the defaults. */
export function limitsFromEnv(env: Record<string, string | undefined> = process.env): SubagentLimits {
  const num = (key: string, fallback: number) => {
    const raw = env[key];
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    perParent: num("AKKO_SUBAGENT_MAX_PER_PARENT", DEFAULT_SUBAGENT_LIMITS.perParent),
    global: num("AKKO_SUBAGENT_MAX_GLOBAL", DEFAULT_SUBAGENT_LIMITS.global),
    maxDepth: num("AKKO_SUBAGENT_MAX_DEPTH", DEFAULT_SUBAGENT_LIMITS.maxDepth),
  };
}

/**
 * Tracks in-flight subagents and decides whether another may start.
 *
 * `admit` is deliberately synchronous and non-blocking: the answer is yes or no, now.
 */
export class SubagentLimiter {
  readonly #limits: SubagentLimits;
  /** Live child count per parent session id. */
  readonly #perParent = new Map<string, number>();
  #total = 0;

  constructor(limits: SubagentLimits = DEFAULT_SUBAGENT_LIMITS) {
    this.#limits = limits;
  }

  get limits(): SubagentLimits {
    return this.#limits;
  }

  running(parentSessionId?: string): number {
    return parentSessionId ? (this.#perParent.get(parentSessionId) ?? 0) : this.#total;
  }

  /**
   * Reserve a slot. Returns a decision; on success the caller **must** eventually call
   * the returned `release` (in a `finally`), or slots leak and spawning wedges shut.
   */
  admit(parentSessionId: string, depth: number): SpawnDecision & { release?: () => void } {
    if (depth > this.#limits.maxDepth) {
      return {
        allowed: false,
        reason: `subagents may not nest deeper than ${this.#limits.maxDepth} level(s). Do this work inline.`,
      };
    }
    if (this.#total >= this.#limits.global) {
      return {
        allowed: false,
        reason:
          `the global subagent limit (${this.#limits.global}) is reached — other sessions are using them. ` +
          `Wait for one to finish, narrow the task, or do it inline.`,
      };
    }
    const mine = this.#perParent.get(parentSessionId) ?? 0;
    if (mine >= this.#limits.perParent) {
      return {
        allowed: false,
        reason:
          `this session's subagent limit (${this.#limits.perParent}) is reached with ${mine} already running. ` +
          `Wait for one to finish, narrow the task, or do it inline.`,
      };
    }

    this.#total += 1;
    this.#perParent.set(parentSessionId, mine + 1);
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return; // idempotent: double-release must not free someone else's slot
        released = true;
        this.#total = Math.max(0, this.#total - 1);
        const n = (this.#perParent.get(parentSessionId) ?? 1) - 1;
        if (n <= 0) this.#perParent.delete(parentSessionId);
        else this.#perParent.set(parentSessionId, n);
      },
    };
  }
}
