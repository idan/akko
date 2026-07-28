/**
 * Frontend config (doc 14/15).
 *
 * Jazz is no longer optional: it is the *only* read model, so the app cannot render
 * without a sync server. There is no `VITE_JAZZ` flag any more — `bun run dev` starts
 * the sync server alongside the gateway and web dev server.
 */
const env = import.meta.env as Record<string, string | undefined>;

export const JAZZ_SYNC: string = (env.VITE_JAZZ_SYNC as string | undefined) ?? "http://localhost:4200";
export const JAZZ_APP_ID: string =
  (env.VITE_JAZZ_APP_ID as string | undefined) ?? "e0c77d7c-fc80-5775-8a1d-7f74d66410bf";

/** Verbose Jazz client logging (`VITE_JAZZ_DEBUG=1`) — pairs with `AKKO_JAZZ_DEBUG` server-side. */
export const JAZZ_DEBUG: boolean = env.VITE_JAZZ_DEBUG === "1";
