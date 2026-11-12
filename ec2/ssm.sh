#!/usr/bin/env bash
# Runs a shell command on one of the instances through SSM (as root, in /opt/lt), waits for it,
# prints its output and exits with its exit code. No SSH or session-manager-plugin needed.
#   ec2/ssm.sh sut 'docker compose ps'
#   ec2/ssm.sh loadgen 'docker ps' [timeout seconds, default 3600]
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source state.env
export AWS_REGION
case $1 in
    sut) instance=$SUT ;;
    loadgen) instance=$LOADGEN ;;
    *) echo "sut or loadgen"; exit 2 ;;
esac
timeout=${3:-3600}
params=$(python3 -c 'import json, sys; print(json.dumps({"commands": ["mkdir -p /opt/lt && cd /opt/lt && " + sys.argv[1]], "executionTimeout": [sys.argv[2]]}))' "$2" "$timeout")
id=$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
    --parameters "$params" --timeout-seconds 600 --query Command.CommandId --output text)
while true; do
    status=$(aws ssm get-command-invocation --command-id "$id" --instance-id "$instance" --query Status --output text 2> /dev/null || echo Pending)
    case $status in
        Pending | InProgress | Delayed) sleep 5 ;;
        *) break ;;
    esac
done
aws ssm get-command-invocation --command-id "$id" --instance-id "$instance" --query StandardOutputContent --output text
err=$(aws ssm get-command-invocation --command-id "$id" --instance-id "$instance" --query StandardErrorContent --output text)
[ -n "$err" ] && [ "$err" != "None" ] && echo "$err" >&2
code=$(aws ssm get-command-invocation --command-id "$id" --instance-id "$instance" --query ResponseCode --output text)
echo "[$1: $status, exit $code]" >&2
[ "$status" = Success ]
