#!/bin/bash
# Load .env if it exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi
exec node dist/cli.js start
