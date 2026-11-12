#!/usr/bin/env bash
# Samples Postgres every 0.5 s for SECONDS (default 120): non-idle backends with their wait event
# and query, and which backend blocks which. Output: one line per backend per sample.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a
seconds=${1:-120}
docker compose exec -T postgres bash -c "
end=\$((SECONDS + $seconds))
while [ \$SECONDS -lt \$end ]; do
  psql -U postgres -d ${WEBINY_PG_DATABASE:-webiny} -At -F'|' -c \"
    select to_char(clock_timestamp(), 'HH24:MI:SS.MS'), pid, state, coalesce(wait_event_type,'') || ':' || coalesce(wait_event,''),
           round(extract(epoch from clock_timestamp() - xact_start)::numeric * 1000) as xact_ms,
           pg_blocking_pids(pid)::text, left(regexp_replace(query, '\s+', ' ', 'g'), 140)
    from pg_stat_activity
    where datname = '${WEBINY_PG_DATABASE:-webiny}' and pid <> pg_backend_pid() and state <> 'idle'\"
  sleep 0.5
done"
