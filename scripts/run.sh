#!/usr/bin/env bash
# Runs one k6 script, or a Node client script from scripts/ (name ending in .mjs), and keeps everything about the run in results/<timestamp>-<name>/:
#   meta.txt        webiny-js commit, build folder, container limits, k6 arguments
#   k6.json.gz      every k6 data point
#   summary.txt     k6's end-of-test summary
#   steps.md        per-step report (scripts/steps.mjs)
#   stats.csv       docker stats every 5 s (CPU, memory per container)
#   pg.csv          Postgres connections by state every 5 s
#   pg-top.txt      the 15 statements with the most total time (pg_stat_statements)
#   logs/*.log      API, nginx and Postgres logs for the run; LTMON lines carry RSS and loop lag
#
#   scripts/run.sh <name> <k6 script> [k6 run args...]
#   scripts/run.sh read-ramp ramp.js -e SCENARIO=read
#   scripts/run.sh ws-1000 ws-fanout.mjs -e CONNECTIONS=1000
set -euo pipefail
cd "$(dirname "$0")/.."

name=$1
script=$2
shift 2

set -a
# shellcheck disable=SC1091
source .env
set +a
# With COMPOSE_FILE=compose.sqlite.yml the stack has one API process and no Postgres; the
# Postgres-only samples are skipped and LT_API_KEY (or API_KEY_SQLITE) is the key.
API_KEY=${LT_API_KEY:-$API_KEY}
has_pg=""
if docker compose ps --services | grep -qx postgres; then
    has_pg=1
fi

dir="results/$(date +%Y%m%d-%H%M%S)-${name}"
mkdir -p "$dir/logs"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

{
    echo "name: $name"
    echo "started: $started"
    echo "build: $WEBINY_BUILD"
    echo "webiny-js commit: ${WEBINY_BUILD%%-*}"
    echo "k6: $script $*"
    echo "WEBINY_PG_POOL_MAX: ${WEBINY_PG_POOL_MAX:-10 (default)}"
    echo "host: ${LT_HOST:-$(uname -sm)}, $(nproc 2> /dev/null || sysctl -n hw.ncpu) CPUs; k6 on: ${LOADGEN:-this host}"
    echo
    echo "containers (cpus, memory limit):"
    for c in $(docker compose ps -q); do
        docker inspect -f '{{.Name}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' "$c" |
            awk '{ printf "  %s cpus=%s mem=%dMiB\n", substr($1, 2), $2 / 1e9, $3 / 1048576 }'
    done
} > "$dir/meta.txt"

psql() {
    [ -n "$has_pg" ] || return 0
    docker compose exec -T postgres psql -U postgres -d "${WEBINY_PG_DATABASE:-webiny}" -At -F, -c "$1"
}
psql "create extension if not exists pg_stat_statements" > /dev/null
psql "select pg_stat_statements_reset()" > /dev/null

echo "time,container,cpu,mem" > "$dir/stats.csv"
(
    while true; do
        now=$(date -u +%H:%M:%S)
        docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' |
            grep -E "$(docker compose ps --format '{{.Name}}' | paste -sd'|' -)" | sed "s/^/$now,/" >> "$dir/stats.csv"
        # The containers share the host's CPUs with everything else running on it, and a busy host
        # moves the breaking points. Row "host": 1-minute load average, then the host's CPU count.
        if [ -r /proc/loadavg ]; then
            echo "$now,host,$(cut -d' ' -f1 /proc/loadavg),$(nproc)" >> "$dir/stats.csv"
        else
            echo "$now,host,$(sysctl -n vm.loadavg | awk '{ print $2 }'),$(sysctl -n hw.ncpu)" >> "$dir/stats.csv"
        fi
        sleep 5
    done
) &
stats_pid=$!

echo "time,state,wait_event_type,count" > "$dir/pg.csv"
(
    while true; do
        now=$(date -u +%H:%M:%S)
        psql "select state, coalesce(wait_event_type, ''), count(*) from pg_stat_activity where datname = '${WEBINY_PG_DATABASE:-webiny}' and pid <> pg_backend_pid() group by 1, 2" |
            sed "s/^/$now,/" >> "$dir/pg.csv" || true
        sleep 5
    done
) &
pg_pid=$!

trap 'kill $stats_pid $pg_pid 2> /dev/null || true' EXIT

set +e
if [[ "$script" == *.mjs ]]; then
    # A Node client script (scripts/), run in the `client` container. Extra arguments are
    # `-e NAME=value` pairs, as for k6. OUT points at the run's folder for the script's report.
    docker compose run --rm -e API_KEY="$API_KEY" -e OUT="/results/${dir#results/}/report.json" \
        "$@" client node "/lt/scripts/$script" 2>&1 | tee "$dir/summary.txt"
    k6_exit=${PIPESTATUS[0]}
elif [ -n "${LOADGEN:-}" ]; then
    # k6 on another machine (EC2: ec2/README.md): LOADGEN is user@host with this setup in
    # /opt/lt, SUT_IP the address it reaches this machine's nginx on. The k6 output comes back
    # into this run's folder.
    ssh -o StrictHostKeyChecking=accept-new "$LOADGEN" \
        "cd /opt/lt && mkdir -p '$dir' && chmod 777 '$dir' && SUT_IP='$SUT_IP' API_KEY='$API_KEY' docker compose -f compose.loadgen.yml run --rm k6 run --out 'json=/results/${dir#results/}/k6.json.gz' '/scripts/$script' $(printf '%q ' "$@")" \
        2>&1 | tee "$dir/summary.txt"
    k6_exit=${PIPESTATUS[0]}
    scp -q "$LOADGEN:/opt/lt/$dir/k6.json.gz" "$dir/"
else
    docker compose run --rm -e API_KEY="$API_KEY" k6 run \
        --out "json=/results/${dir#results/}/k6.json.gz" \
        "/scripts/$script" "$@" 2>&1 | tee "$dir/summary.txt"
    k6_exit=${PIPESTATUS[0]}
fi
set -e

{ kill $stats_pid $pg_pid; wait $stats_pid $pg_pid; } 2> /dev/null || true

for svc in $(docker compose ps --services); do
    docker compose logs --no-color --since "$started" "$svc" > "$dir/logs/$svc.log" 2>&1 || true
done
psql "select round(total_exec_time)::text || ' ms total', calls, round(mean_exec_time::numeric, 2) || ' ms mean', left(regexp_replace(query, '\s+', ' ', 'g'), 300) from pg_stat_statements order by total_exec_time desc limit 15" > "$dir/pg-top.txt" || true

if [ -f "$dir/k6.json.gz" ]; then
    node scripts/steps.mjs "$dir/k6.json.gz" --md > "$dir/steps.md" || true
    cat "$dir/steps.md"
fi
echo "k6 exit: $k6_exit"
echo "results: $dir"
