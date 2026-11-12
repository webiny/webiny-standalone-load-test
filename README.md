# Webiny standalone load tests

Load tests for Webiny on the standalone hosting type: Postgres, Valkey, two API processes behind
round-robin nginx, and k6. The API is built from a `webiny-js` checkout; nothing here changes it.

## Building the API and Admin

In the `webiny-js` checkout:

```
yarn
yarn build
export WEBINY_PROJECT_ID= WEBINY_PROJECT_API_KEY= WEBINY_DB=postgres WEBINY_API_URL=http://localhost:3002
yarn webiny-standalone build api
yarn webiny-standalone build admin
git rev-parse --short HEAD   # record this next to every result
```

Then copy both build folders into this repository, named after the commit:

```
B=builds/<commit>-postgres-unlicensed
mkdir -p $B
cp -R <webiny-js>/.webiny/workspace/apps/api/graphql/build $B/api
cp -R <webiny-js>/.webiny/workspace/apps/admin/build $B/admin
```

and set `WEBINY_BUILD=<commit>-postgres-unlicensed` in `.env`. The containers mount the copy, so
rebuilding the checkout (or somebody else building in it) never changes what a running test
serves. `builds/` is not committed.

The empty `WEBINY_PROJECT_ID` and `WEBINY_PROJECT_API_KEY` keep the build unlicensed. The monorepo's
`.env` sets both, and a licensed build run without them at runtime breaks the CMS API (see
`findings/01-license-mismatch-breaks-cms-schema.md`). Unlicensed matches CI's regular standalone
variant and keeps calls to WCP out of the load runs; the scheduler is not license-gated.

## Running

```
cp .env.example .env         # fill in random secrets and WEBINY_BUILD
docker compose up -d
curl -s -X POST localhost:3002/graphql -H 'content-type: application/json' -d '{"query":"{__typename}"}'
```

- API (nginx in front of `api-1` and `api-2`): http://localhost:3002
- Admin: http://localhost:3001

The API containers mount the build folder read-only and get the database and secrets at runtime;
`node start.mjs` does not see what was baked in at build time.

Resource limits (Docker Desktop has 10 CPUs, 8 GB):

| Service  | CPUs | Memory |
| -------- | ---- | ------ |
| postgres | 2    | 2 GB   |
| valkey   | 0.5  | 256 MB |
| api-1    | 1.5  | 1 GB   |
| api-2    | 1.5  | 1 GB   |
| nginx    | 0.5  | 128 MB |
| admin    | 0.25 | 64 MB  |
| k6       | 2    | 1 GB   |

## Test data and API key

`node scripts/seed.mjs 3000` creates the `loadArticle` model (20 fields) and 3,000 published
entries through the manage API.

The load-test API key has `cms.*` and `backgroundTasks.*`, plus `{"name": "tasks"}` added by hand
in `webiny_core_api_keys`: the background tasks API checks a permission named `tasks`, which the
Admin never grants (`findings/02-tasks-api-checks-wrong-permission-name.md`).

Websocket tests log in as the admin user instead (`ADMIN_EMAIL`, `ADMIN_PASSWORD`): a socket
opened with an API key is registered as anonymous, so nothing can be sent to it.

## Running a test

```
scripts/run.sh <name> ramp.js -e SCENARIO=read|write|mixed [-e START=.. -e STEP=.. -e HOLD_RATE=..]
```

keeps everything about the run in `results/<timestamp>-<name>/` (see the header of
`scripts/run.sh`), including `steps.md`, the per-step table. `node scripts/resources.mjs <dir>`
lines up CPU, Postgres connections, RSS and event-loop lag per minute with p95 per operation per step.

Each API process is started with `node --import /monitor/monitor.mjs start.mjs`; the monitor prints
an `LTMON` line every 5 s with RSS, heap and event-loop lag (net of its 10 ms sampling resolution).

Other clients run in the `client` service (Node, 2 CPUs), through the same `scripts/run.sh` when the
script name ends in `.mjs`: `scripts/ws-fanout.mjs` (websocket fan-out), `scripts/ws-restart.mjs`
(websockets through a restart), `scripts/schedule.mjs` (scheduled publishing), `scripts/tasks.mjs`
(background tasks). `scripts/claims.sh` counts scheduler runs per action and per process.

Whole scenarios: `scripts/scenario3.sh` (scheduler and tasks under load), `scripts/scenario4.sh`
(SIGTERM one process under load). `scripts/reset-db.sh` restores the 3,000-entry baseline
(`--save` stores the current database as the baseline) and waits for each process on its own port.

Diagnostics used along the way: `scripts/pg-waits.sh` (Postgres backends and waits every 0.5 s),
`compose.profile.yml` + `scripts/cpuprofile-top.mjs` (CPU profile of api-1, mapped to source
through the build's source maps), `compose.keepalive.yml` (nginx reusing upstream connections),
`scripts/cleanup.mjs` (delete every entry the seed did not create).

## SQLite baseline

`compose.sqlite.yml` runs one API process on a SQLite file; stop the Postgres stack first, then
`COMPOSE_FILE=compose.sqlite.yml` for every `docker compose` and `scripts/run.sh` call, with
`LT_API_KEY` set to `API_KEY_SQLITE`. Build it with `WEBINY_DB` unset and copy it to
`builds/<commit>-sqlite-unlicensed`; install with `installSystem` over GraphQL (app
`SelfHostedAuth`), create a key with `security.createApiKey`, then `scripts/seed.mjs`.

Results and findings: `REPORT.md`, `findings/`.

## EC2

Ramp breaking points measured on a shared machine move with whatever else it runs (REPORT.md,
"Ramp breaking points move with the host"). `ec2/` puts the same stack on an EC2 host of its own,
with k6 on a second instance: `ec2/up.sh`, `ec2/push.sh`, run through `ec2/ssm.sh`, `ec2/pull.sh`,
`ec2/down.sh`. `scripts/ab.sh` runs one ramp for the source build and the published alpha in turn.
Details in `ec2/README.md`.

## Known limitation of this setup

The API is built on macOS, so the build folder bundles `sharp` for darwin-arm64 only. The Linux
containers boot and serve GraphQL without it; anything that loads `sharp` (image processing on
upload) is expected to fail and is not tested here. None of the scenarios depend on it.
