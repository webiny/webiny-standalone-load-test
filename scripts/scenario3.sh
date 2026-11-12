#!/usr/bin/env bash
# Scenario 3: scheduler and background tasks while the mixed load runs.
#   scripts/scenario3.sh [rate=90] [actions=300] [tasks=200]
# Holds mixed traffic at `rate` req/s for 9 minutes; after the first minute, schedules `actions`
# publishes all due at the same moment (2 minutes later) and triggers `tasks` background tasks.
# Reports land in the k6 run's folder: schedule.json, tasks.json, claims.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
rate=${1:-90}
actions=${2:-300}
tasks=${3:-200}
set -a
# shellcheck disable=SC1091
source .env
set +a

scripts/reset-db.sh
scripts/run.sh "scenario3-mixed${rate}" ramp.js -e SCENARIO=mixed -e HOLD_RATE="$rate" -e HOLD_SEC=540 > /tmp/scenario3-k6.out 2>&1 &
k6_pid=$!
sleep 60
dir=$(ls -d results/*-scenario3-mixed"${rate}" | tail -1)

docker compose run --rm -e API_KEY="$API_KEY" -e COUNT="$actions" -e LEAD_SEC=120 -e WAIT_SEC=180 \
    -e OUT="/results/${dir#results/}/schedule.json" client node /lt/scripts/schedule.mjs > "$dir/schedule.txt" 2>&1 &
schedule_pid=$!
docker compose run --rm -e API_KEY="$API_KEY" -e COUNT="$tasks" -e WAIT_SEC=420 \
    -e OUT="/results/${dir#results/}/tasks.json" client node /lt/scripts/tasks.mjs > "$dir/tasks.txt" 2>&1 &
tasks_pid=$!

wait $schedule_pid || echo "schedule client failed"
scripts/claims.sh '20 minutes' > "$dir/claims.txt" 2>&1 || true
wait $tasks_pid || echo "tasks client failed"
wait $k6_pid || true
tail -8 /tmp/scenario3-k6.out
echo "--- schedule"; tail -25 "$dir/schedule.txt"
echo "--- claims"; cat "$dir/claims.txt"
echo "--- tasks"; tail -22 "$dir/tasks.txt"
