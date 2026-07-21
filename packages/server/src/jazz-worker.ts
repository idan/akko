/**
 * Jazz 2.0 backend context for the server (doc 14).
 *
 * Connects a backend `Db` to a running Jazz sync server (`jazz-tools server`). The
 * backend is authenticated by `backendSecret` and writes rows into the shared app
 * schema. Runs on Bun (verified: schema define + server + backend insert + query).
 *
 * Dev setup: run `bun run dev:sync` (`jazz-tools server`), then export:
 *   JAZZ_SYNC=<server url>  JAZZ_APP_ID=<app id>  JAZZ_BACKEND_SECRET=<secret>
 */
import { createJazzContext, type Db } from "jazz-tools/backend";
import { deploy } from "jazz-tools/dev";
import { app, permissions } from "@akko/schema";

export interface AkkoWorkerConfig {
  serverUrl: string;
  appId: string;
  backendSecret: string;
  /** Admin secret — when present the backend publishes the schema + policies on boot. */
  adminSecret?: string;
}

/** Read backend config from env; undefined if not fully configured (projector disabled). */
export function workerConfigFromEnv(): AkkoWorkerConfig | undefined {
  const serverUrl = process.env.JAZZ_SYNC;
  const appId = process.env.JAZZ_APP_ID;
  const backendSecret = process.env.JAZZ_BACKEND_SECRET;
  const adminSecret = process.env.JAZZ_ADMIN_SECRET;
  if (serverUrl && appId && backendSecret) return { serverUrl, appId, backendSecret, adminSecret };
  return undefined;
}

/** Publish the app schema + row policies to the server (idempotent). Needs the admin secret. */
export async function deployAkkoSchema(config: Required<Pick<AkkoWorkerConfig, "serverUrl" | "appId" | "adminSecret">>): Promise<void> {
  await deploy({
    serverUrl: config.serverUrl,
    appId: config.appId,
    adminSecret: config.adminSecret,
    schema: app.wasmSchema,
    permissions,
  } as Parameters<typeof deploy>[0]);
}

/** Create a backend-authenticated Db connected to the sync server. */
export function createBackendDb(config: AkkoWorkerConfig): Db {
  const context = createJazzContext({
    appId: config.appId,
    serverUrl: config.serverUrl,
    backendSecret: config.backendSecret,
    driver: { type: "memory" },
  });
  return context.asBackend(app.wasmSchema);
}