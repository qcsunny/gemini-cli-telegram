#!/bin/bash
# Build (if needed) and (re)start the bot via systemd.
set -e
if [ ! -d dist ]; then npm run build; fi
sudo systemctl restart gemini-telegram.service
echo "Bot restarted. Logs: sudo journalctl -u gemini-telegram -f"
