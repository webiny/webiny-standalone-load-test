#!/usr/bin/env bash
# Runs the same ramp for the source build and the published alpha in turn, ROUNDS times, each on
# its own database restored from its baseline, so the two builds see the same host conditions.
# Run names end in -<label>-<round>.
#   scripts/ab.sh <name> <k6 script> [k6 args...]
#   ROUNDS=3 scripts/ab.sh read-ramp ramp.js -e SCENARIO=read -e START=20 -e STEP=20
set -euo pipefail
cd "$(dirname "$0")/.."
name=$1
shift
rounds=${ROUNDS:-3}
# label, build folder, database
builds=(
    "source 6f462b597f-postgres-unlicensed webiny"
    "alpha 6.6.0-alpha.10-postgres webiny_alpha"
)
cp .env .env.ab-backup
trap 'mv .env.ab-backup .env' EXIT
for round in $(seq 1 "$rounds"); do
    for entry in "${builds[@]}"; do
        read -r label build db <<< "$entry"
        sed -i.bak -E "s/^WEBINY_BUILD=.*/WEBINY_BUILD=$build/; s/^WEBINY_PG_DATABASE=.*/WEBINY_PG_DATABASE=$db/" .env
        rm -f .env.bak
        docker compose up -d --force-recreate api-1 api-2 admin > /dev/null 2>&1
        scripts/reset-db.sh
        # Each baseline has its own load-test key: the one with the hand-added `tasks` permission.
        LT_API_KEY=$(docker compose exec -T postgres psql -U postgres -d "$db" -Atc \
            "select token from webiny_core_api_keys where data like '%\"tasks\"%'")
        export LT_API_KEY
        scripts/run.sh "$name-$label-$round" "$@" > /dev/null 2>&1 || true
        dir=$(ls -td results/*-"$name-$label-$round" | head -1)
        echo "== $dir"
        cat "$dir/steps.md" 2> /dev/null || tail -5 "$dir/summary.txt"
    done
done
