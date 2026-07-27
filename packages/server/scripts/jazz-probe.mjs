/**
 * jazz-probe — inspect what is actually stored in a running Jazz sync server (doc 14).
 *
 * Isolates the three layers that can make the Jazz view empty:
 *   1. data never reached the server   -> backend read shows nothing
 *   2. row policy filters it           -> backend sees rows, token read sees none
 *   3. browser-specific (worker/OPFS)  -> both reads work, but the browser shows nothing
 *
 *   bun scripts/jazz-probe.mjs <sessionId>              # read as BACKEND (bypasses policy)
 *   bun scripts/jazz-probe.mjs <sessionId> <jwt>        # also read as that USER (policy applies)
 *
 * Env (defaults match `bun run dev:jazz`):
 *   JAZZ_SYNC=http://localhost:4200
 *   JAZZ_APP_ID=e0c77d7c-fc80-5775-8a1d-7f74d66410bf
 *   JAZZ_BACKEND_SECRET=akko-dev-backend
 */
import { createJazzContext } from "jazz-tools/backend";
import { createJazzClient } from "jazz-tools/svelte";
import { app } from "@akko/schema";

const sessionId = process.argv[2];
const jwt = process.argv[3];
if (!sessionId) {
  console.error("usage: bun scripts/jazz-probe.mjs <sessionId> [jwt]");
  process.exit(2);
}

const serverUrl = process.env.JAZZ_SYNC ?? "http://localhost:4200";
const appId = process.env.JAZZ_APP_ID ?? "e0c77d7c-fc80-5775-8a1d-7f74d66410bf";
const backendSecret = process.env.JAZZ_BACKEND_SECRET ?? "akko-dev-backend";

const show = (label, rows) => {
  console.log(`\n-- ${label} --`);
  console.log(`messages: ${rows.messages.length}`);
  for (const m of rows.messages) console.log(`   [${m.workspaceId}] ${m.role}: ${String(m.text).slice(0, 60)}`);
  console.log(`activity: ${rows.activity.length}`);
  for (const a of rows.activity) console.log(`   [${a.workspaceId}] ${a.kind} user="${a.userText}" text="${String(a.text).slice(0, 40)}"`);
};

/** Poll briefly: local-first reads are eventually consistent on a cold context. */
async function read(db) {
  let messages = [];
  let activity = [];
  for (let i = 0; i < 15; i++) {
    messages = await db.all(app.messages.where({ sessionId }));
    activity = await db.all(app.activity.where({ sessionId }));
    if (messages.length || activity.length) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { messages, activity };
}

console.log(`probing ${serverUrl} (app ${appId}) for session ${sessionId}`);

// 1. Backend view - privileged, bypasses row policies. Shows what is really stored.
const backendDb = createJazzContext({ appId, serverUrl, backendSecret, driver: { type: "memory" } }).asBackend(
  app.wasmSchema,
);
show("AS BACKEND (policy bypassed - what's actually on the server)", await read(backendDb));

// 2. User view - exactly what the browser does (external JWT, policy applies).
if (jwt) {
  const client = await createJazzClient({ appId, serverUrl, jwtToken: jwt, driver: { type: "memory" } });
  console.log("\nclient session:", JSON.stringify(client.session));
  show("AS USER (external JWT - row policy applies)", await read(client.db));
  await client.shutdown();
} else {
  console.log("\n(no jwt passed - skipping the user-scoped read)");
}

process.exit(0);
