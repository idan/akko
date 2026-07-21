/** Frontend config (doc 14). Jazz is opt-in via `VITE_JAZZ=1`. */
const env = import.meta.env;

export const JAZZ_ENABLED: boolean = env.VITE_JAZZ === "1";
export const JAZZ_SYNC: string = (env.VITE_JAZZ_SYNC as string | undefined) ?? "http://localhost:4200";
export const JAZZ_APP_ID: string =
  (env.VITE_JAZZ_APP_ID as string | undefined) ?? "00000000-0000-0000-0000-000000000001";