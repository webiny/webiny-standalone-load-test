#!/usr/bin/env bash
# Copies the sut's results/ into the local results/ (through the bucket). Run names already say
# where they ran: meta.txt has the host line.
#   ec2/pull.sh
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source ec2/state.env
export AWS_REGION
ec2/ssm.sh sut "aws s3 sync --quiet results s3://$BUCKET/results && ls results | tail -20"
aws s3 sync --quiet "s3://$BUCKET/results" results
