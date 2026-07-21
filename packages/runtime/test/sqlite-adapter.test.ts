import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSqliteAdapter } from "../src/sqlite-bun.ts";

const dir = mkdtempSync(join(tmpdir(), "akko-sql-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("BunSqliteAdapter", () => {
  test("exec / prepare / run / get / all round-trip", () => {
    const db = new BunSqliteAdapter();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const ins = db.prepare("INSERT INTO t (name) VALUES (?)");
    const r1 = ins.run("alice");
    ins.run("bob");
    expect(Number(r1.lastInsertRowid)).toBe(1);

    const one = db.prepare("SELECT name FROM t WHERE id = ?").get<{ name: string }>(1);
    expect(one?.name).toBe("alice");
    expect(db.prepare("SELECT name FROM t WHERE id = ?").get(999)).toBeUndefined();

    const all = db.prepare("SELECT name FROM t ORDER BY id").all<{ name: string }>();
    expect(all.map((r) => r.name)).toEqual(["alice", "bob"]);
    db.close();
  });

  test("transaction commits, and rolls back on throw", () => {
    const db = new BunSqliteAdapter();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.transaction(() => {
      db.prepare("INSERT INTO t (id) VALUES (1)").run();
      db.prepare("INSERT INTO t (id) VALUES (2)").run();
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get<{ n: number }>()?.n).toBe(2);

    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t (id) VALUES (3)").run();
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get<{ n: number }>()?.n).toBe(2);
    db.close();
  });

  test("FTS5 keyword search with bm25 ranking works (doc 13)", () => {
    const db = new BunSqliteAdapter();
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
    db.prepare("INSERT INTO docs(body) VALUES (?)").run("akko agent memory system");
    db.prepare("INSERT INTO docs(body) VALUES (?)").run("unrelated note about cooking");
    const hit = db
      .prepare("SELECT body, bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY score")
      .get<{ body: string; score: number }>("agent");
    expect(hit?.body).toBe("akko agent memory system");
    expect(typeof hit?.score).toBe("number");
    db.close();
  });

  test("persists to a file across adapter instances", () => {
    const path = join(dir, "persist.db");
    const a = new BunSqliteAdapter(path);
    a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    a.prepare("INSERT INTO t (v) VALUES (?)").run("durable");
    a.close();

    const b = new BunSqliteAdapter(path);
    const row = b.prepare("SELECT v FROM t WHERE id = 1").get<{ v: string }>();
    expect(row?.v).toBe("durable");
    b.close();
  });
});
