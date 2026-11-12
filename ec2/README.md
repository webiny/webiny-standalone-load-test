# Running the load tests on EC2

On this Mac the containers share CPUs with everything else running on it, and the same build broke
at 150 req/s in one run and 50 in another (REPORT.md, "Ramp breaking points move with the host").
On EC2 the stack gets a host of its own and k6 a second one.

| instance | type | runs |
| --- | --- | --- |
| sut | c7g.2xlarge (8 Graviton cores, no SMT) | Postgres, Valkey, nginx, both API processes, admin; each pinned to cores of its own (`compose.ec2.yml`), same `cpus` and memory limits as locally |
| loadgen | c7g.xlarge | k6 (`compose.loadgen.yml`), started by `scripts/run.sh` over SSH |

A VPC of its own (10.88.0.0/16), one public subnet, a security group that lets the two instances
reach each other and nothing in from outside. Access is through SSM (`aws ssm send-command`), so no
SSH from here and no session-manager-plugin. Roughly $0.45 an hour for both instances.

```
AWS_PROFILE=default ec2/up.sh      # VPC, bucket, IAM role, both instances; ids in ec2/state.env
ec2/push.sh                        # setup, builds, .env and database baselines to both instances
ec2/ssm.sh sut 'scripts/run.sh read-ramp ramp.js -e SCENARIO=read -e START=20 -e STEP=20'
ec2/ssm.sh sut 'ROUNDS=3 scripts/ab.sh read-ramp ramp.js -e SCENARIO=read -e START=20 -e STEP=20'
ec2/pull.sh                        # the sut's results/ into results/
ec2/down.sh                        # removes everything up.sh made, the bucket included
```

`scripts/ab.sh` runs the same ramp for the source build and the published alpha in turn, each on
its own database reset from its baseline, so both builds see the same conditions. Long runs: start
them detached (`nohup setsid ... &`) and poll, since an SSM command stops when it times out.

Every run's `meta.txt` has a `host:` line, and `stats.csv` a `host` row with the load average
every 5 s, so EC2 and local runs can be told apart.

Not moved to EC2: the SQLite stack (`compose.sqlite.yml`), and the side clients of scenarios 3
and 4 run on the sut (pinned to core 7), not on the loadgen.
