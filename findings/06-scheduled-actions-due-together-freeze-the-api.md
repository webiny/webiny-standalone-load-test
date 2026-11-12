# 300 scheduled actions due at the same moment get every API process OOM-killed

webiny-js `6f462b597f` and `6.6.0-alpha.10`, standalone, Postgres, two API processes (1.5 CPU,
1 GB each).

## Update: on EC2 both processes are killed

On a host of its own (EC2 c7g.2xlarge, REPORT.md "EC2 runs"), with mixed traffic at 110 req/s,
the kernel killed both API processes 1-2 s after 300 actions fell due
(`Memory cgroup out of memory: Killed process ... anon-rss:1023804kB`). Seconds before, they sat at
370 and 359 MB. Without a restart policy they stayed down and none of the 300 actions ran
(`results/20261111-193819-scenario3-mixed110`).

With `restart: unless-stopped` (`results/20261111-205110-scenario3-mixed110`) the processes came
back, boot recovery re-armed the pending actions on both, and all 300 ran within 8 s, none twice,
at RSS ~310 MB and event-loop lag under 50 ms. 2.25% of requests got 502 while both were down.

So the same 300 actions cost each process over 650 MB when the timers fire them live, and almost
nothing when recovery runs them after they are already due. That fits the cause below: the memory
goes into starting a worker thread per action at the due moment, not into the actions. The
exactly-once claims held through both kills.

The local runs below, on a shared Mac, froze instead of dying. A plausible reason is that the
slower host spread the worker starts out; that is not measured.

## What I did

`scripts/scenario3.sh 90 300 200` (`results/20261111-121658-scenario3-mixed90`): mixed CMS
traffic held at 90 req/s (about 70% of where mixed breaks); after a minute, 300 draft entries
scheduled to publish at the same moment, two minutes later, through
`scheduler.scheduleAction(namespace: "Cms/Entry/loadArticle", actionType: publish)`, and 200
`testingRun` background tasks.

Then, with no traffic, the same 300-action schedule again (`schedule-second-burst.txt` in the same
folder).

## What happened

Correctness held: 300 actions, 300 claims, none run twice, all 300 entries published, nothing left
pending; all 200 tasks `success` with 1 iteration.

The API did not. From the per-process monitor (RSS, event-loop lag, active handles, 10 s windows)
and k6, with traffic:

```
time      requests  p50 ms   p95 ms | api-1                         | api-2
11:19:50   788         21     1134  | rss 290 lag 110  handles 322  | rss 314 lag 171  handles 322
11:20:10   183      17690    20775  | rss 762 lag 2423 handles 1005 | rss 681 lag 93   handles 733
11:20:20   982      11300    18849  | rss 800 lag 492  handles 1185 | rss 638 lag 247  handles 524
11:21:00  1211      12077    18602  | rss 864 lag 204  handles 1379 | rss 632 lag 44   handles 35
11:21:30  1208        150     6317  | rss 872 lag 95   handles 64   | rss 634 lag 63   handles 25
```

- The actions were due at 11:19:58.4 and claimed (all by api-1) between 11:20:12.5 and 11:20:12.8:
  14 s late.
- Requests stalled for about 90 s; in the worst 10 s, 183 requests completed instead of 900.
- RSS rose by ~470 MB on api-1 and ~370 MB on api-2 and stayed there (api-2 at the end: RSS 636 MB,
  JS heap 54 MB).

Without traffic, the second burst:

```
11:28:27 api-2 rss 756 heap 137 lag max  9863 ms handles 332
11:28:31 api-1 rss 993 heap 105 lag max 16851 ms handles 332
```

An event loop blocked for 16.9 s, and api-1 at 993 MB of its 1 GB limit. A third burst would
likely have been OOM-killed.

## Why

`BreeSchedulerService` (`packages/api-scheduler-standalone/src/BreeSchedulerService.ts`) adds one
Bree job per action, and Bree runs every job as a new `worker_thread` (`jobs/pollWorker.js`),
whose only work is to post "poll" back to the main thread. Every process arms every pending action
(its own, plus the others' through the 60 s recovery), so at the due time each process starts 300
worker threads at once. Each is a new V8 isolate and Node environment; the main thread pays for
starting them, and the native memory they leave is not given back to the OS.

The active-handle count shows it: ~20 at rest, ~320 once the actions are armed (one per job),
1,005 at the due time.

## Suggested direction

Drop the worker per action. The worker exists only to call back into the main thread, which a
timer does directly: keep the pending actions in a sorted structure (or one `setTimeout` per
action, capped at 2^31-1 ms and re-armed) and run due ones through a small concurrency-limited
queue. That also removes the 14 s lateness and the per-action handle.

Files: `packages/api-scheduler-standalone/src/BreeSchedulerService.ts`,
`packages/api-scheduler-standalone/src/jobs/pollWorker.js`,
`packages/api-event-handler-standalone/src/scheduler/schedulerServer.ts`.
