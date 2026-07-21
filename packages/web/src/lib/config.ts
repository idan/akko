/** Frontend config. `VITE_JAZZ_SYNC` overrides the Jazz sync server (doc 14). */
export const JAZZ_SYNC: string =
  (import.meta.env.VITE_JAZZ_SYNC as string | undefined) ?? "ws://localhost:4200";