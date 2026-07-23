/**
 * db-reset — blow away the whole Akko database for a blank slate (doc 16/04).
 *
 * Removes the SQLite file and its WAL siblings. On the next server start, migrations
 * recreate every table (Better Auth's user/session/account/passkey/jwks and Akko's
 * memberships/sessions/entries), so you begin from empty. This wipes EVERYTHING —
 * users AND conversations. To remove a single user instead, use `db-delete-user.mjs`.
 *
 *   bun scripts/db-reset.mjs
 *
 * Respects AKKO_DATA_DIR (default ~/.akko), matching packages/server/src/main.ts.
 *
 * NOTE: stop the dev server first (it holds the SQLite/WAL file open). Passkeys stored in
 * your OS/browser password store are independent — delete them there too if reusing emails.
 */
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.AKKO_DATA_DIR ?? join(homedir(), ".akko");
const base = join(dataDir, "akko.db");
const files = [base, `${base}-shm`, `${base}-wal`, `${base}-journal`];

let removed = 0;
for (const f of files) {
  if (existsSync(f)) {
    rmSync(f);
    console.log(`removed ${f}`);
    removed++;
  }
}

if (removed === 0) {
  console.log(`nothing to remove (no database at ${base})`);
} else {
  console.log("done — a blank database is created on the next server start");
}
