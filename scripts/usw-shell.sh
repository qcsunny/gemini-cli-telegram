#!/bin/bash
# Wrapper script to execute commands as a specific user using usw
# This ensures shell commands run in the correct user context

set -euo pipefail

# Get the target user from environment variable
TARGET_USER="${GEMINI_TELEGRAM_USER:-root}"

# If no user specified or user is root, execute directly
if [ "$TARGET_USER" = "root" ] || [ -z "$TARGET_USER" ]; then
    exec "$@"
fi

# Use usw to switch to the target user and execute the command
exec usw "$TARGET_USER" "$@"
