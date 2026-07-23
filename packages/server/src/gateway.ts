/**
 * createGatewayServer — thin `Bun.serve` adapter over `GatewayConnection` (doc 08).
 *
 * Auth (doc 16): Better Auth runs in-process. Its routes are mounted at `/api/auth/*`.
 * Identity is derived from the Better Auth **session cookie** — validated on every
 * `/api/*` request and at the `/ws` upgrade — never from a client-asserted id. The old
 * `?principal=` query param and `x-akko-principal` header are gone.
 *
 * - `POST/GET /api/auth/*`     Better Auth (passkey ceremonies, session, jwks).
 * - `GET /ws`                  upgrades to a WebSocket; principal comes from the cookie.
 * - `POST /api/sessions`       creates a conversation (must be editor/owner of the workspace).
 * - `GET  /api/sessions?workspaceId=`  lists sessions (must be a member).
 * - `GET  /api/models?workspaceId=`    available models for the picker (must be a member).
 * - `GET  /api/sessions/:id/history`   canonical finalized messages to seed the UI.
 */
import type { Server, ServerWebSocket } from "bun";
import type { EventBus, PrincipalId, SessionId, WorkspaceId } from "@akko/core";
import type { MembershipStore } from "@akko/runtime";
import { GatewayConnection, type GatewaySessions } from "./connection.ts";
import type { CreateSessionRequest, HistoryMessage } from "./protocol.ts";

/** The auth surface the gateway needs (satisfied by `createAkkoAuth`). */
export interface GatewayAuth {
  /** Handle a Better Auth route (`/api/auth/*`). */
  handler: (req: Request) => Promise<Response> | Response;
  /** Resolve the authenticated principal from request headers (the session cookie). */
  getPrincipal: (
    headers: Headers,
  ) => Promise<{ principalId: PrincipalId; displayName: string; email: string } | null>;
}

export interface GatewayServerDeps {
  registry: GatewaySessions;
  eventBus: EventBus;
  auth: GatewayAuth;
  memberships: MembershipStore;
  port?: number;
}

interface SocketData {
  principalId: PrincipalId;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export function createGatewayServer(deps: GatewayServerDeps): Server<SocketData> {
  const connections = new WeakMap<ServerWebSocket<SocketData>, GatewayConnection>();

  return Bun.serve<SocketData>({
    port: deps.port ?? 0,
    async fetch(req, server) {
      const url = new URL(req.url);

      // Better Auth owns everything under /api/auth (passkey ceremonies, session, jwks).
      if (url.pathname.startsWith("/api/auth/")) {
        return deps.auth.handler(req);
      }

      if (url.pathname === "/ws") {
        const principal = await deps.auth.getPrincipal(req.headers);
        if (!principal) return json({ error: "unauthenticated" }, 401);
        const ok = server.upgrade(req, { data: { principalId: principal.principalId } });
        return ok ? undefined : json({ error: "upgrade failed" }, 400);
      }

      if (url.pathname === "/api/sessions") {
        const principal = await deps.auth.getPrincipal(req.headers);
        if (!principal) return json({ error: "unauthenticated" }, 401);

        if (req.method === "POST") {
          const body = (await req.json()) as CreateSessionRequest;
          if (!body?.workspaceId) return json({ error: "missing workspaceId" }, 400);
          const workspaceId = body.workspaceId as WorkspaceId;
          const role = deps.memberships.roleFor(workspaceId, principal.principalId);
          if (!role) return json({ error: "not a member of this workspace" }, 403);
          if (role === "viewer") return json({ error: "viewers cannot create sessions" }, 403);
          const runtime = await deps.registry.createConversation({
            workspaceId,
            ownerId: principal.principalId,
            title: body.title,
          });
          const jazzId = deps.registry.projectionId?.(runtime.ref.id);
          return json({ ref: { ...runtime.ref, jazzId } });
        }
        if (req.method === "GET") {
          const workspaceId = url.searchParams.get("workspaceId");
          if (!workspaceId) return json({ error: "missing workspaceId" }, 400);
          if (!deps.memberships.roleFor(workspaceId as WorkspaceId, principal.principalId)) {
            return json({ error: "not a member of this workspace" }, 403);
          }
          const sessions = await deps.registry.list(
            workspaceId as WorkspaceId,
            principal.principalId,
          );
          const withJazz = sessions.map((ref) => ({
            ...ref,
            jazzId: deps.registry.projectionId?.(ref.id),
          }));
          return json({ sessions: withJazz });
        }
      }

      // GET /api/models?workspaceId=<id> — available models for the picker (doc 05).
      if (url.pathname === "/api/models" && req.method === "GET") {
        const principal = await deps.auth.getPrincipal(req.headers);
        if (!principal) return json({ error: "unauthenticated" }, 401);
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) return json({ error: "missing workspaceId" }, 400);
        if (!deps.memberships.roleFor(workspaceId as WorkspaceId, principal.principalId)) {
          return json({ error: "not a member of this workspace" }, 403);
        }
        const models = await deps.registry.listModels(workspaceId as WorkspaceId);
        return json({ models });
      }

      // GET /api/sessions/<id>/history — canonical finalized messages to seed the UI (doc 08).
      const history = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
      if (history && req.method === "GET") {
        const principal = await deps.auth.getPrincipal(req.headers);
        if (!principal) return json({ error: "unauthenticated" }, 401);
        try {
          const sessionId = history[1] as SessionId;
          const ref = await deps.registry.getRef(sessionId);
          if (ref && !deps.memberships.roleFor(ref.workspaceId, principal.principalId)) {
            return json({ error: "not a member of this workspace" }, 403);
          }
          const entries = await deps.registry.getEntries(sessionId);
          const messages: HistoryMessage[] = entries
            .map((e) => {
              const m = e.entry as { role?: string; content?: unknown };
              return { id: e.id, role: m?.role ?? "", content: m?.content, authorId: e.actorId };
            })
            .filter((m) => m.role === "user" || m.role === "assistant");
          return json({ messages });
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 404);
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
