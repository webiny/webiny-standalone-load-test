#!/bin/bash
# First boot of both instances: Docker with the compose plugin, the images the stack uses, and a
# `node` command that runs Node in a container (the helper scripts call `node`).
set -euxo pipefail
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user
mkdir -p /usr/libexec/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-aarch64 \
    -o /usr/libexec/docker/cli-plugins/docker-compose
chmod +x /usr/libexec/docker/cli-plugins/docker-compose
cat > /usr/local/bin/node <<'EOF'
#!/bin/sh
exec docker run --rm -i --network host -v "$PWD:$PWD" -w "$PWD" node:24-slim node "$@"
EOF
chmod +x /usr/local/bin/node
for image in postgres:17 valkey/valkey:8 nginx:1.27-alpine node:24-slim grafana/k6:latest; do
    docker pull "$image"
done
touch /var/lib/lt-ready
