# Webiny standalone load tests

Load tests for Webiny on the standalone hosting type: Postgres, Valkey, two API processes behind
round-robin nginx, and k6. The API is built from a `webiny-js` checkout; nothing here changes it.

## Building the API and Admin

In the `webiny-js` checkout:

```
yarn
yarn build
WEBINY_DB=postgres WEBINY_API_URL=http://localhost:3002 yarn webiny-standalone build api
WEBINY_DB=postgres WEBINY_API_URL=http://localhost:3002 yarn webiny-standalone build admin
git rev-parse --short HEAD   # record this next to every result
```

## Running

```
cp .env.example .env         # fill in random secrets and WEBINY_JS
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

k6 runs on demand: `docker compose run --rm k6 run /scripts/<script>.js`.

## Known limitation of this setup

The API is built on macOS, so the build folder bundles `sharp` for darwin-arm64 only. The Linux
containers boot and serve GraphQL without it; anything that loads `sharp` (image processing on
upload) is expected to fail and is not tested here. None of the scenarios depend on it.
