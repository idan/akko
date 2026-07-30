/**
 * Dev entrypoint: boots the full Akko backend and serves the gateway.
 *
 * Wires the real registry (SQLite-canonical store + durable index + host workspace
 * runtime) to the WS/HTTP gateway, plus in-process Better Auth (passkeys) and the
 * membership store + role policy (doc 16). Run with:
 *
 *   bun run packages/server/src/main.ts
 *
 * Env:
 *   AKKO_PORT         gateway port (default 8787)
 *   AKKO_DATA_DIR     data directory (default ~/.akko)
 *   AKKO_WORKSPACE    dev workspace id (default wsp_dev)
 *   AKKO_WEB_ORIGIN   browser origin of the web app (default http://localhost:5173)
 *   AKKO_AUTH_SECRET  Better Auth signing secret (default dev-only value)
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { RoleBasedPolicy, type Workspace, type WorkspaceId } from "@akko/core";
import {
  AkkoSessionRegistry,
  BunSqliteAdapter,
  HostWorkspaceRuntimeFactory,
  InMemoryEventBus,
  SqliteConversationStore,
  SqliteMembershipStore,
  SqliteSessionIndex,
  AkkoSkillsService,
  SqliteWorkspaceConfigStore,
} from "@akko/runtime";
import { createGatewayServer } from "./gateway.ts";
import { createAkkoAuth } from "./auth.ts";
import { JazzProjector } from "./jazz-projector.ts";
import { createBackendDb, deployAkkoSchema, workerConfigFromEnv } from "./jazz-worker.ts";

const port = Number(process.env.AKKO_PORT ?? 8787);
const dataDir = process.env.AKKO_DATA_DIR ?? join(homedir(), ".akko");
const workspaceId = (process.env.AKKO_WORKSPACE ?? "wsp_dev") as WorkspaceId;
const webOrigin = process.env.AKKO_WEB_ORIGIN ?? "http://localhost:5173";
const authSecret = process.env.AKKO_AUTH_SECRET ?? "akko-dev-auth-secret-change-me-0123456789abcdef";
const storageRoot = join(dataDir, "workspaces", workspaceId);
mkdirSync(storageRoot, { recursive: true });

const dbPath = join(dataDir, "akko.db");
const db = new BunSqliteAdapter(dbPath);
const eventBus = new InMemoryEventBus();

// Membership store (doc 02/16): the durable principal→workspace→role map.
const memberships = new SqliteMembershipStore(db);

// Better Auth (doc 16) — passkeys, in-process, its tables on the same canonical DB.
// A separate bun:sqlite handle on the same file (WAL): Better Auth manages its own tables.
const authDb = new Database(dbPath);
const { handler, getPrincipal, options } = createAkkoAuth({
  db: authDb,
  baseURL: webOrigin,
  secret: authSecret,
  rpID: new URL(webOrigin).hostname,
  rpName: "Akko",
  origin: webOrigin,
  trustedOrigins: [webOrigin],
  onUserCreated: (user) => {
    // First member of the default workspace owns it (doc 16). Per-user personal
    // workspaces are a follow-up.
    memberships.grant({ workspaceId, principalId: user.id, role: "owner" });
    console.log(`  auth:      registered ${user.email} (${user.id}) → owner of ${workspaceId}`);
  },
  memberships,
});
// Create Better Auth's tables on first boot (idempotent).
const { runMigrations } = await getMigrations(options);
await runMigrations();
console.log(`  auth:      Better Auth ready (passkeys) at ${webOrigin}/api/auth`);

// Canonical conversation store (doc 04) — also the source the Jazz projector backfills from.
const conversationStore = new SqliteConversationStore({ db, cwd: join(storageRoot, "tree") });

// Optional Jazz projection (doc 14): enabled when JAZZ_SYNC + app id + backend secret set.
const workerConfig = workerConfigFromEnv();
let projector: JazzProjector | undefined;
if (workerConfig) {
  // Jazz is an opt-in read-model projection — never let its setup (schema deploy /
  // backend connect) block or crash the gateway. If the sync server is down or slow,
  // continue without projection; the core app is unaffected.
  try {
    if (workerConfig.adminSecret) {
      await deployAkkoSchema({
        serverUrl: workerConfig.serverUrl,
        appId: workerConfig.appId,
        adminSecret: workerConfig.adminSecret,
      });
      console.log(`  jazz:      deployed schema + policies to ${workerConfig.serverUrl}`);
    }
    projector = new JazzProjector(createBackendDb(workerConfig), {
      eventBus,
      getEntries: (sessionId) => conversationStore.getEntries(sessionId),
    });
    console.log(`  jazz:      projecting to ${workerConfig.serverUrl} (app ${workerConfig.appId})`);
  } catch (err) {
    projector = undefined;
    console.warn(`  jazz:      setup failed; continuing without projection: ${err instanceof Error ? err.message : String(err)}`);
  }
} else {
  console.log("  jazz:      disabled (set JAZZ_SYNC + JAZZ_APP_ID + JAZZ_BACKEND_SECRET)");
}

const config = new SqliteWorkspaceConfigStore(db);

const registry = new AkkoSessionRegistry({
  workspaceRuntimeFactory: new HostWorkspaceRuntimeFactory(),
  conversationStore,
  sessionIndex: new SqliteSessionIndex(db),
  memberships,
  config,
  policy: new RoleBasedPolicy(),
  eventBus,
  projector,
});

const workspace: Workspace = {
  id: workspaceId,
  name: "dev",
  storageRoot,
  isolation: "host",
};
registry.registerWorkspace(workspace);

const skills = new AkkoSkillsService({
  workspaceRuntime: (id) => registry.workspaceRuntimeFor(id),
  buildPreviewSession: () => registry.previewSession(workspaceId as WorkspaceId),
  config,
});

/** Warn when running sessions are using a stale skill set (doc 06). */
setInterval(() => {
  const stale = registry.staleSkillSessions(workspaceId as WorkspaceId);
  if (stale.length > 0) {
    console.warn(
      `[akko] ${stale.length} live session(s) built before the latest skills change; ` +
        `they keep the old prompt until they go cold: ${stale.join(", ")}`,
    );
  }
}, 60_000).unref?.();

const server = createGatewayServer({
  registry,
  eventBus,
  auth: { handler, getPrincipal },
  memberships,
  skills,
  port,
});

console.log(`akko gateway listening on http://localhost:${server.port}`);
console.log(`  workspace: ${workspaceId}`);
console.log(`  data dir:  ${dataDir}`);
