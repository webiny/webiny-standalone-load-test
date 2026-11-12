#!/usr/bin/env bash
# Scheduler claims: one row per run of a scheduled action, keyed tenant/actionId/dueAt, with the
# process that ran it as the value. Prints how many actions ran, how many ran more than once (should
# be 0: the key is unique, so a second run would need a second due time), and runs per process.
#   scripts/claims.sh [since, e.g. '10 minutes']
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a
since=${1:-1 hour}
psql() {
    docker compose exec -T postgres psql -U postgres -d "${WEBINY_PG_DATABASE:-webiny}" -c "$1"
}
# The claim lives RUN_CLAIM_MS (10 min) after it is taken, so expiresAt - 10 min is when it ran.
psql "
with claims as (
    select split_part(key, '/', 2) as action, value as process, \"expiresAt\" - interval '10 minutes' as ran_at
    from webiny_core_key_value
    where scope = 'scheduler/claims' and \"expiresAt\" - interval '10 minutes' > now() - interval '$since'
)
select
    (select count(distinct action) from claims) as actions_run,
    (select count(*) from claims) as claims,
    (select count(*) from (select action from claims group by action having count(*) > 1) d) as actions_run_twice"
psql "
select value as process, count(*) as runs, min(\"expiresAt\" - interval '10 minutes') as first, max(\"expiresAt\" - interval '10 minutes') as last
from webiny_core_key_value
where scope = 'scheduler/claims' and \"expiresAt\" - interval '10 minutes' > now() - interval '$since'
group by value order by value"
