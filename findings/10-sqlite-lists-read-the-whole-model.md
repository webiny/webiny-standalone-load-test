# On SQLite, every CMS list reads, decodes, filters and sorts the whole model in JavaScript

webiny-js `6f462b597f`, standalone, SQLite (`WEBINY_DB` unset), one API process (1.5 CPU, 1 GB),
`compose.sqlite.yml`. Model `loadArticle`, 20 fields, 3,000 published entries.

## What I did

Timed single requests on the idle API, then ran the read and write ramps
(`results/20261111-134552-sqlite-read-ramp`, `results/20261111-134907-sqlite-write-ramp`).

## What happened

Idle, three tries each:

```
listLoadArticles(limit: 20, sort: [id_ASC])                          1.09 s  0.62 s  0.76 s
listLoadArticles(limit: 20, where: {category: "news"}, sort: views)  0.71 s  0.62 s  0.69 s
listLoadArticles(limit: 1)                                           0.82 s  0.78 s  0.70 s
getLoadArticle(where: { entryId })                                   0.012 s 0.009 s 0.008 s
```

`limit: 1` costs as much as `limit: 20`. Under load:

| ramp | breaks at | p95 there | first to saturate |
| --- | --- | ---: | --- |
| reads (50% list, 50% get) | 2 req/s | 1,194 ms | the API process (p50 552 ms already at 1 req/s) |
| writes (create/update) | 50 req/s | 729 ms | the API process, ~1 core |

The same reads on Postgres with two processes held 140 req/s under p95 1 s. k6's setup, which pages
through the 3,000 ids 20 at a time, timed out at 60 s on SQLite.

## Why

`listEntries` (`packages/api-headless-cms-sql/src/operations/entry/queryHelpers.ts`, from about
line 130) selects every latest (or published) row of the model, runs `fromStorage` on every field of
every entry, then filters (`filter`), sorts (`sort`) and slices in JavaScript. A list costs time in
proportion to the size of the model, whatever its `limit` or filters, and `getLoadArticle` by
anything but id goes through the same path.

`better-sqlite3` is synchronous, so while one list runs, nothing else in the process does: that is
why even the 9 ms gets have a 552 ms median at 1 req/s.

## On the hand-off's SQLite expectations

- Read from the file (`PRAGMA` on a second connection): `journal_mode = delete` (no WAL),
  `synchronous = 2` (FULL). `busy_timeout` reads 5000: `better-sqlite3` sets a 5 s timeout by
  default, so a second process on the same file would wait up to 5 s before `SQLITE_BUSY` rather
  than fail at once. Not tested with two processes.
- One connection, one process: writes queue behind each other and behind lists, as expected. No
  `SQLITE_BUSY` was seen with one process.

## Suggested direction

If SQLite is meant for more than development: push `where`, `sort` and `limit` into SQL (as
`api-headless-cms-pg` does with its search table), or at least select only the columns the
filter needs before decoding. Otherwise, say in the docs that SQLite lists scale with the model's
size and are for development and small sites. WAL mode (`PRAGMA journal_mode = WAL`) in
`createSqliteConnection.ts` would let reads proceed during a write, but would not fix the
in-memory list.

Files: `packages/api-headless-cms-sql/src/operations/entry/queryHelpers.ts`,
`packages/api-event-handler-standalone-sql/src/createSqliteConnection.ts`.
