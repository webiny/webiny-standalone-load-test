#!/usr/bin/env bash
# Puts the database back to the saved baseline (3,000 seeded loadArticle entries, the API key,
# the admin user), so every run starts from the same data. The API processes are stopped while the
# database is swapped, since Postgres can't copy or drop a database with open connections.
#   scripts/reset-db.sh          restore $WEBINY_PG_DATABASE (default webiny) from <name>_baseline
#   scripts/reset-db.sh --save   save the current database as <name>_baseline
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a
db=${WEBINY_PG_DATABASE:-webiny}
psql() {
    docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "$1"
}
docker compose stop api-1 api-2 > /dev/null 2>&1
if [ "${1:-}" = "--save" ]; then
    psql "drop database if exists ${db}_baseline"
    psql "create database ${db}_baseline template ${db}"
else
    psql "drop database ${db}"
    psql "create database ${db} template ${db}_baseline"
fi
# The baseline keeps no scheduler, task or websocket rows; the processes rebuild their state.
docker compose start api-1 api-2 > /dev/null 2>&1
# Each process on its own port, not through nginx: a probe through nginx while the processes boot
# makes nginx mark them down (max_fails=1, fail_timeout=10s), and whichever comes back first then
# gets nearly all the traffic, websockets included, for a while.
ready() {
    docker compose exec -T "$1" node -e "fetch('http://127.0.0.1:3000/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{\"query\":\"{__typename}\"}' }).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" > /dev/null 2>&1
}
for svc in api-1 api-2; do
    for i in $(seq 1 60); do
        ready "$svc" && break
        if [ "$i" = 60 ]; then
            echo "$svc did not come back" >&2
            exit 1
        fi
        sleep 1
    done
done
# Let nginx's fail_timeout for anything marked down while booting run out.
sleep 11
echo "database reset, both API processes answering"
