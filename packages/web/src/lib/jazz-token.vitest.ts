import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_REFRESH_MS,
  jwtExpiryMs,
  MIN_REFRESH_DELAY_MS,
  msUntilRefresh,
  REFRESH_MARGIN_MS,
  startJazzTokenRefresh,
} from "./jazz-token.ts";

/** Build an unsigned JWT with the given payload — only the payload is ever read. */
function token(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

describe("jwtExpiryMs", () => {
  test("reads exp as milliseconds", () => {
    expect(jwtExpiryMs(token({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000);
  });

  test("returns null for malformed or exp-less tokens", () => {
    expect(jwtExpiryMs("not-a-jwt")).toBeNull();
    expect(jwtExpiryMs(token({ sub: "x" }))).toBeNull();
    expect(jwtExpiryMs("")).toBeNull();
  });
});

describe("msUntilRefresh", () => {
  test("renews a margin before expiry", () => {
    const now = 1_000_000;
    const exp = now + 15 * 60_000; // a default 15-minute Better Auth token
    expect(msUntilRefresh(token({ exp: exp / 1000 }), now)).toBe(15 * 60_000 - REFRESH_MARGIN_MS);
  });

  test("clamps rather than scheduling in the past for an expired token", () => {
    const now = 1_000_000;
    const expired = token({ exp: (now - 60_000) / 1000 });
    expect(msUntilRefresh(expired, now)).toBe(MIN_REFRESH_DELAY_MS);
  });

  test("falls back to a fixed cadence when there is no exp", () => {
    expect(msUntilRefresh(token({ sub: "x" }), 1_000)).toBe(DEFAULT_REFRESH_MS);
  });
});

describe("startJazzTokenRefresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("applies a token immediately and again before it expires", async () => {
    const now = () => Date.now();
    const fresh = () => token({ exp: (Date.now() + 15 * 60_000) / 1000 });
    const getToken = vi.fn(async () => fresh());
    const apply = vi.fn();

    const stop = startJazzTokenRefresh({ getToken, apply, now });
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenCalledTimes(1);

    // Nothing until the margin is reached...
    await vi.advanceTimersByTimeAsync(13 * 60_000);
    expect(apply).toHaveBeenCalledTimes(1);
    // ...then a renewal lands before the 15-minute expiry.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(apply).toHaveBeenCalledTimes(2);

    stop();
  });

  test("retries on failure instead of giving up the read model", async () => {
    const onError = vi.fn();
    const getToken = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(token({ exp: (Date.now() + 900_000) / 1000 }));
    const apply = vi.fn();

    const stop = startJazzTokenRefresh({ getToken, apply, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MIN_REFRESH_DELAY_MS);
    expect(apply).toHaveBeenCalledTimes(1);

    stop();
  });

  test("a null token (signed out) reports an error and keeps retrying", async () => {
    const onError = vi.fn();
    const getToken = vi.fn(async () => null);
    const apply = vi.fn();

    const stop = startJazzTokenRefresh({ getToken, apply, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_REFRESH_DELAY_MS);
    expect(getToken).toHaveBeenCalledTimes(2);

    stop();
  });

  test("refreshes on wake when the scheduled renewal is overdue", async () => {
    // The sleep case: timers don't fire reliably, so waking must re-check.
    const getToken = vi.fn(async () => token({ exp: (Date.now() + 15 * 60_000) / 1000 }));
    const apply = vi.fn();
    const stop = startJazzTokenRefresh({ getToken, apply });
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenCalledTimes(1);

    // Jump past the due time without letting the timer run, as a sleeping tab would.
    vi.setSystemTime(Date.now() + 60 * 60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(apply).toHaveBeenCalledTimes(2);
    stop();
  });

  test("stop() halts further refreshes", async () => {
    const getToken = vi.fn(async () => token({ exp: (Date.now() + 900_000) / 1000 }));
    const apply = vi.fn();
    const stop = startJazzTokenRefresh({ getToken, apply });
    await vi.advanceTimersByTimeAsync(0);
    stop();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
