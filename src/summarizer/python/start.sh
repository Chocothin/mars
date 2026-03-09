#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

if [ ! -d "$VENV_DIR" ]; then
  echo "[summarizer] venv not found. Run setup.sh first."
  exit 1
fi

exec "$VENV_DIR/bin/python" "$SCRIPT_DIR/server.py"
