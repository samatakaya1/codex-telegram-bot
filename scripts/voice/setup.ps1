$ErrorActionPreference = "Stop"

$venv = ".local/voice/faster-whisper/.venv"
$requirements = "tools/voice/faster-whisper/requirements.txt"

if (-not (Test-Path $requirements)) {
  throw "Missing $requirements"
}

if (-not (Test-Path $venv)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $venv) | Out-Null
  python -m venv $venv
}

& "$venv/Scripts/python.exe" -m pip install --upgrade pip
& "$venv/Scripts/python.exe" -m pip install -r $requirements

Write-Host "faster-whisper virtual environment is ready."
