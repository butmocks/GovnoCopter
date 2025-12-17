#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"

HOST="$(python3 -c 'import json; print(json.load(open("config.json","r",encoding="utf-8")).get("server_host","0.0.0.0"))')"
PORT="$(python3 -c 'import json; print(json.load(open("config.json","r",encoding="utf-8")).get("server_port",8000))')"

exec uvicorn backend.main:app --reload --host "$HOST" --port "$PORT"
