/**
 * createGatewayServer — thin `Bun.serve` adapter over `GatewayConnection` (doc 08).
 *
 * - `GET /ws?principal=<id>`  upgrades to a WebSocket; identity is fixed at connect.
 * - `POST /api/sessions`      creates a conversation (principal via `x-akko-principal`).
 * - `GET  /api/sessions?workspaceId=<id>`  lists sessions in a workspace.
 *
 * All realtime traffic (subscribe/command/events) flows over the WebSocket; HTTP is
 * only the small CRUD surface needed to obtain a session id to subscribe to.
 */
import type { Server, ServerWebSocket } from "bun";
import type { EventBus, PrincipalId, WorkspaceId } from "@akko/core";
import { GatewayConnection, type GatewaySessions } from "./connection.ts";
import type { CreateSessionRequest } from "./protocol.ts";

export interface GatewayServerDeps {
  registry: GatewaySessions;
  eventBus: EventBus;
  port?: number;
}

interface SocketData {
  principalId: PrincipalId;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-akko-principal",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

export function createGatewayServer(deps: GatewayServerDeps): Server<SocketData> {
  const connections = new WeakMap<ServerWebSocket<SocketData>, GatewayConnection>();

  return Bun.serve<SocketData>({
    port: deps.port ?? 0,
    async fetch(req, server) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      if (url.pathname === "/ws") {
        const principal = url.searchParams.get("principal");
        if (!principal) return json({ error: "missing principal" }, 400);
        const ok = server.upgrade(req, { data: { principalId: principal as PrincipalId } });
        return ok ? undefined : json({ error: "upgrade failed" }, 400);
      }

      if (url.pathname === "/api/sessions") {
        const principal = req.headers.get("x-akko-principal");
        if (!principal) return json({ error: "missing x-akko-principal" }, 401);

        if (req.method === "POST") {
          const body = (await req.json()) as CreateSessionRequest;
          if (!body?.workspaceId) return json({ error: "missing workspaceId" }, 400);
          const runtime = await deps.registry.createConversation({
            workspaceId: body.workspaceId as WorkspaceId,
            ownerId: principal as PrincipalId,
            title: body.title,
          });
          const jazzId = deps.registry.projectionId?.(runtime.ref.id);
          return json({ ref: { ...runtime.ref, jazzId } });
        }
        if (req.method === "GET") {
          const workspaceId = url.searchParams.get("workspaceId");
          if (!workspaceId) return json({ error: "missing workspaceId" }, 400);
          const sessions = await deps.registry.list(
            workspaceId as WorkspaceId,
            principal as PrincipalId,
          );
          const withJazz = sessions.map((ref) => ({
            ...ref,
            jazzId: deps.registry.projectionId?.(ref.id),
          }));
          return json({ sessions: withJazz });
        }
      }

      return json({ error: "not found" }, 404);
    },
    websocket: {
      open(ws) {
        connections.set(
          ws,
          new GatewayConnection({
            principalId: ws.data.principalId,
            send: (message) => ws.send(JSON.stringify(message)),
            registry: deps.registry,
            eventBus: deps.eventBus,
          }),
        );
      },
      message(ws, message) {
        void connections.get(ws)?.handle(typeof message === "string" ? message : message.toString());
      },
      close(ws) {
        connections.get(ws)?.close();
        connections.delete(ws);
      },
    },
  });
}
