# CLOSED: CMS read lists stalled for 1-2 s, every ~6.5 s: the Mac host, not Webiny

Not an issue to file. Kept as the record of what host contention looked like, so it is not
chased again.

**Resolution.** On EC2, with the stack on a host of its own and each container pinned to its own
cores (REPORT.md "EC2 runs"), none of 12 ramps stalled below its breaking point. p95 at 40 req/s
was 19-49 ms on reads and 25-29 ms on mixed, where the Mac had 1-3 s bursts. Each build broke
within one ramp step of itself across rounds; on the Mac the same build broke anywhere from 50 to
150 req/s. Docker Desktop's `cpus` limits cap a container but reserve nothing for it, and the Mac
was at load average 31.8 on 10 CPUs. The likely mechanism, not measured directly: the API
processes lost the CPU while holding a list's open transaction, which shows up below as Postgres
backends `idle in transaction`, waiting on the client.

What follows is the investigation as it stood before the EC2 runs.

webiny-js `6f462b597f`, standalone, Postgres 17 (2 CPUs), two API processes, pool 10 per process.

**Update: writes are not needed.** The first read-only ramp below ran clean to 100 req/s, but four
later read-only ramps on a reset database stalled the same way from 40-60 req/s, on the source
build and on `6.6.0-alpha.10` alike (`20261111-172700-read-ramp-clean`,
`20261111-173513-read-ramp-clean-alpha`, `20261111-174257-read-ramp-clean-source`). In
`20261111-173513-read-ramp-clean-alpha`'s `pg-waits.txt`, during the 16:39:23-31 stall (requests
up to 3.2 s), 319 of 543 samples are backends `idle in transaction` on `Client:ClientRead`,
holding a list's transaction open 30-160 ms between `BEGIN`, the three `SET LOCAL enable_*`
statements and the query. API CPU per read did not change (16-18 ms), and event-loop lag peaked
at ~120 ms. The host was at load average 31.8 on 10 CPUs during those runs; whether the stalls
follow host load is the next thing to check, now that `scripts/run.sh` records it.

## What I did

Mixed ramp, 90% reads / 10% writes (`k6/ramp.js`, `SCENARIO=mixed`), from the 3,000-entry baseline
(`scripts/reset-db.sh`). Reads: `listLoadArticles` and `getLoadArticle` on `/cms/read`; writes:
`createLoadArticle` / `updateLoadArticle` on `/cms/manage`.

## What happened

Read-only traffic stays fast to 100 req/s (p95 175 ms). With 10% writes, p95 jumps at much lower
rates, and unevenly from run to run:

| run | 20 req/s | 40 req/s | 60 req/s |
| --- | ---: | ---: | ---: |
| read-only ramp (`20261111-104952-read-ramp`) | 30 | 33 | 41 |
| mixed (`20261111-113021-mixed-ramp`) | 43 | 443 | 444 |
| mixed (`20261111-114103-mixed-ramp-locklog`) | 32 | 57 | 438 |
| mixed, pool 30 (`20261111-114635-mixed-ramp-pool30`) | 40 | 225 | 194 |
| mixed (`20261111-115101-mixed-ramp-canary`) | 64 | 269 | 647 |

(p95 in ms.) The slow requests come in bursts. In `20261111-115101-mixed-ramp-canary` at 60 req/s,
bursts of slow `list` requests started at 10:53:00, :06.5, :13.5, :20.0, :26.5, :33.0, :39.4, :46.0,
:52.3, :58.5: about every 6.5 s. Requests that start inside a burst all finish together 1-2 s
later; most are `list`, the larger bursts also catch `get`, `create` and `update`.

## Ruled out

- **k6**: nginx's `$request_time` shows the same slow requests, with `$upstream_response_time`
  equal to it, split evenly over both API processes (5 and 5 over 0.8 s in one run).
- **Postgres being slow**: a separate psql session timing `select clock_timestamp()` every 200 ms
  through the whole run peaked at 38 ms. With `log_lock_waits` (deadlock_timeout 200 ms) and
  `log_min_duration_statement = 300`, Postgres logged nothing.
- **Pool size**: pool 30 instead of 10 still stalls.
- **Event loop**: in the first stall of `20261111-113021-mixed-ramp`, lag max was 4.6 / 6 ms on the
  two processes; lag rises only after the backlog arrives.
- **Data size**: happens on the 3,000-entry baseline.
- **Background tasks**: none are created by these writes.

## What is seen during a stall

0.5 s samples of `pg_stat_activity` (`results/20261111-114103-mixed-ramp-locklog/pg-waits.txt`):
connections "idle in transaction" waiting on the client (Node) for up to 146 ms in the middle of a
write (`delete from webiny_cms_search ...`, `SELECT index_mode FROM webiny_cms_scopes ...`,
`SET LOCAL enable_seqscan = off ...`), new backends being opened, and one `COMMIT` waiting 205 ms
on `IO:WalSync`. So requests spend the time inside the API processes waiting on something that is
not CPU and not Postgres.

## Candidates not checked yet

In-process waits that a lagging but not blocked event loop would show: knex pool acquisition
while connections are held across awaits in a transaction, single-flight promises (the estimate
cache in `packages/api-headless-cms-pg/src/features/search/estimateCache.ts` makes concurrent
callers share one computation), the per-process scope cache (`ScopeRegistry`, mode TTL 30 s) and
the index-mode advisory lock writes take (`MODE_LOCK_SQL`).

Next step: run with `DEBUG=knex:pool` or a pool-wait timer, and a timing log around
`cachedEstimate` and `ScopeRegistry.get`, at 60 req/s mixed.
