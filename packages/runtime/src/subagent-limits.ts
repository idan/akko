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
  /**
   * Per-provider concurrency, keyed by the provider half of `provider/id`.
   *
   * Applied **across all sessions**, unlike `perParent`, because the constraint it models
   * is a shared resource: a locally-served model may only manage 2–3 concurrent calls no
   * matter who asked, while a hosted provider is happy with far more. Providers absent
   * from the map are limited only by `perParent`/`global`.
   */
  perProvider?: Record<string, number>;
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
    perProvider: parseProviderLimits(env.AKKO_SUBAGENT_MAX_PER_PROVIDER),
  };
}

/** Parse `ollama=2,anthropic=8` into a map. Malformed pairs are ignored, not fatal. */
export function parseProviderLimits(raw: string | undefined): Record<string, number> | undefined {
  if (!raw?.trim()) return undefined;
  const out: Record<string, number> = {};
  for (const pair of raw.split(",")) {
    const [name, value] = pair.split("=").map((x) => x?.trim());
    if (!name || !value) continue;
    const n = Number.parseInt(value, 10);
    // A typo must not silently mean "unlimited", so only accept sane positive integers.
    if (Number.isFinite(n) && n > 0) out[name] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The provider half of a `provider/id` model reference. */
export function providerOf(modelRef: string | undefined): string | undefined {
  if (!modelRef) return undefined;
  const slash = modelRef.indexOf("/");
  return slash > 0 ? modelRef.slice(0, slash) : undefined;
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
  /** Live child count per provider, across all sessions (shared-resource limit). */
  readonly #perProvider = new Map<string, number>();
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

  /** Live children currently using a provider, across all sessions. */
  runningForProvider(provider: string): number {
    return this.#perProvider.get(provider) ?? 0;
  }

  /**
   * Reserve a slot. Returns a decision; on success the caller **must** eventually call
   * the returned `release` (in a `finally`), or slots leak and spawning wedges shut.
   */
  admit(
    parentSessionId: string,
    depth: number,
    provider?: string,
  ): SpawnDecision & { release?: () => void } {
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
    const providerCap = provider ? this.#limits.perProvider?.[provider] : undefined;
    if (provider && providerCap !== undefined) {
      const inFlight = this.#perProvider.get(provider) ?? 0;
      if (inFlight >= providerCap) {
        return {
          allowed: false,
          reason:
            `the concurrency limit for provider "${provider}" (${providerCap}) is reached. ` +
            `Wait for one to finish, or use a different model.`,
        };
      }
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
    if (provider) this.#perProvider.set(provider, (this.#perProvider.get(provider) ?? 0) + 1);
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
        if (provider) {
          const p = (this.#perProvider.get(provider) ?? 1) - 1;
          if (p <= 0) this.#perProvider.delete(provider);
          else this.#perProvider.set(provider, p);
        }
      },
    };
  }
}
