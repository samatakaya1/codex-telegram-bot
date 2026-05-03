$ErrorActionPreference = "Stop"

$venvPython = ".local/voice/faster-whisper/.venv/Scripts/python.exe"
$modelDir = ".local/voice/models/faster-whisper-large-v3"
$repoId = "Systran/faster-whisper-large-v3"

if (-not (Test-Path $venvPython)) {
  throw "Missing faster-whisper venv. Run npm run voice:setup first."
}

New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

& $venvPython -c @"
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id='$repoId',
    local_dir=r'$modelDir',
    local_dir_use_symlinks=False,
)
print('Downloaded $repoId model to the local voice model directory.')
"@
