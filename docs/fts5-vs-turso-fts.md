# SQLite FTS5 vs. Turso Full-Text Search — a comparison

*Homework notes. Turso FTS details taken from the `tursodatabase/turso` repo
(`docs/fts.md`, `docs/sql-reference/functions/fts.mdx`, `core/index_method/fts.rs`),
current as of the v0.7.0 line (July 2026). The feature is still gated behind a
`fts` build feature and is evolving.*

---

## TL;DR

- **SQLite FTS5** is a mature, stable, self-contained inverted-index extension
  built into SQLite. It stores its index in ordinary shadow tables inside the
  same database file, uses its own tokenizers (unicode61/ascii/porter/trigram),
  and exposes search through the `MATCH` operator plus auxiliary functions
  (`bm25()`, `highlight()`, `snippet()`).
- **Turso FTS** is a brand-new engine (Turso = the Rust rewrite of SQLite,
  formerly "Limbo"). Instead of writing its own inverted index, it **embeds
  [Tantivy](https://github.com/quickwit-oss/tantivy)** (a Rust Lucene-like
  search library) and persists Tantivy's segment files as blob chunks inside a
  Turso B-tree. Search is exposed through functions: `fts_match()`,
  `fts_score()`, `fts_highlight()`.
- Net: FTS5 = battle-tested, portable, feature-complete, but a comparatively
  simple ranking/query model. Turso FTS = richer search engine (Tantivy query
  parser, BM25, per-column tokenizers, weights) but young, with rough edges
  (manual segment merges, no read-your-writes, no `snippet()`, no `MATCH`
  operator yet).

---

## 1. Architecture

| | SQLite FTS5 | Turso FTS |
|---|---|---|
| Engine | Custom inverted index written for SQLite | Embeds **Tantivy** (Lucene-style, Rust) |
| Index storage | Shadow tables (`_data`, `_idx`, `_content`, `_docsize`, `_config`) in the DB file | Tantivy segment files stored as 256 KB–1 MB **blob chunks** in a backing B-tree table per index |
| Index as an object | A virtual table you `CREATE VIRTUAL TABLE ... USING fts5(...)` | A regular index: `CREATE INDEX ... ON t USING fts (cols)` |
| Reads | B-tree/segment reads through SQLite pager | Tantivy `Directory` trait re-implemented over Turso's pager (`HybridBTreeDirectory`) with hot cache + LRU chunk cache |
| Write model | In-place segment writes + automatic incremental merges | Tantivy `IndexWriter`; append-only immutable segments, batched `commit()` every 1000 docs |
| Concurrency | Follows SQLite's single-writer model | Follows Turso's model; Tantivy is internally multithreaded for indexing |

Key architectural insight: FTS5 *is* the index format; Turso FTS *delegates* to
Tantivy and just provides Tantivy a place to store its files (the B-tree) and a
translation layer between SQL and Tantivy's `QueryParser`/`TopDocs`.

---

## 2. Feature comparison

| Feature | SQLite FTS5 | Turso FTS |
|---|---|---|
| Filter / match | `WHERE t MATCH 'query'` (also `t.col MATCH`) | `WHERE fts_match(col1, col2, …, 'query')` |
| Ranking | `bm25(t)` aux function, `rank` hidden column | `fts_score(cols, 'query')` (BM25) |
| Highlighting | `highlight(t, colIdx, open, close)` | `fts_highlight(cols, open, close, 'query')` |
| Snippets (context window) | `snippet(t, …)` ✅ | ❌ not implemented |
| Boolean ops | AND / OR / NOT / NEAR | AND / OR / NOT (no NEAR) |
| Phrase search | `"exact phrase"` ✅ | `"exact phrase"` ✅ |
| Prefix search | `word*` ✅ | `word*` ✅ |
| Column filter | `col:term` ✅ | `col:term` ✅ |
| Boosting | via bm25 column weights only | `title:database^2` per-term boost + index-level `weights` |
| Field/column weights | `bm25(t, w1, w2, …)` at query time | `WITH (weights = 'title=2.0,body=1.0')` at index-create time |
| Tokenizers | unicode61 (default), ascii, porter, trigram; custom C tokenizers | default, raw, simple, whitespace, ngram; **per-column** tokenizer config |
| External / contentless content | ✅ `content=` / contentless tables | ❌ not supported |
| Segment merge | Automatic + `'merge'`/`'optimize'` commands | Manual only: `OPTIMIZE INDEX` (uses `NoMergePolicy`) |
| Transaction visibility | Immediate (read-your-writes) | Only after `COMMIT` (no read-your-writes) |
| Rollback correctness | ✅ | ✅ (FTS lives in same WAL txn as table data) |

---

## 3. Query ergonomics

**FTS5** — the index is a separate virtual table you query:

```sql
CREATE VIRTUAL TABLE articles_fts USING fts5(title, body);

SELECT rowid, highlight(articles_fts, 0, '<b>', '</b>')
FROM articles_fts
WHERE articles_fts MATCH 'database AND performance'
ORDER BY bm25(articles_fts) LIMIT 10;
```

You typically keep the FTS virtual table in sync with a base table via triggers
(or use `content=` to point at the base table).

**Turso FTS** — the index sits directly on the base table, and DML keeps it in
sync automatically:

```sql
CREATE INDEX idx_articles ON articles USING fts (title, body)
  WITH (weights = 'title=2.0,body=1.0');

SELECT id, title, fts_score(title, body, 'database') AS score
FROM articles
WHERE fts_match(title, body, 'database AND performance')
ORDER BY score DESC LIMIT 10;
```

Ergonomic differences worth noting:
- Turso avoids the "separate FTS table + triggers" ceremony; the index tracks
  the base table like an ordinary index. INSERT/UPDATE/DELETE update it
  automatically.
- FTS5's `MATCH` operator is more concise; Turso currently *requires* the
  `fts_match()` function (the `MATCH` operator is listed as not yet
  implemented, despite one doc mentioning `WHERE col MATCH`).
- BM25 score sign differs: FTS5's `bm25()` returns negative numbers (more
  negative = more relevant, so `ORDER BY bm25(t)` ascending). Turso's
  `fts_score()` docs say lower = more relevant but examples use
  `ORDER BY score DESC` — semantics here are a little inconsistent in the docs,
  so verify empirically.

---

## 4. Ranking model

Both use **BM25**. Differences:

- **FTS5:** column weights are supplied *at query time* as extra args to
  `bm25()`. Ranking is over the FTS5 index only.
- **Turso/Tantivy:** column weights are baked in at index creation
  (`weights=`), plus Tantivy's query parser supports per-term boosts
  (`term^2`). Because it's Tantivy under the hood, you inherit a more capable
  scoring/query-parsing stack (and, over time, potentially more Tantivy
  features).

---

## 5. Operational considerations

| Concern | SQLite FTS5 | Turso FTS |
|---|---|---|
| Maturity | ~10 years in production, ubiquitous | New, feature-gated, actively changing |
| Portability | Runs anywhere SQLite runs; index is in the file | Requires Turso (not upstream SQLite); tied to Turso's pager |
| Index maintenance | Mostly automatic; optional `optimize` | Requires periodic `OPTIMIZE INDEX`, especially after bulk loads (no auto-merge) |
| Write amplification | Incremental merges tuned over years | Append-only segments; many small segments after bulk insert until optimized |
| Memory | Modest, pager-driven | Tunable caches (default 64 MB hot + 128 MB chunk LRU, 64 MB Tantivy writer budget) per index |
| Read-your-writes | Yes | No — changes invisible until COMMIT (can surprise app logic) |
| Binary size / deps | Tiny, part of SQLite core | Pulls in Tantivy and its dependency tree |

---

## 6. When to choose which

**Choose SQLite FTS5 if you:**
- need a stable, portable, well-documented solution today;
- want `snippet()`, `NEAR`, contentless/external-content tables;
- rely on immediate read-your-writes within a transaction;
- are running on plain SQLite (libSQL, better-sqlite3, mobile, etc.).

**Choose Turso FTS if you:**
- are already on Turso and want search that tracks a base table without trigger
  boilerplate;
- want per-column tokenizers, ngram/substring/autocomplete matching, index-time
  weights, and Tantivy's richer query parser / boosting;
- can tolerate a young feature: manual `OPTIMIZE INDEX`, no snippets, no
  read-your-writes, `fts_match()` instead of `MATCH`;
- value the Tantivy roadmap (more advanced relevance/query features over time).

---

## 7. Gaps / caveats to validate before committing

- Turso FTS is **behind a build feature (`fts`)** and moving fast — pin a
  version and re-check the docs.
- No automatic segment merging → schedule `OPTIMIZE INDEX` after bulk writes.
- No read-your-writes inside a transaction can break "insert then search"
  patterns.
- No `snippet()` — only `fts_highlight()` (whole-field, not a context window).
- BM25 score direction is documented ambiguously — confirm ordering with a real
  dataset.
- No external/contentless content model yet — the FTS index stores its own copy
  of the text in Tantivy segments (storage overhead vs. FTS5 `content=`).
- Benchmark both on your workload: FTS5 is a lean custom index; Tantivy is a
  heavier but more capable engine, and Turso adds a B-tree-backed
  `Directory` + caches whose performance profile differs from mmap'd Tantivy.

---

### Sources
- Turso repo: `docs/fts.md`, `docs/sql-reference/functions/fts.mdx`,
  `core/index_method/fts.rs`, `core/benches/fts_benchmark.rs`
- SQLite docs: <https://www.sqlite.org/fts5.html>
- Tantivy: <https://github.com/quickwit-oss/tantivy>
