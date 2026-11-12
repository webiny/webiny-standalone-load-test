# Every CMS write runs a webhook search that costs Postgres 5-9 ms to plan, with no webhooks configured

webiny-js `6f462b597f`, standalone, Postgres 17 (2 CPUs), two API processes. No webhooks exist.

## What I did

CMS manage API writes (`createLoadArticle` / `updateLoadArticle`, half each) on a 20-field model:

- a ramp, +10 req/s every minute (`results/20261111-105803-write-ramp`), and
- 3 minutes at a steady 70 req/s with `pg_stat_statements.track_planning = on`
  (`results/20261111-110940-write-hold70-planning`).

## What happened

The write ramp crossed p95 > 1 s at 100 req/s. Postgres was the first thing to saturate: it used
its full 2 CPUs (205-210% in `docker stats`) while each API process sat at about one core.

During the steady 70 req/s, Postgres spent more time planning than executing:

```
 plan_ms | exec_ms | calls
  120573 |   62884 | 267285
```

Three quarters of that planning time is one statement, run once per write (12,398 calls for
12,398 writes):

```
90480 ms plan | 587 ms exec | 12398 calls | 7.30 ms/plan | 0.05 ms/exec |
WITH m AS MATERIALIZED (SELECT entry_id, id, n1 AS sort_key FROM "webiny_cms_search" WHERE ... tok @> $3 AND (tsv @@ $4::tsquery AND EXISTS (SELECT 1 FROM unnest(ta1) v WHERE v::text ILIKE $5)) ...
```

With statement logging on for one `createLoadArticle`, the parameters are scope 38, which is the
`webhook` model, `{38:b2:true}` (enabled = true) and `'%cms.entry.loadArticle.created%'`:

```
LOG:  duration: 8.864 ms  bind <unnamed>: WITH m AS MATERIALIZED (...)
DETAIL:  Parameters: $1 = '38', $2 = '1', $3 = '{38:b2:true}', $4 = '''38_f26_cms'':* & ''38_f26_entry'':* & ''38_f26_loadarticle'':* & ''38_f26_created'':* | ''38_f26#long''', $5 = '%cms.entry.loadArticle.created%'
LOG:  duration: 0.073 ms  execute <unnamed>: ...
```

That is `WebhookDispatcher.dispatch` looking for enabled webhooks subscribed to the event. It runs
on every entry event, finds nothing, and also reads the webhook settings.

## Where the planning time goes

Run by hand in psql, 30 times each, custom plans (`results/20261111-110940-write-hold70-planning/planning-experiment.txt`):

| query | indexes on webiny_cms_search | planning, median | p90 |
| --- | ---: | ---: | ---: |
| the webhook search above | 193 | 5.27 ms | 7.89 ms |
| the webhook search above | 48 (empty ones dropped, rolled back) | 4.64 ms | 5.85 ms |
| same scope, `tok @>` condition only | 193 | 1.39 ms | 2.44 ms |

The number of indexes is a small part of it. The `events_contains` filter compiles into a prefix
tsquery plus an `ILIKE` over `unnest(ta1)`, and that is what is expensive to plan. Statements go
out unnamed (knex), so nothing is reused between calls, and under load each plan took 7-9 ms.

## Why it matters

- With no webhooks, about 7 ms of Postgres CPU per write is spent finding out there are none. At
  70 writes/s that is half a core of a 2-core database.
- Any CMS list that uses `_contains` on a text list field pays the same planning cost on the
  read path.

## Suggested direction

1. `WebhookDispatcher` (`packages/webhooks/src/api/features/WebhookDispatcher/WebhookDispatcher.ts:34`):
   keep the enabled webhooks (or just "are there any") in memory per process and refresh them when
   a webhook is saved or deleted, instead of a search per event. The settings read at line 45 can
   go the same way.
2. Postgres storage (`packages/api-headless-cms-pg/src/features/search/`): look at how
   `_contains` on a list field is compiled; a filter that plans in ~1 ms (like the `tok @>` one)
   would remove most of this. Named prepared statements would let Postgres reuse plans, but the
   generic plan for these queries would need checking first.
