#!/usr/bin/env bash
# Boots the RakshaWave backend (fleet simulator + API) and serves the
# live dashboard. Open http://localhost:8000 once it's running.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
pip install -q -r requirements.txt

echo "Starting RakshaWave API + simulator on http://localhost:8000 ..."
uvicorn software.api.server:app --host 0.0.0.0 --port 8000
