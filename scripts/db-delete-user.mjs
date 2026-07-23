/**
 * db-delete-user — remove a single user and everything tied to them (doc 16).
 *
 * Deletes the Better Auth rows (passkey / session / account) plus the Akko workspace
 * `memberships` for one principal, then the `user` row itself — in FK-safe order. Leaves
 * conversation `sessions`/`entries` alone (their `owner_id` will simply dangle). For a
 * truly blank slate use `db-reset.mjs`.
 *
 *   bun scripts/db-delete-user.mjs <email | prn_id>
 *
 * Respects AKKO_DATA_DIR (default ~/.akko), matching packages/server/src/main.ts.
 *
 * NOTE: stop the dev server first (it holds the SQLite/WAL file open). And remember the
 * passkey also lives in your OS/browser password store — delete it there too, or sign-in
 * will still offer the stale credential.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: bun scripts/db-delete-user.mjs <email | prn_id>");
  process.exit(2);
}

const dataDir = process.env.AKKO_DATA_DIR ?? join(homedir(), ".akko");
const dbPath = join(dataDir, "akko.db");
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath} (nothing to delete)`);
  process.exit(1);
}

const db = new Database(dbPath);
const byEmail = arg.includes("@");
const user = db
  .query(`SELECT id, name, email FROM user WHERE ${byEmail ? "email = ?" : "id = ?"}`)
  .get(byEmail ? arg.toLowerCase() : arg);

if (!user) {
  console.error(`no user matching ${byEmail ? "email" : "id"} "${arg}"`);
  process.exit(1);
}

const related = [
  ["passkey", "userId"],
  ["session", "userId"],
  ["account", "userId"],
  ["memberships", "principal_id"],
];

const counts = db.transaction(() => {
  const out = {};
  for (const [table, col] of related) {
    out[table] = db.query(`DELETE FROM ${table} WHERE ${col} = ?`).run(user.id).changes;
  }
  out.user = db.query("DELETE FROM user WHERE id = ?").run(user.id).changes;
  return out;
})();

console.log(`deleted user ${user.email} (${user.id})`);
for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(12)} ${n}`);
console.log("reminder: also remove the passkey from your OS/browser password store");
