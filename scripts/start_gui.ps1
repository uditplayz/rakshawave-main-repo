# Opens the RakshaWave test bench in your browser (http://127.0.0.1:8765).
# Optional: $env:WOKWI_CLI_TOKEN = "..." first, or paste the token into the page.
Set-Location (Split-Path $PSScriptRoot -Parent)
$py = if (Test-Path ".venv\Scripts\python.exe") { ".venv\Scripts\python.exe" } else { "python" }
& $py hardware\gui\app.py
