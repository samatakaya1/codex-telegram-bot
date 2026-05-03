$ErrorActionPreference = "Stop"

$venvPython = ".local/voice/faster-whisper/.venv/Scripts/python.exe"
$modelDir = ".local/voice/models/faster-whisper-large-v3"
$smokeAudio = ".tmp/voice-smoke-tone.wav"

if (-not (Test-Path $venvPython)) {
  throw "Missing faster-whisper venv. Run npm run voice:setup first."
}

if (-not (Test-Path $modelDir)) {
  throw "Missing faster-whisper large-v3 model. Run npm run voice:model:download first."
}

nvidia-smi --query-gpu=name,driver_version,memory.total,compute_cap --format=csv

& $venvPython -c @"
import ctranslate2
from faster_whisper import WhisperModel
print('cuda devices', ctranslate2.get_cuda_device_count())
model = WhisperModel(r'$modelDir', device='cuda', compute_type='float16')
print('large-v3 cuda float16 load ok')
"@

New-Item -ItemType Directory -Force -Path (Split-Path $smokeAudio) | Out-Null

& $venvPython -c @"
import math
import struct
import wave

sample_rate = 16000
seconds = 1
frequency = 440.0

with wave.open(r'$smokeAudio', 'wb') as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(sample_rate)
    for i in range(sample_rate * seconds):
        sample = int(0.2 * 32767 * math.sin(2 * math.pi * frequency * i / sample_rate))
        wf.writeframes(struct.pack('<h', sample))
"@

$output = & $venvPython tools/voice/faster-whisper/transcribe.py `
  --audio $smokeAudio `
  --model $modelDir `
  --device cuda `
  --compute-type float16 `
  --language auto `
  --beam-size 5 `
  --vad-filter true

if ($LASTEXITCODE -ne 0) {
  throw "faster-whisper transcription smoke failed."
}

$json = $output -join "`n"
$parsed = $json | ConvertFrom-Json
if ($null -eq $parsed -or -not ($parsed.PSObject.Properties.Name -contains "text")) {
  throw "faster-whisper transcription smoke returned invalid JSON."
}

Write-Host "large-v3 cuda float16 transcription ok"
