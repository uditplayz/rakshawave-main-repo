#!/usr/bin/env bash
# Opens the RakshaWave test bench in your browser (http://127.0.0.1:8765).
cd "$(dirname "$0")/.." || exit 1
if [ -x .venv/bin/python ]; then exec .venv/bin/python hardware/gui/app.py; fi
if [ -x .venv/Scripts/python.exe ]; then exec .venv/Scripts/python.exe hardware/gui/app.py; fi
exec python3 hardware/gui/app.py
