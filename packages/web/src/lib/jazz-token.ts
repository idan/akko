/**
 * Jazz auth-token lifecycle (doc 16).
 *
 * Jazz authenticates its sync connection with a Better Auth JWT that expires (15 min by
 * default). Since Jazz is the *sole* read model (doc 15, unify step 3), an expired token
 * is not a degraded experience — it is a frozen UI with nothing to fall back to. So the
 * token is renewed ahead of expiry and re-checked whenever the tab wakes up.
 *
 * The wake-up path is the one that actually matters: after a laptop sleep a `setTimeout`
 * fires late (or the token expired mid-sleep), which is exactly when a reconnect needs a
 * valid token.
 */

/** Renew this long before `exp`, so a slow request can't race expiry. */
export const REFRESH_MARGIN_MS = 60_000;
/** Never busy-loop if a token is already expired or has an implausible `exp`. */
export const MIN_REFRESH_DELAY_MS = 5_000;
/** Fallback cadence when a token carries no usable `exp`. */
export const DEFAULT_REFRESH_MS = 10 * 60_000;

/** Read `exp` (seconds since epoch) from a JWT without verifying it. */
export function jwtExpiryMs(token: string): number | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** How long to wait before renewing `token`. Clamped so it is always a sane delay. */
export function msUntilRefresh(token: string, now: number = Date.now()): number {
  const expMs = jwtExpiryMs(token);
  if (expMs === null) return DEFAULT_REFRESH_MS;
  return Math.max(MIN_REFRESH_DELAY_MS, expMs - REFRESH_MARGIN_MS - now);
}

export interface TokenRefreshDeps {
  /** Fetch a fresh JWT (null when the session is gone). */
  getToken: () => Promise<string | null>;
  /** Hand the new token to the Jazz client (`client.updateAuthToken`). */
  apply: (token: string) => void;
  /** Called when a refresh fails, so the UI can surface a stale read model. */
  onError?: (error: unknown) => void;
  /** Test seam. */
  now?: () => number;
}

/**
 * Keep `apply` supplied with a live token. Returns a stop function.
 *
 * Failures retry on the short delay rather than giving up: losing the read model is worse
 * than a few wasted requests, and the common cause (backend briefly unreachable) is
 * transient.
 */
export function startJazzTokenRefresh(deps: TokenRefreshDeps): () => void {
  const now = deps.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let nextDueAt = Number.POSITIVE_INFINITY;

  const schedule = (delay: number) => {
    if (stopped) return;
    nextDueAt = now() + delay;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), delay);
  };

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    try {
      const token = await deps.getToken();
      if (stopped) return;
      if (!token) {
        deps.onError?.(new Error("no token (signed out?)"));
        schedule(MIN_REFRESH_DELAY_MS);
        return;
      }
      deps.apply(token);
      schedule(msUntilRefresh(token, now()));
    } catch (error) {
      deps.onError?.(error);
      schedule(MIN_REFRESH_DELAY_MS);
    }
  };

  // Timers are unreliable across sleep, so re-check on wake. If the scheduled refresh is
  // already due (or overdue), run it now rather than waiting for a stale timer.
  const onVisible = () => {
    if (document.visibilityState === "visible" && now() >= nextDueAt) void refresh();
  };
  document.addEventListener("visibilitychange", onVisible);

  void refresh();

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
