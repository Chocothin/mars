#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

if [ ! -d "$VENV_DIR" ]; then
  echo "[summarizer] Creating venv..."
  python3 -m venv "$VENV_DIR"
fi

echo "[summarizer] Installing dependencies..."
"$VENV_DIR/bin/pip" install -q -r "$SCRIPT_DIR/requirements.txt"

echo "[summarizer] Pre-downloading model..."
"$VENV_DIR/bin/python" -c "
from transformers import PreTrainedTokenizerFast, BartForConditionalGeneration
m = 'EbanLee/kobart-summary-v3'
PreTrainedTokenizerFast.from_pretrained(m)
BartForConditionalGeneration.from_pretrained(m)
print('[summarizer] Model cached.')
"

echo "[summarizer] Setup complete. Run: $SCRIPT_DIR/start.sh"
