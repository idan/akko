/**
 * Jazz worker bootstrap for the backend (doc 14).
 *
 * Starts the server-side Jazz worker account and connects it to a sync server, with the
 * WASM crypto backend (verified on Bun). The worker becomes the active account so the
 * `JazzProjector` can create/write CoValues.
 *
 * Dev setup (one-time): create a worker account and export its env vars:
 *   bunx jazz-run account create --name akko-worker
 *   export JAZZ_SYNC=ws://localhost:4200 JAZZ_WORKER_ACCOUNT=... JAZZ_WORKER_SECRET=...
 */
import { WasmCrypto } from "cojson/crypto/WasmCrypto";
import { startWorker } from "jazz-tools/worker";

export interface AkkoWorkerConfig {
  syncServer: string;
  accountID: string;
  accountSecret: string;
}

/** Read worker config from env; returns undefined if not fully configured (projector disabled). */
export function workerConfigFromEnv(): AkkoWorkerConfig | undefined {
  const syncServer = process.env.JAZZ_SYNC;
  const accountID = process.env.JAZZ_WORKER_ACCOUNT;
  const accountSecret = process.env.JAZZ_WORKER_SECRET;
  if (syncServer && accountID && accountSecret) return { syncServer, accountID, accountSecret };
  return undefined;
}

/** Start the worker; it registers as the active account. */
export async function startAkkoWorker(config: AkkoWorkerConfig): Promise<void> {
  const crypto = await WasmCrypto.create();
  await startWorker({
    syncServer: config.syncServer,
    accountID: config.accountID,
    accountSecret: config.accountSecret,
    crypto,
    asActiveAccount: true,
  });
}