#!/usr/bin/env bash
# Starts the evaluation backend on macOS or Linux; the first run creates backend/.venv and installs the pinned packages.
#   scripts/backend.sh [port]
set -euo pipefail
cd "$(dirname "$0")/../backend"
PORT="${1:-8000}"
if [ ! -x .venv/bin/python ]; then
  command -v uv >/dev/null || { echo "uv not found. Install it: https://docs.astral.sh/uv/" >&2; exit 1; }
  uv venv .venv --python 3.12
  # macOS wheels come from PyPI; Linux without an NVIDIA GPU takes the CPU wheels
  INDEX=()
  if [ "$(uname)" = Linux ]; then
    if command -v nvidia-smi >/dev/null; then INDEX=(--index-url https://download.pytorch.org/whl/cu128); else INDEX=(--index-url https://download.pytorch.org/whl/cpu); fi
  fi
  uv pip install --python .venv/bin/python torch==2.11.0 torchvision==0.26.0 ${INDEX[@]+"${INDEX[@]}"}
  uv pip install --python .venv/bin/python -r requirements-gantrylab.txt
fi
exec .venv/bin/python -m uvicorn gantrylab.app:app --host 127.0.0.1 --port "$PORT"
