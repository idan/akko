import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrincipalId, SessionId, SessionRef, WorkspaceId } from "@akko/core";
import { BunSqliteAdapter } from "../src/sqlite-bun.ts";
import { InMemorySessionIndex, SqliteSessionIndex } from "../src/session-index.ts";

const dir = mkdtempSync(join(tmpdir(), "akko-idx-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function ref(id: string, ws: string, kind: SessionRef["kind"] = "conversation"): SessionRef {
  return {
    id: id as SessionId,
    workspaceId: ws as WorkspaceId,
    ownerId: "alice" as PrincipalId,
    kind,
    title: `t-${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("InMemorySessionIndex", () => {
  test("upsert / get / list / touch", () => {
    const idx = new InMemorySessionIndex();
    idx.upsertRef(ref("ses_a", "wsp_1"));
    idx.upsertRef(ref("ses_b", "wsp_1"));
    idx.upsertRef(ref("ses_c", "wsp_2"));
    expect(idx.getRef("ses_a" as SessionId)?.title).toBe("t-ses_a");
    expect(idx.listRefs("wsp_1" as WorkspaceId).map((r) => r.id as string).sort()).toEqual([
      "ses_a",
      "ses_b",
    ]);
    idx.touch("ses_a" as SessionId, 99);
    expect(idx.getRef("ses_a" as SessionId)?.updatedAt).toBe(99);
  });
});

describe("SqliteSessionIndex", () => {
  test("upsert is idempotent and updates fields", () => {
    const db = new BunSqliteAdapter();
    const idx = new SqliteSessionIndex(db);
    idx.upsertRef(ref("ses_a", "wsp_1"));
    const updated = { ...ref("ses_a", "wsp_1"), title: "renamed", updatedAt: 5 };
    idx.upsertRef(updated);
    expect(idx.listRefs("wsp_1" as WorkspaceId).length).toBe(1);
    expect(idx.getRef("ses_a" as SessionId)?.title).toBe("renamed");
    db.close();
  });

  test("lists by workspace and survives a fresh adapter over the same file", () => {
    const path = join(dir, "idx.db");
    const dbA = new BunSqliteAdapter(path);
    const idxA = new SqliteSessionIndex(dbA);
    idxA.upsertRef(ref("ses_a", "wsp_1"));
    idxA.upsertRef(ref("ses_b", "wsp_1"));
    idxA.upsertRef(ref("ses_c", "wsp_2"));
    dbA.close();

    const dbB = new BunSqliteAdapter(path);
    const idxB = new SqliteSessionIndex(dbB);
    expect(idxB.listRefs("wsp_1" as WorkspaceId).map((r) => r.id as string).sort()).toEqual([
      "ses_a",
      "ses_b",
    ]);
    expect(idxB.getRef("ses_c" as SessionId)?.workspaceId as string).toBe("wsp_2");
    dbB.close();
  });
});
