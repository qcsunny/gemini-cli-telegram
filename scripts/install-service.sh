#!/bin/bash
# Install Gemini CLI Telegram as a systemd service with auto-restart

set -e

PROJECT_DIR=$(pwd)
SERVICE_FILE="/etc/systemd/system/gemini-telegram.service"
NODE_PATH=$(which node)

# Check if we are in the right directory
if [ ! -f "package.json" ]; then
    echo "Error: Please run this script from the project root directory."
    exit 1
fi

echo "Creating systemd service file..."

cat <<EOF > $SERVICE_FILE
[Unit]
Description=Gemini CLI Telegram Bot
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_PATH dist/cli.js start --live
Restart=always
RestartSec=10
StandardOutput=append:$HOME/.gemini-cli-telegram/daemon.log
StandardError=append:$HOME/.gemini-cli-telegram/daemon.log

[Install]
WantedBy=multi-user.target
EOF

echo "Reloading systemd daemon..."
systemctl daemon-reload

echo "Enabling gemini-telegram service..."
systemctl enable gemini-telegram

echo "Stopping any manually started daemon..."
$NODE_PATH dist/cli.js stop || true

echo "Starting gemini-telegram service..."
systemctl start gemini-telegram

echo "Service status:"
systemctl status gemini-telegram --no-pager
