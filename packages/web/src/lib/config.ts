/** Frontend config (doc 14). Jazz is opt-in via `VITE_JAZZ=1`. */
const env = import.meta.env;

export const JAZZ_ENABLED: boolean = env.VITE_JAZZ === "1";
export const JAZZ_SYNC: string = (env.VITE_JAZZ_SYNC as string | undefined) ?? "http://localhost:4200";
export const JAZZ_APP_ID: string =
  (env.VITE_JAZZ_APP_ID as string | undefined) ?? "e0c77d7c-fc80-5775-8a1d-7f74d66410bf";

/**
 * WebSocket endpoint for the gateway. Vite's dev proxy **cannot relay WS upgrades under
 * Bun** (`socket.destroySoon is not a function`), so in dev we connect straight to the
 * gateway instead of through `/ws`. In production the web app is served same-origin with
 * the gateway, so `""` means "same-origin `/ws`". Override with `VITE_WS_URL` if the
 * gateway runs on a non-default host/port.
 */
export const WS_URL: string =
  (env.VITE_WS_URL as string | undefined) ?? (import.meta.env.DEV ? "ws://localhost:8787/ws" : "");

/** Verbose Jazz client/read-model logging in the browser console. */
export const JAZZ_DEBUG: boolean = env.VITE_JAZZ_DEBUG === "1";