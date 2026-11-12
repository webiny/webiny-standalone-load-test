# The websocket connection registry queries `information_schema` four times on every call

webiny-js `6f462b597f`, standalone, Postgres 17 (2 CPUs), two API processes,
`WEBINY_SQL_SCHEMA_MANAGED` unset (as in the CI standalone job and the documented setup).

## What I did

Opened 5,000 websockets through nginx at 100 per second (2,500 per process), all authenticated as
one admin user, then created 30 ACO folders, each of which sends a message to every socket
(`scripts/ws-fanout.mjs`, `results/20261111-121049-ws-5000`).

## What happened

Postgres went to 88-91% of a core while the sockets opened, and the top statements by total time
were catalog lookups, not the registry's own reads and writes:

```
25265 ms total | 17066 calls | 1.48 ms mean | select * from information_schema.columns where table_name = $1 and column_name = $2 and table_schema = current_schema()
  386 ms total |  7415 calls | 0.05 ms mean | select * from information_schema.tables where table_name = $1 and table_schema = current_schema()
  370 ms total |  5004 calls | 0.07 ms mean | insert into "WebsocketsConnections" (...)
```

That is 25.6 s of database time for catalog checks against 0.37 s for the 5,004 inserts they guard:
about 5 ms of Postgres CPU per connection, 70 times the cost of registering it.

## Why

Every public method of `WebsocketsConnectionRegistryImpl` (`add`, `remove`, the lookups,
`listStale`) starts with `prepareTable()`, which, unless `WEBINY_SQL_SCHEMA_MANAGED=true`, runs
`setupSchema()`: `hasTable`, then `hasColumn` for `endpoint`, `lastSeen` and `owner`
(`packages/api-websockets-sql/src/WebsocketsConnectionRegistry.ts:222-305`). `applyOnce` only
avoids running the DDL twice; the checks run every time, and nothing remembers in the process
that the table is ready. Each `hasColumn` is a query on `information_schema.columns`, which costs
~1.5 ms in Postgres.

Other SQL storage in the repo does remember: `packages/api-core-sql/src/TableManager.ts` and
`packages/api-headless-cms-sql/src/features/entryTableManager/EntryTableManager.ts` keep a
per-process promise and clear it on failure.

## Effect

Connecting, disconnecting, the stale-connection sweep and every targeted send pay ~6 ms of
Postgres time before doing their work. With many admins (or a reconnect storm after a restart, see
scenario 4) this is most of the database load the websocket feature creates.
`WEBINY_SQL_SCHEMA_MANAGED=true` avoids it, but nothing in the standalone setup sets or documents
it, and with it set the table is never created at runtime.

## Seen again in a restart

In `results/*-scenario4-mixed60` (60 req/s mixed, 1,000 sockets), SIGTERM to one process made it
remove its 500 registry rows at once while the other process registered the 500 reconnects. In the
next sample Postgres was at 219% (its 2-CPU limit, from 34% before) and about 400 HTTP requests
sent to the surviving process took 1.5-6.5 s, finishing together when it passed. Closing all 1,000
sockets at the end of the run stalled requests again for 2-3 s.

## Suggested direction

Run `setupSchema()` once per process and keep the promise, as `TableManager` does (cleared if it
fails, so a later call retries).

Files: `packages/api-websockets-sql/src/WebsocketsConnectionRegistry.ts`.
