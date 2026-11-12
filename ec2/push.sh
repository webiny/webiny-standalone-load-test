#!/usr/bin/env bash
# Copies this setup to both instances through the bucket: compose files, k6 and helper scripts,
# nginx configs, the Postgres builds, .env, and dumps of the database baselines, which are then
# restored on the sut. Also gives the sut an SSH key the loadgen accepts, for run.sh to start k6
# there (port 22 is open between the two instances only). Run again after changing a script.
#   ec2/push.sh
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source ec2/state.env
export AWS_REGION
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p ec2/.ssh
[ -f ec2/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C lt-sut -f ec2/.ssh/id_ed25519

# What the sut's run.sh needs on top of the local .env.
{
    grep -v -E '^(COMPOSE_FILE|LOADGEN|SUT_IP|LT_HOST)=' .env
    echo
    echo "# EC2 (ec2/push.sh)"
    echo "COMPOSE_FILE=compose.yml:compose.ec2.yml"
    echo "LOADGEN=ec2-user@$LOADGEN_IP"
    echo "SUT_IP=$SUT_IP"
    echo "LT_HOST=\"EC2 c7g.2xlarge, k6 on c7g.xlarge\""
} > "$tmp/env"

# Named, not excluded: bsdtar applies --exclude to every path component, and the builds carry
# node_modules of their own.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$tmp/lt.tgz" compose*.yml k6 monitor nginx scripts builds/*-postgres*

for db in webiny_baseline webiny_alpha_baseline; do
    docker compose exec -T postgres pg_dump -U postgres -Fc "$db" > "$tmp/$db.dump"
done

aws s3 cp --quiet "$tmp/lt.tgz" "s3://$BUCKET/lt.tgz"
aws s3 cp --quiet "$tmp/env" "s3://$BUCKET/env"
aws s3 cp --quiet ec2/.ssh/id_ed25519 "s3://$BUCKET/id_ed25519"
aws s3 cp --quiet ec2/.ssh/id_ed25519.pub "s3://$BUCKET/id_ed25519.pub"
for db in webiny_baseline webiny_alpha_baseline; do
    aws s3 cp --quiet "$tmp/$db.dump" "s3://$BUCKET/$db.dump"
done

ec2/ssm.sh loadgen "
set -e
aws s3 cp --quiet s3://$BUCKET/lt.tgz /tmp/lt.tgz && tar -xzf /tmp/lt.tgz -C /opt/lt
mkdir -p /opt/lt/results && chmod 777 /opt/lt/results && chown -R ec2-user /opt/lt
aws s3 cp --quiet s3://$BUCKET/id_ed25519.pub /tmp/key.pub
grep -qf /tmp/key.pub /home/ec2-user/.ssh/authorized_keys 2> /dev/null || cat /tmp/key.pub >> /home/ec2-user/.ssh/authorized_keys
echo loadgen ready"

ec2/ssm.sh sut "
set -e
aws s3 cp --quiet s3://$BUCKET/lt.tgz /tmp/lt.tgz && tar -xzf /tmp/lt.tgz -C /opt/lt
aws s3 cp --quiet s3://$BUCKET/env /opt/lt/.env
mkdir -p /root/.ssh /opt/lt/results
aws s3 cp --quiet s3://$BUCKET/id_ed25519 /root/.ssh/id_ed25519 && chmod 600 /root/.ssh/id_ed25519
# The databases are dropped and restored; nothing may hold a connection to them.
docker compose stop api-1 api-2 2> /dev/null || true
docker compose up -d --wait postgres valkey
for db in webiny_baseline webiny_alpha_baseline; do
    aws s3 cp --quiet s3://$BUCKET/\$db.dump /tmp/\$db.dump
    docker compose exec -T postgres psql -U postgres -qc \"drop database if exists \$db\" -c \"create database \$db\"
    docker compose exec -T postgres pg_restore -U postgres -d \$db < /tmp/\$db.dump
done
for db in webiny webiny_alpha; do
    docker compose exec -T postgres psql -U postgres -qc \"drop database if exists \$db\" -c \"create database \$db template \${db}_baseline\"
done
docker compose exec -T postgres psql -U postgres -Atc \"select datname from pg_database where not datistemplate order by 1\"
ssh -o StrictHostKeyChecking=accept-new ec2-user@$LOADGEN_IP 'docker ps > /dev/null && echo ssh to loadgen ok'"
