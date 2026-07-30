/**
 * createGatewayServer — the HTTP gateway (doc 08).
 *
 * **Commands in over HTTP, reads out over Jazz** (doc 15, unify step 3). There is no
 * WebSocket: the browser POSTs attributed commands and observes every effect through the
 * Jazz read model, which is what already gives cross-tab/device/member sync. That removed
 * the client-side event reducer, the per-socket fan-out and a whole second render path.
 *
 * Auth (doc 16): Better Auth runs in-process, mounted at `/api/auth/*`. Identity is
 * derived from the Better Auth **session cookie**, validated on every `/api/*` request,
 * never from a client-asserted id.
 *
 * - `POST/GET /api/auth/*`     Better Auth (passkey ceremonies, session, jwks).
 * - `POST /api/sessions`       creates a conversation (must be editor/owner of the workspace).
 * - `GET  /api/sessions?workspaceId=`  lists sessions (must be a member).
 * - `POST /api/sessions/:id/commands`  attributed command -> session mailbox.
 * - `GET  /api/models?workspaceId=`    available models for the picker (must be a member).
 * - `GET  /api/skills?workspaceId=`    skill inventory + system-prompt budget (doc 06).
 * - `POST /api/sessions/:id/projection` backfills the read model for a session on open.
 * - `GET  /api/sessions/:id/history`   canonical finalized messages (backfill/debug).
 */
import type { Server } from "bun";
import type {
  Command,
  CommandVerb,
  CommittedEntry,
  EventBus,
  Mailbox,
  ModelCatalogEntry,
  PrincipalId,
  SessionId,
  SessionRef,
  WorkspaceId,
} from "@akko/core";
import { newCommandId, type MembershipStore } from "@akko/runtime";
import type { CreateSessionRequest, HistoryMessage } from "./protocol.ts";

/** The subset of the session registry the gateway needs (satisfied by `AkkoSessionRegistry`). */
export interface GatewaySessions {
  get(sessionId: SessionId): Promise<{ ref: SessionRef; mailbox: Mailbox }>;
  createConversation(input: {
    workspaceId: WorkspaceId;
    ownerId: PrincipalId;
    title?: string;
    model?: string;
  }): Promise<{ ref: SessionRef; mailbox: Mailbox }>;
  list(workspaceId: WorkspaceId, principalId: PrincipalId): Promise<SessionRef[]>;
  /** Cheap metadata lookup (session index only; no rehydration). */
  getRef(sessionId: SessionId): Promise<SessionRef | undefined>;
  /** Canonical conversation history (doc 04) — backfills the read model and debugging. */
  getEntries(sessionId: SessionId): Promise<CommittedEntry[]>;
  /** Available models for a workspace (doc 05). */
  listModels(workspaceId: WorkspaceId): Promise<ModelCatalogEntry[]>;
  /** Ensure the read-model projection exists for a session, without rehydrating pi. */
  ensureProjected?(sessionId: SessionId): Promise<boolean>;
}

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
  /** Optional skills inventory/budget service (doc 06). Omitted => the endpoint is empty. */
  skills?: {
    list(workspaceId: WorkspaceId): Promise<unknown[]>;
    impact(workspaceId: WorkspaceId): Promise<unknown>;
  };
  port?: number;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export function createGatewayServer(deps: GatewayServerDeps): Server<undefined> {
  return Bun.serve({
    port: deps.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);

      // Better Auth owns everything under /api/auth (passkey ceremonies, session, jwks).
      if (url.pathname.startsWith("/api/auth/")) {
        return deps.auth.handler(req);
      }

      // POST /api/sessions/<id>/projection — make sure the read model has this session's
      // history before the client renders it. The projection is disposable and rebuilt
      // from SQLite (doc 04), so a cold session (or any session after a sync-server
      // restart) has metadata but no messages until something asks for them.
      const projection = url.pathname.match(/^\/api\/sessions\/([^/]+)\/projection$/);
      if (projection && req.method === "POST") {
        const principal = await deps.auth.getPrincipal(req.headers);
        if (!principal) return json({ error: "unauthenticated" }, 401);
        const sessionId = projection[1] as SessionId;
        const ref = await deps.registry.getRef(sessionId);
        if (!ref) return json({ error: "unknown session" }, 404);
        if (!deps.memberships.roleFor(ref.workspaceId, principal.principalId)) {
          return json({ error: "not a member of this workspace" }, 403);
        }
        await deps.registry.ensureProjected?.(sessionId);
        return json({ ok: true });
      }

      // POST /api/sessions/<id>/commands — the whole write path (doc 08). Commands are
      // attributed server-side from the cookie, posted to the session mailbox (which
      // preserves per-session ordering), and the caller gets the decision back. Effects
      // reach every observer through the Jazz read model, not this response.
      const commands = url.pathname.match(/^\/api\/sessions\/([^/]+)\/commands$/);
      if (commands && req.method === "POST") {
        const principal = await deps.auth.getPrincipal(req.headers);
        if (!principal) return json({ error: "unauthenticated" }, 401);
        const sessionId = commands[1] as SessionId;
        const ref = await deps.registry.getRef(sessionId);
        if (ref && !deps.memberships.roleFor(ref.workspaceId, principal.principalId)) {
          return json({ error: "not a member of this workspace" }, 403);
        }
        let body: { verb?: CommandVerb; args?: Record<string, unknown>; streamingBehavior?: Command["streamingBehavior"] };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return json({ error: "invalid json" }, 400);
        }
        if (!body?.verb) return json({ error: "missing verb" }, 400);
        try {
          const runtime = await deps.registry.get(sessionId);
          const command: Command = {
            id: newCommandId(),
            sessionId,
            actorId: principal.principalId,
            verb: body.verb,
            args: body.args ?? {},
            ts: Date.now(),
            streamingBehavior: body.streamingBehavior,
          };
          const result = await runtime.mailbox.post(command);
          // A rejected command is a legitimate outcome, not a transport failure: the
          // policy said no. 200 with the decision keeps that distinction visible.
          return json({ result });
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
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
          return json({ ref: runtime.ref });
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
          return json({ sessions });
        }
      }

      // GET /api/models?workspaceId=<id> — available models for the picker (doc 05).
      // GET /api/skills — inventory plus the standing system-prompt cost (doc 06). Every
      // enabled skill's description sits in the prompt on every turn; this makes that
      // visible instead of invisible.
      if (url.pathname === "/api/skills" && req.method === "GET") {
        const principal = await deps.auth.getPrincipal(req.headers);
        if (!principal) return json({ error: "unauthenticated" }, 401);
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) return json({ error: "missing workspaceId" }, 400);
        if (!deps.memberships.roleFor(workspaceId as WorkspaceId, principal.principalId)) {
          return json({ error: "not a member of this workspace" }, 403);
        }
        if (!deps.skills) return json({ skills: [], impact: null });
        const [skills, impact] = await Promise.all([
          deps.skills.list(workspaceId as WorkspaceId),
          deps.skills.impact(workspaceId as WorkspaceId),
        ]);
        return json({ skills, impact });
      }

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
  });
}
