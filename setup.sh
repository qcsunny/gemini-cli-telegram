#!/bin/bash
# ------------------------------------------------------------------------------
# gemini-cli-telegram — All-in-One Setup (local project, systemd-managed)
# ------------------------------------------------------------------------------
set -e

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

echo -e "${BLUE}=== gemini-cli-telegram Setup ===${NC}\n"

# Detect OS
if [ -f /etc/debian_version ]; then OS="debian"
elif [ -f /etc/redhat-release ] || [ -f /etc/centos-release ] || [ -f /etc/fedora-release ]; then OS="rhel"
else OS="unknown"; fi

# 1. Node.js 22+
echo -e "${YELLOW}[1/4] Checking Node.js...${NC}"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_BIN="$(ls -d "$HOME/.nvm/versions/node"/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
NODE_MAJOR=0
if [ -n "$NODE_BIN" ]; then
  NODE_MAJOR="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//; s/\..*//')"
  NODE_MAJOR="${NODE_MAJOR:-0}"
fi
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Installing Node.js 22..."
  if [ "$OS" == "debian" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif [ "$OS" == "rhel" ]; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo dnf install -y nodejs || sudo yum install -y nodejs
  else
    echo -e "${RED}Unsupported OS. Install Node.js 22+ manually.${NC}"; exit 1
  fi
  NODE_BIN="$(command -v node)"
fi
echo -e "Using Node: ${GREEN}$($NODE_BIN -v)${NC} ($NODE_BIN)"

# 2. Install deps + build (local project — NOT published to npm)
echo -e "${YELLOW}[2/4] Installing dependencies & building...${NC}"
npm install --legacy-peer-deps
npm run build

# 3. Interactive setup (Google auth + Telegram token -> config.json)
echo -e "${YELLOW}[3/4] Configuration & Authentication...${NC}"
echo -e "${BLUE}This will guide you through Google Login and Telegram Bot setup.${NC}"
exec < /dev/tty
"$NODE_BIN" dist/cli.js setup

# 4. Install systemd service (user-space — no root, see README "Deployment")
echo -e "${YELLOW}[4/4] Installing systemd user service...${NC}"
WORKDIR="$(pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/gemini-cli-telegram.service" <<UNIT
[Unit]
Description=Gemini CLI Telegram Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=$WORKDIR
ExecStart=$NODE_BIN dist/cli.js start --live
Environment=NODE_ENV=production
Environment=PATH=$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now gemini-cli-telegram.service
# Keep the service running after the SSH session ends.
loginctl enable-linger "$USER" 2>/dev/null || \
  echo -e "${YELLOW}Note: could not enable linger; the bot may stop when you log out.${NC}"

echo -e "\n${GREEN}=== Setup Complete ===${NC}"
echo -e "Status:  ${BLUE}systemctl --user status gemini-cli-telegram.service${NC}"
echo -e "Restart: ${BLUE}systemctl --user restart gemini-cli-telegram.service${NC}"
echo -e "Logs:    ${BLUE}tail -f $WORKDIR/logs/daemon.log${NC}   (the app writes its own pino log there, not journald)"
