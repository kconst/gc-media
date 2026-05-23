#!/bin/bash
# Idempotent provisioning for the gc-media processor instance. Installs Node,
# a static ffmpeg, and Caddy; fetches secrets from SSM; writes the env file;
# and runs the control panel behind Caddy (auto-HTTPS) as systemd services.
#
# Re-run safely after editing config:  sudo bash /opt/gc-media/infra/processor/setup.sh
set -euo pipefail

# Load deploy config written by first boot (region, host, prefix, repo dir...).
if [ -f /etc/gc-media.deploy ]; then
  # shellcheck disable=SC1091
  . /etc/gc-media.deploy
fi
: "${GC_REGION:?set GC_REGION}"
: "${GC_SSM_PREFIX:?set GC_SSM_PREFIX}"
: "${GC_PANEL_USER:?set GC_PANEL_USER}"
: "${GC_PANEL_HOST:?set GC_PANEL_HOST}"
: "${GC_REPO_DIR:=/opt/gc-media}"

NODE_VERSION="v22.11.0"
CADDY_VERSION="2.8.4"

echo "== installing base packages =="
dnf install -y tar xz git

echo "== installing Node ${NODE_VERSION} =="
if ! /usr/local/bin/node --version 2>/dev/null | grep -q "${NODE_VERSION}"; then
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz
  rm -rf /usr/local/lib/nodejs && mkdir -p /usr/local/lib/nodejs
  tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs --strip-components=1
  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm
  ln -sf /usr/local/lib/nodejs/bin/npx /usr/local/bin/npx
fi

echo "== installing static ffmpeg =="
if ! /usr/local/bin/ffmpeg -version >/dev/null 2>&1; then
  curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" -o /tmp/ffmpeg.tar.xz
  mkdir -p /tmp/ffmpeg && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1
  install -m 0755 /tmp/ffmpeg/ffmpeg /usr/local/bin/ffmpeg
  install -m 0755 /tmp/ffmpeg/ffprobe /usr/local/bin/ffprobe
fi

echo "== installing Caddy ${CADDY_VERSION} =="
if ! /usr/local/bin/caddy version 2>/dev/null | grep -q "v${CADDY_VERSION}"; then
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" -o /tmp/caddy.tgz
  tar -xzf /tmp/caddy.tgz -C /tmp caddy
  install -m 0755 /tmp/caddy /usr/local/bin/caddy
fi

echo "== fetching secrets from SSM (${GC_SSM_PREFIX}) =="
# Tolerant: a missing parameter yields an empty value rather than aborting, so
# the panel still comes up (uploads/placement/browse work; AI ingest needs the
# Anthropic key, the placement map needs the Maps key).
ssm() { aws ssm get-parameter --region "$GC_REGION" --name "${GC_SSM_PREFIX}/$1" --with-decryption --query Parameter.Value --output text 2>/dev/null || true; }
ANTHROPIC_API_KEY=$(ssm ANTHROPIC_API_KEY)
MAPS_API_KEY=$(ssm GOOGLE_MAPS_API_KEY)
MAPS_MAP_ID=$(ssm GOOGLE_MAPS_MAP_ID)
PANEL_PASSWORD=$(ssm PANEL_PASSWORD)

# Bucket + CloudFront are read from SSM too (set them as plain String params).
MEDIA_BUCKET=$(ssm MEDIA_BUCKET)
CLOUDFRONT_DOMAIN=$(ssm CLOUDFRONT_DOMAIN)

echo "== writing /etc/gc-media.env =="
umask 077
cat > /etc/gc-media.env <<EOF
NODE_ENV=production
GC_DATA_DIR=/var/lib/gc-media
AWS_REGION=${GC_REGION}
MEDIA_BUCKET=${MEDIA_BUCKET}
CLOUDFRONT_DOMAIN=${CLOUDFRONT_DOMAIN}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=${MAPS_API_KEY}
NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=${MAPS_MAP_ID}
PANEL_USER=${GC_PANEL_USER}
PANEL_PASSWORD=${PANEL_PASSWORD}
PATH=/usr/local/bin:/usr/bin:/bin
EOF
umask 022
mkdir -p /var/lib/gc-media

echo "== installing dependencies =="
cd "$GC_REPO_DIR"
/usr/local/bin/npm install --no-audit --no-fund

echo "== writing systemd units =="
cat > /etc/systemd/system/gc-panel.service <<EOF
[Unit]
Description=gc-media control panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${GC_REPO_DIR}
EnvironmentFile=/etc/gc-media.env
ExecStart=/usr/local/bin/npm start --workspace @gc-media/loader -- serve --port 4321
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# Caddy: TLS termination + reverse proxy to the local panel. The panel itself
# enforces basic auth, so Caddy just needs to forward.
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
${GC_PANEL_HOST} {
	reverse_proxy 127.0.0.1:4321
}
EOF

id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

echo "== starting services =="
systemctl daemon-reload
systemctl enable --now gc-panel.service
systemctl enable --now caddy.service

echo "== done. Panel: https://${GC_PANEL_HOST} =="
