#!/usr/bin/env bash
# Scenario 4: SIGTERM one API process under load, then start it again.
#   scripts/scenario4.sh [rate=60]
# Mixed traffic at `rate` req/s for 5 minutes, 1,000 reconnecting websockets with a message every
# second (scripts/ws-restart.mjs), and a CMS bulk Publish of 2,000 drafts running as a background
# task. At ~75 s the process holding the task's claim gets SIGTERM; it is started again once it
# has exited. Writes restart.txt, bulk.txt and ws.json into the k6 run's folder.
set -euo pipefail
cd "$(dirname "$0")/.."
rate=${1:-60}
set -a
# shellcheck disable=SC1091
source .env
set +a
gql() {
    curl -s -X POST "localhost:3002$1" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d "$2"
}

scripts/reset-db.sh
echo "creating 2,000 drafts for the bulk action"
node -e '
const [key] = process.argv.slice(1);
let next = 0, failed = 0;
const one = async () => { while (next < 2000) { const i = next++;
  const res = await fetch("http://localhost:3002/cms/manage", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ query: "mutation ($d: LoadArticleInput!) { createLoadArticle(data: $d) { error { message } } }", variables: { d: { values: { title: "bulk " + i, category: "bulk" } } } }) }).then(r => r.json());
  if (res.errors || res.data.createLoadArticle.error) failed++; } };
Promise.all(Array.from({ length: 16 }, one)).then(() => console.log("drafts created, failed:", failed));' "$API_KEY"

scripts/run.sh "scenario4-mixed${rate}" ramp.js -e SCENARIO=mixed -e HOLD_RATE="$rate" -e HOLD_SEC=300 > /tmp/scenario4-k6.out 2>&1 &
k6_pid=$!
sleep 5
dir=$(ls -d results/*-scenario4-mixed"${rate}" | tail -1)
docker compose run --rm -e CONNECTIONS=1000 -e OPEN_RATE=50 -e DURATION_SEC=230 -e INTERVAL_MS=1000 \
    -e ADMIN_EMAIL="$ADMIN_EMAIL" -e ADMIN_PASSWORD="$ADMIN_PASSWORD" -e OUT="/results/${dir#results/}/ws.json" \
    client node /lt/scripts/ws-restart.mjs > "$dir/ws.txt" 2>&1 &
ws_pid=$!

sleep 55
task=$(gql /cms/manage '{"query":"mutation { bulkActionLoadArticle(action: Publish, where: { values: { category: \"bulk\" } }) { data { id } error { message } } }"}')
echo "bulk action: $task" | tee "$dir/bulk.txt"
task_id=$(echo "$task" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.bulkActionLoadArticle.data.id))')

# Wait until a process has claimed the task, then pick that one.
owner=""
for _ in $(seq 1 30); do
    owner=$(docker compose exec -T postgres psql -U postgres -d "${WEBINY_PG_DATABASE:-webiny}" -Atc "select value from webiny_core_key_value where scope = 'background-tasks/claims' order by \"expiresAt\" desc limit 1" | tr -d '"' | cut -d: -f1)
    [ -n "$owner" ] && break
    sleep 1
done
victim=api-1
[ "$owner" = "$(docker compose exec -T api-2 hostname | tr -d '\r')" ] && victim=api-2
{
    echo "task $task_id claimed by host $owner -> stopping $victim"
    echo "SIGTERM at $(date -u +%T.%3N)"
    docker compose stop -t 30 "$victim"
    echo "exited at  $(date -u +%T.%3N)"
    docker compose start "$victim"
    echo "started at $(date -u +%T.%3N)"
} 2>&1 | tee "$dir/restart.txt"

# Follow the task to its end. Bulk-action tasks delete their own records when they finish, so
# "done" is all 2,000 drafts published (or 10 minutes passed).
for _ in $(seq 1 120); do
    status=$(gql /graphql "{\"query\":\"{ backgroundTasks { getTask(id: \\\"$task_id\\\") { data { taskStatus iterations } } } }\"}")
    published=$(gql /cms/manage '{"query":"{ listLoadArticles(where: { values: { category: \"bulk\" }, status: \"published\" }, limit: 1) { meta { totalCount } } }"}' | grep -o '"totalCount":[0-9]*' | cut -d: -f2)
    echo "$(date -u +%T) published=$published task=$status" >> "$dir/bulk.txt"
    [ "$published" = "2000" ] && break
    sleep 5
done
tail -1 "$dir/bulk.txt"
gql /cms/manage '{"query":"{ listLoadArticles(where: { values: { category: \"bulk\" }, status: \"published\" }, limit: 1) { meta { totalCount } } }"}' | tee -a "$dir/bulk.txt"
echo
docker compose exec -T postgres psql -U postgres -d "${WEBINY_PG_DATABASE:-webiny}" -Atc "select key, value from webiny_core_key_value where scope like 'background-tasks/%'" >> "$dir/bulk.txt"

wait $ws_pid || true
wait $k6_pid || true
tail -6 /tmp/scenario4-k6.out
echo "--- ws"; tail -40 "$dir/ws.txt"
