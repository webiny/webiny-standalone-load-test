#!/usr/bin/env bash
# Creates the EC2 setup for the load tests and records every id in ec2/state.env, so ec2/down.sh
# removes exactly what this made:
#   - a VPC of its own (10.88.0.0/16) with one public subnet; the security group lets the two
#     instances reach each other and nothing in from outside. Access is through SSM only.
#   - an S3 bucket to move the setup, builds and database baselines across, and results back.
#   - sut: c7g.2xlarge (8 Graviton cores, no SMT) for Postgres, Valkey, nginx and both API
#     processes, each pinned to its own cores (compose.ec2.yml).
#   - loadgen: c7g.xlarge for k6, so the load generator never competes with what it measures.
# Graviton, because the API builds were made for, and have run on, arm64 Linux.
#   AWS_PROFILE=default ec2/up.sh
set -euo pipefail
cd "$(dirname "$0")"
export AWS_REGION=${AWS_REGION:-eu-central-1}
state=state.env
[ -f "$state" ] && { echo "ec2/state.env exists: the setup is up already (ec2/down.sh first)"; exit 1; }

tag="webiny-standalone-load-test"
tags() { echo "ResourceType=$1,Tags=[{Key=Name,Value=$tag-$2},{Key=Project,Value=$tag}]"; }
save() { echo "$1=$2" >> "$state"; }

account=$(aws sts get-caller-identity --query Account --output text)
save AWS_REGION "$AWS_REGION"

vpc=$(aws ec2 create-vpc --cidr-block 10.88.0.0/16 --tag-specifications "$(tags vpc vpc)" --query Vpc.VpcId --output text)
save VPC "$vpc"
aws ec2 modify-vpc-attribute --vpc-id "$vpc" --enable-dns-hostnames
igw=$(aws ec2 create-internet-gateway --tag-specifications "$(tags internet-gateway igw)" --query InternetGateway.InternetGatewayId --output text)
save IGW "$igw"
aws ec2 attach-internet-gateway --vpc-id "$vpc" --internet-gateway-id "$igw"
subnet=$(aws ec2 create-subnet --vpc-id "$vpc" --cidr-block 10.88.1.0/24 --availability-zone "${AWS_REGION}a" \
    --tag-specifications "$(tags subnet subnet)" --query Subnet.SubnetId --output text)
save SUBNET "$subnet"
aws ec2 modify-subnet-attribute --subnet-id "$subnet" --map-public-ip-on-launch
rtb=$(aws ec2 create-route-table --vpc-id "$vpc" --tag-specifications "$(tags route-table rtb)" --query RouteTable.RouteTableId --output text)
save RTB "$rtb"
aws ec2 create-route --route-table-id "$rtb" --destination-cidr-block 0.0.0.0/0 --gateway-id "$igw" > /dev/null
aws ec2 associate-route-table --route-table-id "$rtb" --subnet-id "$subnet" > /dev/null
# No inbound rule from outside: the public IPs are only for outbound (packages, images, SSM).
sg=$(aws ec2 create-security-group --vpc-id "$vpc" --group-name "$tag" --description "$tag: instances to each other only" \
    --tag-specifications "$(tags security-group sg)" --query GroupId --output text)
save SG "$sg"
aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol -1 --source-group "$sg" > /dev/null

bucket="$tag-$account-$(openssl rand -hex 3)"
aws s3api create-bucket --bucket "$bucket" --create-bucket-configuration LocationConstraint="$AWS_REGION" > /dev/null
aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
save BUCKET "$bucket"

role="$tag-ec2"
aws iam create-role --role-name "$role" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' > /dev/null
save ROLE "$role"
aws iam attach-role-policy --role-name "$role" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam put-role-policy --role-name "$role" --policy-name bucket --policy-document \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:ListBucket\"],\"Resource\":[\"arn:aws:s3:::$bucket\",\"arn:aws:s3:::$bucket/*\"]}]}"
aws iam create-instance-profile --instance-profile-name "$role" > /dev/null
aws iam add-role-to-instance-profile --instance-profile-name "$role" --role-name "$role"
# A new instance profile takes a few seconds before EC2 accepts it.
sleep 15

ami=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
userdata=$(base64 < userdata.sh)
launch() {
    aws ec2 run-instances --image-id "$ami" --instance-type "$1" --subnet-id "$subnet" --security-group-ids "$sg" \
        --iam-instance-profile Name="$role" --user-data "$userdata" \
        --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=40,VolumeType=gp3,DeleteOnTermination=true}' \
        --metadata-options HttpTokens=required \
        --tag-specifications "$(tags instance "$2")" --query 'Instances[0].InstanceId' --output text
}
sut=$(launch c7g.2xlarge sut)
save SUT "$sut"
loadgen=$(launch c7g.xlarge loadgen)
save LOADGEN "$loadgen"
aws ec2 wait instance-running --instance-ids "$sut" "$loadgen"
ip() { aws ec2 describe-instances --instance-ids "$1" --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text; }
save SUT_IP "$(ip "$sut")"
save LOADGEN_IP "$(ip "$loadgen")"
cat "$state"
