import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommittedEntry, EntryId, PrincipalId, SessionId } from "@akko/core";
import { BunSqliteAdapter } from "../src/sqlite-bun.ts";
import { SqliteConversationStore } from "../src/sqlite-conversation-store.ts";

const dir = mkdtempSync(join(tmpdir(), "akko-cs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sid = "ses_test" as SessionId;

function userMsg(text: string) {
  return { role: "user", content: text, timestamp: Date.now() };
}
function assistantMsg(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "x",
    model: "y",
    usage: {},
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
function entry(id: string, parentId: string | null, msg: unknown, actorId?: string): CommittedEntry {
  return {
    id: id as EntryId,
    parentId: parentId as CommittedEntry["parentId"],
    entry: msg,
    actorId: actorId as PrincipalId | undefined,
    ts: Date.now(),
  };
}

describe("SqliteConversationStore", () => {
  test("persists entries and rebuilds conversation on load", async () => {
    const db = new BunSqliteAdapter();
    const store = new SqliteConversationStore({ db });
    await store.create(sid);

    await store.persistEntry(sid, entry("e1", null, userMsg("my name is Ada"), "alice"));
    await store.persistEntry(sid, entry("e2", "e1", assistantMsg("Hi Ada")));

    expect(store.count(sid)).toBe(2);
    const sm = await store.load(sid);
    const entries = sm.getEntries();
    expect(entries.length).toBe(2);
    expect((entries[0] as any).message.role).toBe("user");
    expect((entries[1] as any).message.role).toBe("assistant");
    db.close();
  });

  test("records and reads attribution per entry", async () => {
    const db = new BunSqliteAdapter();
    const store = new SqliteConversationStore({ db });
    await store.create(sid);
    await store.persistEntry(sid, entry("e1", null, userMsg("hi"), "alice"));
    await store.persistEntry(sid, entry("e2", "e1", assistantMsg("yo")));
    expect(await store.getActor(sid, "e1" as EntryId)).toBe("alice");
    expect(await store.getActor(sid, "e2" as EntryId)).toBeUndefined();
    db.close();
  });

  test("is durable across store + adapter instances (cross-process shape)", async () => {
    const path = join(dir, "conv.db");
    const dbA = new BunSqliteAdapter(path);
    const storeA = new SqliteConversationStore({ db: dbA });
    await storeA.create(sid);
    await storeA.persistEntry(sid, entry("e1", null, userMsg("persist me"), "alice"));
    dbA.close();

    // Fresh adapter + store over the same file: content survives.
    const dbB = new BunSqliteAdapter(path);
    const storeB = new SqliteConversationStore({ db: dbB });
    const sm = await storeB.load(sid);
    expect(sm.getEntries().length).toBe(1);
    expect(await storeB.getActor(sid, "e1" as EntryId)).toBe("alice");
    dbB.close();
  });

  test("duplicate entry ids are ignored (idempotent replication shape)", async () => {
    const db = new BunSqliteAdapter();
    const store = new SqliteConversationStore({ db });
    await store.create(sid);
    await store.persistEntry(sid, entry("e1", null, userMsg("once"), "alice"));
    await store.persistEntry(sid, entry("e1", null, userMsg("again"), "alice"));
    expect(store.count(sid)).toBe(1);
    db.close();
  });
});
