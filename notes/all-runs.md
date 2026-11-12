# Webiny standalone under load: results

## TL;DR

- **Capacity.** Two API processes on Postgres (1.5 CPUs and 1 GB each) handle about 160-180
  reads/s, 115 writes/s, or 150-190 req/s of 90/10 mixed traffic before p95 goes over 1 s. Measured
  on a dedicated EC2 host.
- **What runs out first.** The API processes' CPU: each read costs 12-14 ms on the Node main
  thread. On writes Postgres is close behind (88-96%).
- **One outage.** 300 scheduled actions due at the same moment get both API processes OOM-killed
  within 2 s (finding 06). With automatic restarts 2.25% of requests failed and every action still
  ran exactly once; without restarts the API stayed down.
- **What held.** Scheduled actions ran exactly once; every background task finished; a SIGTERM under
  load lost 0 of 23,821 requests; websockets reconnected; 5,000 sockets with no message lost; no
  memory growth in 60 minutes.
- **Published alpha.** `6.6.0-alpha.10` performs the same as the source build (level or one ramp
  step better).
- **Next.** Findings in `findings/` are issue drafts, none filed. Fix 06 first: it is the only one
  that takes the API down.

## Summary

Two API processes on Postgres, 1.5 CPUs and 1 GB each, Postgres on 2 CPUs. The numbers below are
from EC2, where the stack had a host of its own (section "EC2 runs"). The local runs after that
section are kept, but their ramp numbers moved with whatever else the Mac was doing: the same build
broke at 150 req/s in one run and at 50 in another.

Where each workload stopped coping (p95 > 1 s), and what ran out first:

| workload | breaks at | first to saturate | finding |
| --- | --- | --- | --- |
| CMS reads (list + get) | 160-180 req/s | the API processes' Node main thread (~12-14 ms of CPU per read) | - |
| CMS writes (create + update) | ~115 req/s | the API processes, with Postgres close behind (88-96%) | 03 |
| 90% reads / 10% writes | 150-190 req/s | the API processes and Postgres together | - |
| 300 scheduled actions due at once | at 110 req/s of mixed traffic | memory: both API processes OOM-killed at 1 GB within 2 s of the due time | 06 |
| websockets | not reached at 5,000 sockets (0 lost) | catalog queries on every registry call load Postgres; delivery p95 690 ms at 5,000 | 04 |
| SQLite, one process (development only) | reads 2 req/s, writes 50 req/s | the API process: every list reads the whole model in JS | 10 |

What held: scheduled actions ran exactly once across both processes (300/300, none twice),
including after both processes were killed and restarted; every background task finished; a
SIGTERM under load lost 0 of 23,821 requests on EC2 (2 of 17,853 locally, finding 08); websockets
closed with 1012 and all reconnected; a running bulk task was picked up by the other process; no
memory growth in 60 minutes at half load (RSS 307 to 313 MB); no keep-alive 502s.

The published `6.6.0-alpha.10` matched the source build `6f462b597f` on every run, and was the
same or one ramp step better in each of the six paired ramps on EC2 (one step ahead in four, level
in two).

Findings (issue drafts, nothing filed): `findings/`. 01 is from the setup's first session.

| # | finding |
| --- | --- |
| 01 | One extension with a missing license-gated dependency fails every CMS request |
| 02 | The background tasks API checks a permission the Admin never grants |
| 03 | Every CMS write plans a webhook search costing Postgres 5-9 ms, with no webhooks |
| 04 | The websocket registry queries `information_schema` four times on every call |
| 05 | CLOSED: list stalls every ~6.5 s were the Mac host, not Webiny |
| 06 | 300 scheduled actions due together get the API processes OOM-killed |
| 07 | CMS bulk actions spend almost all their time in a fixed 120 s wait |
| 08 | SIGTERM resets requests that have just arrived (502) |
| 09 | `createFolder` ignores the `id` its input documents |
| 10 | On SQLite every list reads the whole model in JavaScript |

## EC2 runs

`ec2/README.md` has the setup: a c7g.2xlarge (8 Graviton cores, no SMT) running the same compose
stack with the same `cpus` and memory limits, each container pinned to cores of its own
(`compose.ec2.yml`), and k6 on a separate c7g.xlarge in the same subnet. Host load average stayed
between 0.9 and 3.9 on 8 cores, against 31.8 on 10 on the Mac during its afternoon runs. Ramps ran
through `scripts/ab.sh`: source build and alpha in turn, each on its own database reset from its
3,000-entry baseline. Same `ramp.js` steps as locally.

### What was deployed

Two EC2 instances. Every Webiny part runs as a Docker container on the first one (`sut`); the
second one (`loadgen`) runs only k6. Postgres, Valkey and the two API processes are containers on
the same host, not hosts of their own.

```
 VPC 10.88.0.0/16 (created for the test, deleted afterwards)

 ┌──────────────────────────────┐   HTTP + websockets to :3002
 │ EC2 "loadgen"  c7g.xlarge    │ ─────────────────────────────┐
 │                              │                              │
 │  [k6 container]              │                              │
 │  sends the req/s for ramps   │                              │
 │  and soak                    │                              │
 └──────────────────────────────┘                              │
                                                               ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ EC2 "sut"  c7g.2xlarge, 8 cores (0-7), Docker Compose                   │
 │                                                                         │
 │                      ┌───────────────────────────┐                      │
 │                      │ nginx        core 6       │  port 3002           │
 │                      │ round-robin load balancer │                      │
 │                      └─────────────┬─────────────┘                      │
 │                     ┌──────────────┴──────────────┐                     │
 │                     ▼                             ▼                     │
 │      ┌──────────────────────────┐   ┌──────────────────────────┐        │
 │      │ api-1      cores 2-3     │   │ api-2      cores 4-5     │        │
 │      │ one Node process         │   │ one Node process         │        │
 │      │ 1.5 CPU, 1 GB limit      │   │ 1.5 CPU, 1 GB limit      │        │
 │      └──┬────────────────┬──────┘   └──────┬────────────────┬──┘        │
 │         │ SQL, 10 conns  │ pub/sub         │ pub/sub        │ SQL       │
 │         ▼                ▼                 ▼                ▼           │
 │  ┌─────────────────────────────┐   ┌──────────────────────────┐         │
 │  │ postgres    cores 0-1       │   │ valkey       core 6      │         │
 │  │ 2 CPU, 2 GB limit           │   │ 0.5 CPU, 256 MB          │         │
 │  │ all data, scheduler claims, │   │ forwards websocket       │         │
 │  │ websocket registry          │   │ messages between api-1   │         │
 │  └─────────────────────────────┘   │ and api-2                │         │
 │                                    └──────────────────────────┘         │
 │                                                                         │
 │  [admin]  core 6, static Admin files on :3001, not used in the tests    │
 │  [client] core 7, Node scripts for scenarios 3 and 4: scheduling,       │
 │           background tasks, websocket clients                           │
 └─────────────────────────────────────────────────────────────────────────┘
```

- **nginx** is the only way in (port 3002) and hands requests to api-1 and api-2 in turn. It is a
  container, not an AWS load balancer.
- **api-1, api-2** run the same Webiny API build, one Node process per container. Standalone
  scales by running more copies of that process. "The Node main thread is full" in this report
  means one of these processes.
- **Postgres** is shared by both processes and holds everything: CMS entries, the scheduler's
  claims (how "exactly once" holds across two processes) and the websocket registry.
- **Valkey** carries websocket messages from one process to the other: when a request on api-1
  causes an event for a socket open on api-2, api-1 publishes it to Valkey and api-2 sends it.
- Each container is pinned to cores of its own (`compose.ec2.yml`), so they do not take CPU from
  one another and runs repeat.

The local runs used the same containers under Docker Desktop on the Mac, with k6 as one more
container on the same machine and no core pinning.

### Ramps

Last step with p95 under 1 s, and its p95; the next step broke in every run.

| ramp | round | source `6f462b597f` | alpha.10 |
| --- | --- | --- | --- |
| read | 1 | 160 req/s, 122 ms | 180 req/s, 124 ms |
| read | 2 | 180 req/s, 150 ms | 180 req/s, 123 ms |
| read | 3 | 160 req/s, 122 ms | 180 req/s, 123 ms |
| mixed | 1 | 160 req/s, 222 ms | 180 req/s, 160 ms |
| mixed | 2 | 140 req/s, 108 ms | 160 req/s, 142 ms |
| write | 1 | 110 req/s, 183 ms | 110 req/s, 121 ms |

Each build lands within one step of itself across rounds, so these numbers can be compared. No run
stalled below its breaking point: p95 at 40 req/s was 19-49 ms on reads and 25-29 ms on mixed. On
the Mac the same steps had 1-3 s bursts (finding 05, now closed).

At the breaking point both API processes were at 95-100% of one core, which for Node is the main
thread full. API CPU per read (`scripts/cpu-per-req.mjs`): alpha 11.7-13.7 ms, source 11.9-16.5 ms.
In the mixed ramp Postgres reached 99% as well; in the write ramp 88-96%. Postgres statement costs
match the local runs (search delete ~1.0 ms, search insert ~1.7 ms per write).

Run folders: `20261111-173557-read-ramp-source-1` to `20261111-192434-write-ramp-alpha-1`
(names end in `-<build>-<round>`).

### Scenario 3 at 110 req/s: both processes OOM-killed

`scripts/scenario3.sh 110 300 200` on alpha.10, mixed traffic at 110 req/s (70% of where mixed
breaks), 300 publishes due at the same moment, 200 `testingRun` tasks.

First run (`20261111-193819-scenario3-mixed110`), containers without a restart policy: the kernel
killed both API processes 1-2 s after the due time (`Memory cgroup out of memory: Killed process
... anon-rss:1023804kB`). They stayed down; 19,350 of 38,602 requests got 502 and none of the 300
actions ran.

Second run (`20261111-205110-scenario3-mixed110`), with `restart: unless-stopped` on the API
containers, as a process manager would do in production:

| time (UTC) | |
| --- | --- |
| 20:54:07 | RSS 370 MB (api-1), 359 MB (api-2) |
| 20:54:10.467 | 300 actions due |
| 20:54:11, 20:54:12 | both processes OOM-killed (over 1,024 MB) |
| 20:54:13-14 | both restarted by Docker (api-1's first log line 20:54:13.93); boot recovery starts |
| 20:54:13.7-20:54:22.0 | all 300 run, 155 on api-2 and 145 on api-1, none twice |
| 20:54:22.06 | recovery done: api-1 re-armed 294 actions, api-2 300 |
| 20:54:28 | RSS 307 MB and 308 MB; event-loop lag max under 50 ms |

Both processes re-armed nearly every action; the claims let each run once.

1,337 of 59,305 requests (2.25%) got 502 while the processes were down. All 200 tasks `success`.

The same 300 actions took each process past 1 GB in under 4 s when they fired on time, and cost
almost nothing when boot recovery ran them. So the memory goes into the path that fires due actions
live (finding 06: a worker thread per action), not into the actions. The claims did their job:
exactly once held across two kills and a recovery on both processes.

### Scenario 4 at 80 req/s

`20261111-210119-scenario4-mixed80`, alpha.10. 0 of 23,821 requests failed (no 502). The 500
sockets on the stopped process closed with 1012 and all reconnected (p95 2.3 s); no message was
lost. The bulk publish of 2,000 drafts was handed over (`resumed 2`, then `resumed 9`) and all
2,000 were published 2 min 33 s after the SIGTERM. The surviving process still stalled: p99 3.9 s,
max 6.2 s, about the same as on the Mac (p99 4.0 s, max 6.6 s), so that stall is real. 500
reconnects at four catalog queries each (finding 04) is the likely cause.

### Soak, 60 minutes at 80 req/s

`20261111-194456-soak-mixed80-60min`, alpha.10, mixed traffic at half the mixed breaking point.
287,999 requests, 0 failed; p50 17 ms, p95 44 ms, p99 74 ms, max 198 ms.

| 10 min from | api-1 RSS max | api-2 RSS max | lag p99 max, api-1 / api-2 |
| --- | ---: | ---: | ---: |
| 19:40 | 307 MB | 308 MB | 10.1 / 11.9 ms |
| 20:00 | 312 | 310 | 9.9 / 11.0 |
| 20:20 | 312 | 312 | 10.0 / 11.1 |
| 20:40 | 313 | 312 | 10.0 / 11.5 |

No leak: 6 MB in an hour, heap flat at 66-82 MB.

## Setup (local runs)

Every local run below: webiny-js `6f462b597f` (`next`), unlicensed build
(`builds/6f462b597f-postgres-unlicensed`), Postgres 17, Valkey 8, two API processes behind
round-robin nginx, k6 in its own container. Docker Desktop VM: 10 CPUs, 7.6 GiB.

| container | CPUs | memory |
| --- | --- | --- |
| postgres | 2 | 2 GB |
| valkey | 0.5 | 256 MB |
| api-1, api-2 | 1.5 each | 1 GB each |
| nginx | 0.5 | 128 MB |
| k6 / client | 2 | 1 GB |

Except the SQLite baseline at the end, which has its own stack (`compose.sqlite.yml`).

`WEBINY_PG_POOL_MAX` unset (10 connections per process). nginx `worker_connections 16384` (raised
from 4096 during scenario 2). Data: model `loadArticle`, 20 fields, 3,000 published entries
(`scripts/seed.mjs`), restored from a template database before each run (`scripts/reset-db.sh`)
from the mixed ramp on; the read and write ramps ran before the template existed, on the freshly
seeded 3,000.

The load-test API key has `{"name": "tasks"}` added by hand (finding 02); websocket clients log in
as the admin user, since a socket opened with an API key is registered as anonymous.

A ramp step lasts 60 s; its numbers are from the last 45 s (the first 15 s let the previous
step's backlog drain). The run stops after the first step with p95 > 1 s or > 1% failed requests,
where a GraphQL error in a 200 response counts as failed.

## Scenario 1: ramps

### CMS read API

`results/20261111-104952-read-ramp`. 50% `listLoadArticles` (limit 20, filter by category,
sometimes rating, one of four sorts), 50% `getLoadArticle` by entry id.

| step | req/s | p50 ms | p95 ms | p99 ms | failed |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 20 | 18 | 30 | 40 | 0 |
| 2 | 40 | 18 | 33 | 49 | 0 |
| 3 | 60 | 18 | 41 | 96 | 0 |
| 4 | 80 | 18 | 69 | 211 | 0 |
| 5 | 100 | 19 | 175 | 375 | 0 |
| 6 | 120 | 24 | 298 | 621 | 0 |
| 7 | 139 | 26 | 562 | 1139 | 0 |
| 8 | 153 (of 160) | 94 | 1245 | 1355 | 0 |

**Breaks at about 150 req/s. First to saturate: the API processes' CPU.** Each reached 115-134%
of one core (of 1.5 allowed): the Node main thread is full, about 75 reads/s per process, roughly
13 ms of CPU per read. Postgres peaked at 73% of one core of its 2; the pools were never short
(20 connections open across both processes, 1-2 active at a time). Event-loop lag p99 went from
5 ms to 40 ms; RSS from 310 to 418 MB. `list` is the expensive half: p95 862 ms vs 205 ms for
`get` at step 7.

### CMS manage API writes

`results/20261111-105803-write-ramp`. 50% `createLoadArticle`, 50% `updateLoadArticle` on a draft
the same VU created. The model grows by one entry per create, from 3,000 to about 19,000 by the
end of the run.

| step | req/s | p50 ms | p95 ms | p99 ms | failed |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 10 | 21 | 34 | 43 | 0 |
| 2 | 20 | 21 | 35 | 55 | 0 |
| 3 | 30 | 20 | 29 | 38 | 0 |
| 4 | 40 | 21 | 45 | 139 | 0 |
| 5 | 50 | 34 | 299 | 448 | 0 |
| 6 | 60 | 29 | 215 | 478 | 0 |
| 7 | 70 | 25 | 143 | 303 | 0 |
| 8 | 80 | 25 | 158 | 426 | 0 |
| 9 | 90 | 32 | 413 | 651 | 0 |
| 10 | 100 | 57 | 652 | 921 | 0 |
| 11 | 101 (of 110) | 48 | 1226 | 1554 | 0 |

**Breaks at about 100 req/s. First to saturate: Postgres CPU** (205-210% of its 2 cores), with
each API process near one core. With `track_planning` on
(`results/20261111-110940-write-hold70-planning`, 3 min at 70 writes/s), Postgres spent 120.6 s
planning and 62.9 s executing; three quarters of the planning is one webhook lookup per write
(finding 03). That 3-minute hold at 70/s also had a much worse tail than the ramp's 70/s step
(p95 764 ms, p99 3.5 s, max 5.9 s) on a model that had grown to ~19,000 entries.

### Mixed, 90% reads / 10% writes

`results/20261111-113021-mixed-ramp`, from the 3,000-entry baseline.

| step | req/s | p50 ms | p95 ms | p99 ms | failed |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 20 | 20 | 43 | 114 | 0 |
| 2 | 40 | 23 | 443 | 777 | 0 |
| 3 | 60 | 20 | 444 | 912 | 0 |
| 4 | 80 | 19 | 109 | 336 | 0 |
| 5 | 100 | 20 | 697 | 1292 | 0 |
| 6 | 120 | 33 | 718 | 1075 | 0 |
| 7 | 68 (of 140) | 371 | 1575 | 1657 | 0 |

**Breaks at about 130 req/s, where throughput collapses** (68 of 140 req/s delivered, 184 VUs
waiting). Long before that, from 40 req/s, `list` requests stall for 1-2 s in bursts about every
6.5 s, on both processes at once, while neither the API nor Postgres is busy. Cause not found;
what is ruled out and what is left is in finding 05. Four more runs of the first three steps vary
a lot (p95 at 40 req/s: 57, 225, 269, 443 ms), so treat any single mixed number with care.

A first mixed run on a model grown to 27,000 entries by the write ramp is kept as
`results/20261111-111426-mixed-ramp-INVALID-27k-entries`; it is not comparable.

## Scenario 2: websockets

`scripts/ws-fanout.mjs`: sockets opened through nginx at a fixed rate, all as one admin user (an
API key is registered as anonymous, so nothing can be sent to it), then one ACO folder created per
interval; each create sends `aco.folder.created` to every socket of the user, to the other
process's sockets through Valkey.

| run | sockets (per process) | messages | delivered | lost | latency p50 / p95 / max ms | open p95 ms |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| `20261111-120033-ws-1000` | 1,000 (500 / 500) | 60 | 60,000 | 0 | 57 / 91 / 167 | 124 |
| `20261111-121049-ws-5000` | 5,000 (2,500 / 2,500) | 30 | 150,000 | 0 | 176 / 690 / 1,163 | 179 |

- Nothing was lost; no socket closed during a 70-90 s idle hold (past nginx's 60 s
  `proxy_read_timeout`, so the server's pings keep them open).
- The broadcast is sent inside the request that causes it: `createFolder` took 63 ms (median) with
  1,000 sockets and 197 ms with 5,000, tracking delivery latency. Each process sends to its sockets
  one after another (`sendToLocalSockets`).
- Opening sockets cost little API CPU (under 50% of a core at 100/s) but most of the Postgres load
  was catalog queries: 4 per registry call (finding 04).
- The first 5,000-socket run stopped at 1,964 sockets; that was this setup's nginx
  (`worker_connections 4096`, two per proxied socket), now 16384. A first 1,000-socket run put 998
  sockets on one process because nginx had marked the other down while both booted; the reset
  script now waits for each process directly. Both runs are kept with `-INVALID-` in the name.

## Scenario 3: scheduler and background tasks under load

`scripts/scenario3.sh 90 300 200` (`results/20261111-121658-scenario3-mixed90`): mixed traffic at
90 req/s for 9 minutes; after a minute, 300 publishes scheduled for the same moment two minutes
later, and 200 `testingRun` background tasks.

- **Exactly once: yes.** 300 actions, 300 claims, none run twice
  (`scripts/claims.sh`), all 300 entries published, none pending. All 200 tasks `success`,
  1 iteration each, trigger to finish p50 566 ms, p95 6 s.
- **But the due moment froze both API processes** (finding 06): event-loop blocked up to 2.4 s with
  traffic and 16.9 s in a second burst without traffic, requests at p50 17 s for about 90 s, RSS up
  by 370-470 MB per process and not given back (api-1 at 993 MB of 1 GB after the second burst).
  Every action ran on one process, 14 s after it was due.

## Scenario 4: rolling restart

`scripts/scenario4.sh 60` (`results/20261111-123017-scenario4-mixed60`): mixed traffic at
60 req/s for 5 minutes, 1,000 websockets that reconnect when closed (`scripts/ws-restart.mjs`,
one broadcast a second), and a bulk Publish of 2,000 drafts running as a background task. The
process holding the task's claim (api-2) got SIGTERM at 11:31:18, exited 6 s later and was
started again a second after that.

- **In-flight requests: 17,851 of 17,853 finished with 200.** The two 502s arrived at api-2 in the
  same 50 ms as the signal (finding 08).
- **But the survivor stalled.** About 400 requests sent to api-1 after the signal took 1.5-6.5 s,
  finishing together at 11:31:24-30; Postgres hit 219% (its limit) while api-2 dropped its 500
  registry rows and api-1 registered the 500 reconnects, each with four catalog queries
  (finding 04). Run p95 719 ms, p99 4.0 s, max 6.6 s.
- **Websockets: as designed.** Exactly the 500 sockets on api-2 closed, all with 1012; all 500
  reconnected (p50 1.9 s, max 2.8 s, including the client's 0.5-1 s backoff), no reopen failed. One
  broadcast, sent at the moment of the signal, reached 500 of 524 open sockets; the other 196
  reached every socket. Afterwards all 1,000 sockets sat on api-1: nothing moves them back, so a
  rolling restart of both processes leaves them all on the last one restarted.
- **Background task: handed over.** All 2,000 entries were published; api-2's recovery after its
  restart logged "Recovered background tasks that no process held" (`resumed 2`, then `resumed 9`).
  The same bulk action without a restart takes 2 min 18 s, of which ~2 minutes is a fixed wait
  (finding 07).

## Scenario 5: soak

`results/20261111-124613-soak-mixed65-30min`: mixed traffic at 65 req/s (half of where mixed
breaks) for 30 minutes, from the baseline. The model grew from 3,000 to 8,721 entries.

116,942 requests, 0 failed; p50 20 ms, p95 101 ms, p99 461 ms, max 2.5 s.

| 5 min from | api-1 RSS max | api-1 heap max | api-2 RSS max | api-2 heap max | lag p99, api-1 / api-2 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 11:45 | 276 MB | 78 MB | 338 MB | 74 MB | 7.8 / 7.7 ms |
| 11:50 | 279 | 78 | 347 | 81 | 7.2 / 7.2 |
| 11:55 | 288 | 79 | 358 | 76 | 8.3 / 8.5 |
| 12:00 | 302 | 89 | 363 | 87 | 5.9 / 5.4 |
| 12:05 | 312 | 77 | 373 | 86 | 5.8 / 6.1 |
| 12:10 | 314 | 76 | 384 | 81 | 4.8 / 4.7 |
| 12:15 | 316 | 81 | 384 | 83 | 9.3 / 8.5 |

(lag p99: median of the 5 s windows.) **No leak seen.** The JS heap stays flat; RSS rises
40-46 MB in the first 20 minutes and is flat for the last 10. 30 minutes is short to rule out a
slow native leak; a 60-minute run would settle it.

## Keep-alive timeout (hand-off weak spot)

`k6/keepalive.js`: one client sending a read every ~2.5 s, so each upstream connection sits idle
for ~5 s, Node's `keepAliveTimeout`. Three runs, 476 requests, **0 non-200**:

| run | nginx | requests | non-200 |
| --- | --- | ---: | ---: |
| `20261111-131701-keepalive-base` | `nginx.conf` (CI's: `Connection: close` upstream) | 143 | 0 |
| `20261111-132311-keepalive-reuse` | `nginx-keepalive.conf` (`Connection ""`, connections reused) | 143 | 0 |
| `20261111-133023-keepalive-reuse-sweep` | same, idle gap stepped across 5 s in 20 ms steps | 190 | 0 |

With reuse, nginx did keep upstream connections (2 established after a burst) and they were gone
7 s later: Node closed them at 5 s and nginx noticed before reusing them. **Not reproduced** with
this nginx; a proxy that does not watch idle upstream connections could still hit it. Note the CI
config never reuses upstream connections at all, so `keepalive 64` in it does nothing.

## SQLite baseline: one process (development only)

SQLite is not offered for production; Postgres is the production setup. This run is kept as a
reference for local development, and finding 10 matters for that use.


`compose.sqlite.yml`, build `builds/6f462b597f-sqlite-unlicensed`, one API process (1.5 CPU,
1 GB), installed with `installSystem` over GraphQL, 3,000 entries seeded (87 s, against 54 s on
Postgres with two processes).

| ramp | breaks at | p95 there | notes |
| --- | --- | ---: | --- |
| reads (`20261111-134552-sqlite-read-ramp`) | 2 req/s | 1,194 ms | p95 956 ms already at 1 req/s; a list takes 0.6-1.1 s idle, `limit: 1` included |
| writes (`20261111-134907-sqlite-write-ramp`) | 50 req/s | 729 ms | 40 req/s fine (p95 76 ms); API at ~1 core |

Every list reads and decodes every entry of the model and filters, sorts and pages in JavaScript,
on a synchronous driver (finding 10). `journal_mode` is `delete` (no WAL) as the hand-off expected;
`busy_timeout` is 5,000 ms (better-sqlite3's default), not unset. Two processes on one SQLite file
were not tested.

## The hand-off's weak spots

| weak spot | verdict | evidence |
| --- | --- | --- |
| SQLite: one connection, default pragmas | confirmed, but the bigger cost is elsewhere | no WAL; busy_timeout 5 s by driver default; lists read the whole model (finding 10) |
| Postgres pool, 10 per process | ruled out as the limit | reads: 20 connections open, 1-2 active at saturation; mixed with pool 30 still stalls |
| Node keepAliveTimeout 5 s behind a proxy | not reproduced | 0 of 476 requests at ~5 s idle, with and without upstream reuse |
| Error responses without CORS headers | known; did not get in the way | - |
| Scheduler recovery every 60 s | the recovery itself was cheap here; the firing is not | 1 tenant: recovery not visible; 300 due actions freeze both processes (finding 06) |
| `/wb/redirects` cached a year | known; not exercised | - |

## Published alpha: 6.6.0-alpha.10

A project made with `create-webiny-project` at `6.6.0-alpha.10`, plus
`@webiny/api-event-handler-standalone-pg`, `@webiny/api-headless-cms-pg` and `@webiny/api-aco-pg`
at the same version, built with `webiny-standalone` into `builds/6.6.0-alpha.10-postgres`. Same
stack and limits as above, its own database (`webiny_alpha`, template `webiny_alpha_baseline`,
3,000 seeded entries).

**Verdict: alpha.10 matches the source build.** Locally, everything that does not depend on how
busy the host is matched; the ramp breaking points did not, and they did not match between two runs
of the same build either (below). On EC2 they do, and alpha.10 was the same or one step better in
every paired ramp (section "EC2 runs").

| check | source `6f462b597f` | alpha.10 |
| --- | --- | --- |
| API CPU per read at 60 / 100 req/s (`scripts/cpu-per-req.mjs`) | 17.1 / 17.6 ms | 18.1 / 16.9 ms |
| Postgres statements, read ramp | `EXPLAIN` estimate 1.36 ms, entries by id 0.21 ms | 1.68 ms, 0.24 ms |
| Postgres statements, write ramp | search delete 0.97 ms, insert 1.51 ms | 0.78 ms, 1.37 ms |
| scenario 3: 300 scheduled publishes | 300 run, none twice | 300 run, none twice (`20261111-162843-scenario3-mixed90`) |
| scenario 3: 200 `testingRun` tasks | all `success`, p95 6 s | all `success`, p95 6.0 s |
| scenario 3: traffic at the due moment | frozen (finding 06) | frozen: p99 16.2 s, max 27.5 s |
| websockets, 1,000 (`20261111-163834-ws-1000`) | 0 lost, p95 91 ms | 0 lost of 60,000, p95 87 ms |
| scenario 4 (`20261111-164243-scenario4-mixed60`): 502s on SIGTERM | 2 | 0 |
| scenario 4: sockets on the stopped process | 500 closed 1012, all reconnected | 499 closed 1012, all reconnected (p95 2.1 s) |
| scenario 4: bulk publish of 2,000 | handed over, all published | handed over (`resumed 1`, then `resumed 10`), all published |

The scenario 4 script did not notice the 2,000 publishes finishing (`bulk.txt` has no
`published=` lines), so it waited its full 10 minutes; the count at the end is 2,000, the time it
took is not known.

### Ramp breaking points move with the host

| run | build | database | reads break at |
| --- | --- | --- | --- |
| `20261111-104952-read-ramp` | source | fresh seed | ~150 req/s |
| `20261111-165755-read-ramp` | alpha.10 | after scenarios 3, 4 (search table 179 MB vs 40 MB) | ~110 req/s |
| `20261111-172700-read-ramp-clean` | alpha.10 | reset | ~70 req/s |
| `20261111-173513-read-ramp-clean-alpha` | alpha.10 | reset | ~130 req/s |
| `20261111-174257-read-ramp-clean-source` | source | reset | ~50 req/s |

The same source build on the same 3,000 entries broke at 150 req/s in the morning and at 50 req/s
in the afternoon. Every break was the finding 05 stall (1-3 s bursts, Postgres backends `idle in
transaction` waiting on the API, event-loop lag max ~120 ms), not CPU running out: API CPU per
read stayed at 16-18 ms. During the afternoon runs the host's load average was 31.8 on 10 CPUs
(other projects' dev servers, test runs and a browser); Docker's `cpus` limits cap a container but
reserve nothing for it. The morning's host load was not recorded. `scripts/run.sh` now writes the
host's 1-minute load average into `stats.csv` (row `host`) every 5 s.

Alpha.10 write ramp (`20261111-170323-write-ramp`) broke at ~90 req/s (source ~100); mixed
(`20261111-171645-mixed-ramp`, run after the write ramp without a reset) at 40-60 req/s. Neither
is comparable to the source numbers for the reason above.

So the local ramp numbers are the best this machine gave, not a property of the build. The EC2
runs, on a host that ran nothing else, are the ones to quote.

`scripts/run.sh` and `scripts/pg-waits.sh` sampled `pg_stat_activity` for a database named
`webiny` only, so `pg.csv` is empty for every alpha run before `20261111-173513`; both now use
`WEBINY_PG_DATABASE`.

## Not done

- Where the 12-14 ms of API CPU per read goes. Reads and mixed traffic break when the Node main
  thread is full, so a CPU profile at ~150 req/s on EC2 is the next step for the read path.
- Scenario 3 on EC2 at a lower rate, to find where the due moment stops OOM-killing the processes.
- Websockets (scenario 2) on EC2; the 5,000-socket numbers are from the Mac.
- Two API processes on one SQLite file (`SQLITE_BUSY`).
- `sharp` is bundled for darwin only (the build ran on macOS); image processing on upload was not
  tested.
