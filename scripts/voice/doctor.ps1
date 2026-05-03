$ErrorActionPreference = "Stop"

Write-Host "Checking local voice transcription prerequisites..."

function Test-Command($Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    Write-Host "[missing] $Name"
    return $false
  }
  Write-Host "[ok] $Name"
  return $true
}

$ok = $true
$ok = (Test-Command "node") -and $ok
$ok = (Test-Command "python") -and $ok
$hasNvidiaSmi = Test-Command "nvidia-smi"
$ok = $hasNvidiaSmi -and $ok

if ($hasNvidiaSmi) {
  nvidia-smi --query-gpu=name,driver_version,memory.total,compute_cap --format=csv
}

if (Test-Path ".local/voice/faster-whisper/.venv/Scripts/python.exe") {
  & ".local/voice/faster-whisper/.venv/Scripts/python.exe" -c @"
import site
from pathlib import Path

import faster_whisper
import ctranslate2

print('faster-whisper ok')
cuda_devices = ctranslate2.get_cuda_device_count()
print('cuda devices', cuda_devices)
if cuda_devices < 1:
    print('[missing] CUDA device visible to ctranslate2')
    raise SystemExit(1)

required = {
    'cuda_runtime': 'cudart64_12.dll',
    'cuda_nvrtc': 'nvrtc64_120_0.dll',
    'cublas': 'cublas64_12.dll',
    'cudnn': 'cudnn64_9.dll',
}
missing = []
site_dirs = site.getsitepackages()
for package_name, dll_name in required.items():
    found = any((Path(site_dir) / 'nvidia' / package_name / 'bin' / dll_name).exists() for site_dir in site_dirs)
    if not found:
        missing.append(dll_name)

if missing:
    print('[missing] local CUDA DLLs: ' + ', '.join(missing))
    raise SystemExit(1)

print('local CUDA DLLs ok')
"@
  if ($LASTEXITCODE -ne 0) {
    $ok = $false
  }
} else {
  Write-Host "[missing] faster-whisper virtual environment"
  $ok = $false
}

if (-not (Test-Path ".local/voice/models/faster-whisper-large-v3")) {
  Write-Host "[missing] faster-whisper large-v3 model directory"
  $ok = $false
}

if (-not $ok) {
  Write-Host "Voice setup is incomplete. Run npm run voice:setup and npm run voice:model:download."
  exit 1
}

Write-Host "Voice setup prerequisites look available."
