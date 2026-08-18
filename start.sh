#!/bin/bash
# Build (if needed) and (re)start the bot via user-space systemd.
# The service runs dist/cli.js, so src/ changes need `npm run build` first —
# this only builds when dist/ is missing entirely.
set -e
if [ ! -d dist ]; then npm run build; fi
systemctl --user restart gemini-cli-telegram.service
echo "Bot restarted. Logs: tail -f logs/daemon.log"
