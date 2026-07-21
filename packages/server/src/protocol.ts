/**
 * Re-export the shared wire protocol from `@akko/protocol`.
 *
 * The protocol lives in its own dependency-light package so the browser frontend can
 * import it without pulling `bun`/pi runtime. Server modules keep importing
 * `./protocol.ts`.
 */
export * from "@akko/protocol";