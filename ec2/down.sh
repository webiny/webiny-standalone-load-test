#!/usr/bin/env bash
# Removes everything ec2/up.sh created (ids from ec2/state.env), the bucket's contents included.
# Pull results first (ec2/pull.sh).
set -uo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source state.env
export AWS_REGION
aws ec2 terminate-instances --instance-ids "$SUT" "$LOADGEN" > /dev/null
aws ec2 wait instance-terminated --instance-ids "$SUT" "$LOADGEN"
aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
aws iam delete-instance-profile --instance-profile-name "$ROLE"
aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role-policy --role-name "$ROLE" --policy-name bucket
aws iam delete-role --role-name "$ROLE"
aws s3 rb "s3://$BUCKET" --force > /dev/null
aws ec2 delete-security-group --group-id "$SG"
aws ec2 delete-subnet --subnet-id "$SUBNET"
aws ec2 delete-route-table --route-table-id "$RTB"
aws ec2 detach-internet-gateway --internet-gateway-id "$IGW" --vpc-id "$VPC"
aws ec2 delete-internet-gateway --internet-gateway-id "$IGW"
aws ec2 delete-vpc --vpc-id "$VPC" && mv state.env "state.env.deleted-$(date +%Y%m%d-%H%M%S)"
echo "removed"
