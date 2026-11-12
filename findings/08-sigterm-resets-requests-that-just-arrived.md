# SIGTERM resets requests that have just arrived: 502 behind a proxy

webiny-js `6f462b597f`, standalone, two API processes behind nginx (which sends `Connection: close`
upstream, as in the CI standalone job, so every proxied request is a fresh connection).

## What I did

`scripts/scenario4.sh 60` (`results/*-scenario4-mixed60`): 60 req/s mixed CMS traffic, then
`docker compose stop api-2` (SIGTERM) at 11:31:18.

## What happened

Two requests failed, both at the moment of the signal and both on api-2:

```
start         end           ms  op      status
11:31:18.201  11:31:18.252  51  get     502
11:31:18.235  11:31:18.252  17  update  502
```

nginx: `recv() failed (104: Connection reset by peer) while reading response header from upstream`.
Every other request sent to api-2 before the signal finished with 200 (17,851 of 17,853 in the run).

## Why (likely; not traced in Node)

On SIGTERM, `handleShutdownSignals` calls `server.close()` and then `server.closeIdleConnections()`
(`packages/event-handler-standalone/src/server/handleShutdownSignals.ts`). Node counts a connection
as idle until it has parsed a request on it, so a connection whose request bytes are in flight, or
not yet parsed, is closed under it. The proxy has already sent the request and gets a reset, and
since it was a POST it does not retry it.

## Effect

A handful of 502s per restart under load. Small, but it is the one place a rolling restart drops
requests.

## Suggested direction

Leave connections that the proxy opened to finish: drop `closeIdleConnections()` and rely on
`server.close()` plus the shutdown timeout, or answer requests that arrive after the signal with
`Connection: close` and close each connection once its response is written.

Files: `packages/event-handler-standalone/src/server/handleShutdownSignals.ts`.
