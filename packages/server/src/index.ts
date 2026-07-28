/**
 * @akko/server — the HTTP gateway + Jazz projector (doc 08/14).
 *
 * `createGatewayServer` wires `Bun.serve` to `GatewayConnection`, the transport-agnostic
 * CQRS handler. The wire protocol (`protocol.ts`) is exported for the frontend.
 */
export * from "./protocol.ts";
export * from "./gateway.ts";
export * from "./jazz-projector.ts";
export * from "./jazz-worker.ts";
