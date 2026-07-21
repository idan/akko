/**
 * @akko/server — the WebSocket + HTTP gateway (doc 08).
 *
 * `createGatewayServer` wires `Bun.serve` to `GatewayConnection`, the transport-agnostic
 * CQRS handler. The wire protocol (`protocol.ts`) is exported for the frontend.
 */
export * from "./protocol.ts";
export * from "./connection.ts";
export * from "./gateway.ts";
