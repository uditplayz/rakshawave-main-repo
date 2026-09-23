# Boots the RakshaWave backend (fleet simulator + API) and serves the
# live dashboard. Open http://localhost:8000 once it's running.

$ErrorActionPreference = "Stop"

# Change directory to the repository root
Set-Location -Path "$PSScriptRoot\.."

if (-not (Test-Path -Path ".venv")) {
    python -m venv .venv
}

# Activate the virtual environment in PowerShell
. .venv\Scripts\Activate.ps1

pip install -r requirements.txt

Write-Output "Starting RakshaWave API + simulator on http://localhost:8000 ..."
uvicorn software.api.server:app --host 0.0.0.0 --port 8000
