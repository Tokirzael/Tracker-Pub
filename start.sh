#!/bin/sh
# Character Tracker standalone launcher (Linux/macOS)
cd "$(dirname "$0")" || exit 1
PORT="${CT_PORT:-5173}"
echo "Character Tracker  ->  http://localhost:$PORT"
exec node server.mjs --port "$PORT"
