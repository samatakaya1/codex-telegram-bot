import argparse
import json
import os
from pathlib import Path
import site
import sys

_DLL_DIRECTORY_HANDLES = []


def configure_stdio():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except AttributeError:
            pass


def parse_args():
    parser = argparse.ArgumentParser(description="Transcribe one audio file with faster-whisper.")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--compute-type", required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--beam-size", required=True, type=int)
    parser.add_argument("--vad-filter", required=True)
    return parser.parse_args()


def add_local_nvidia_dll_directories():
    if os.name != "nt":
        return

    site_dirs = []
    try:
        site_dirs.extend(site.getsitepackages())
    except AttributeError:
        pass

    user_site = site.getusersitepackages()
    if user_site:
        site_dirs.append(user_site)

    for site_dir in dict.fromkeys(site_dirs):
        nvidia_dir = Path(site_dir) / "nvidia"
        for package_name in ("cuda_runtime", "cuda_nvrtc", "cublas", "cudnn"):
            bin_dir = nvidia_dir / package_name / "bin"
            if not bin_dir.is_dir():
                continue
            _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(bin_dir)))
            os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"


def classify_error(exc):
    message = str(exc).lower()
    if "cublas" in message or "cudnn" in message or "cudart" in message or "nvrtc" in message:
        return "cuda_dll_load_failed"
    if isinstance(exc, UnicodeEncodeError):
        return "stdio_encoding_failed"
    if "out of memory" in message:
        return "cuda_out_of_memory"
    if "no such file" in message or "cannot find the file" in message:
        return "audio_file_not_found"
    if "invalid data" in message or "error opening input" in message or "could not open" in message:
        return "audio_decode_failed"
    return "unknown"


def main():
    configure_stdio()
    args = parse_args()
    try:
        add_local_nvidia_dll_directories()
        from faster_whisper import WhisperModel

        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        language = None if args.language == "auto" else args.language
        segments, info = model.transcribe(
            args.audio,
            language=language,
            beam_size=args.beam_size,
            vad_filter=args.vad_filter.lower() == "true",
            temperature=0,
        )
        text = "".join(segment.text for segment in segments).strip()
        print(
            json.dumps(
                {
                    "text": text,
                    "language": getattr(info, "language", None),
                    "durationSeconds": getattr(info, "duration", None),
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {
                    "error": "transcription_failed",
                    "errorType": type(exc).__name__,
                    "errorCode": classify_error(exc),
                }
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
