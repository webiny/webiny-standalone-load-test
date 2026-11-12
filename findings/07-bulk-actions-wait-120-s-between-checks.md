# CMS bulk actions on standalone spend almost all their time in a fixed 120 s wait

webiny-js `6f462b597f`, standalone, Postgres, two API processes, no other load.

## What I did

Created 2,000 draft `loadArticle` entries with `category: "bulk"`, then:

```
mutation { bulkActionLoadArticle(action: Publish, where: { values: { category: "bulk" } }) { data { id } error { message } } }
```

and read each entry's `lastPublishedOn` afterwards, counted per 5 s.

## What happened

Requested at 11:43:13; all 2,000 published by 11:45:31 (2 min 18 s):

```
11:43:10  57   11:43:14 371   11:43:15 393   11:43:19  96   11:43:20  82
   ... nothing for 2 minutes ...
11:45:19 135   11:45:20 173   11:45:24 373   11:45:25 307   11:45:29  12
```

The publishing itself took about 20 s; the rest was waiting.

## Why

`ProcessTasksByModel` (`packages/api-headless-cms-bulk-actions/src/features/EntriesBulkAction/internals/ProcessTasksByModel.ts:44-54`)
checks whether the parent's subtasks are still running or pending, and if any are, continues with
`{ seconds: 120 }`. On AWS that is a Step Functions wait, which costs nothing and suits subtasks
that run in other Lambdas for minutes. In-process (`background-tasks-standalone`) the subtasks
finish in seconds, so every check that finds one still running costs two minutes. A bulk action
over more entries pays it once per check that finds work in progress.

## Effect

A bulk action on a few thousand entries takes minutes on standalone instead of seconds, with the
Admin showing it as running the whole time.

## Suggested direction

Make the wait a setting of the task runtime, short in-process (a few seconds) and 120 s on AWS, or
have the in-process runner wake the parent when its last subtask finishes.

Files: `packages/api-headless-cms-bulk-actions/src/features/EntriesBulkAction/internals/ProcessTasksByModel.ts`,
`packages/background-tasks-standalone/src/loop/`.

## Related: a restart in the middle works

In `results/*-scenario4-mixed60`, the process holding the same bulk task got SIGTERM before it had
published anything. The other process's recovery ("Recovered background tasks that no process
held", `resumed 2`, then `resumed 9`) carried it on and all 2,000 entries were published, in
bursts at the recovery sweeps.
