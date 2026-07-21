/**
 * Dev entrypoint: boots the full Akko backend and serves the gateway.
 *
 * Wires the real registry (SQLite-canonical store + durable index + host workspace
 * runtime) to the WS/HTTP gateway and registers a single dev workspace. Run with:
 *
 *   bun run packages/server/src/main.ts
 *
 * Env:
 *   AKKO_PORT       gateway port (default 8787)
 *   AKKO_DATA_DIR   data directory (default ~/.akko)
 *   AKKO_WORKSPACE  dev workspace id (default wsp_dev)
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Workspace, WorkspaceId } from "@akko/core";
import {
  AkkoSessionRegistry,
  BunSqliteAdapter,
  HostWorkspaceRuntimeFactory,
  InMemoryEventBus,
  SqliteConversationStore,
  SqliteSessionIndex,
} from "@akko/runtime";
import { createGatewayServer } from "./gateway.ts";
import { JazzProjector } from "./jazz-projector.ts";
import { startAkkoWorker, workerConfigFromEnv } from "./jazz-worker.ts";

const port = Number(process.env.AKKO_PORT ?? 8787);
const dataDir = process.env.AKKO_DATA_DIR ?? join(homedir(), ".akko");
const workspaceId = (process.env.AKKO_WORKSPACE ?? "wsp_dev") as WorkspaceId;
const storageRoot = join(dataDir, "workspaces", workspaceId);
mkdirSync(storageRoot, { recursive: true });

const db = new BunSqliteAdapter(join(dataDir, "akko.db"));
const eventBus = new InMemoryEventBus();

// Optional Jazz projection (doc 14): enabled when JAZZ_SYNC + worker creds are set.
const workerConfig = workerConfigFromEnv();
let projector: JazzProjector | undefined;
if (workerConfig) {
  await startAkkoWorker(workerConfig);
  projector = new JazzProjector({ publicRead: true });
  console.log(`  jazz:      projecting to ${workerConfig.syncServer}`);
} else {
  console.log("  jazz:      disabled (set JAZZ_SYNC + JAZZ_WORKER_ACCOUNT + JAZZ_WORKER_SECRET)");
}

const registry = new AkkoSessionRegistry({
  workspaceRuntimeFactory: new HostWorkspaceRuntimeFactory(),
  conversationStore: new SqliteConversationStore({ db, cwd: join(storageRoot, "tree") }),
  sessionIndex: new SqliteSessionIndex(db),
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

const server = createGatewayServer({ registry, eventBus, port });

console.log(`akko gateway listening on http://localhost:${server.port}`);
console.log(`  workspace: ${workspaceId}`);
console.log(`  data dir:  ${dataDir}`);
console.log(`  ws:        ws://localhost:${server.port}/ws?principal=<id>`);