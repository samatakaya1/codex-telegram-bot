import { spawn } from 'node:child_process';
import path from 'node:path';

import type { VoiceTranscriptionConfig } from '../config/env.js';

const DEFAULT_HELPER_PATH = path.join('tools', 'voice', 'faster-whisper', 'transcribe.py');
const MIN_STDOUT_CHARS = 64_000;
const STDOUT_JSON_OVERHEAD_CHARS = 4096;
const MAX_STDERR_CHARS = 64_000;
const INHERITED_HELPER_ENV_KEYS = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMSPEC',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'Path',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR'
];

export type VoiceTranscriptionResult = {
  text: string;
  language?: string;
  durationSeconds?: number;
};

export type VoiceTranscriptionErrorDetails = {
  helperErrorCode?: string;
  helperErrorType?: string;
};

type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RunProcessParams = {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  maxStdoutChars: number;
};

type RunProcess = (params: RunProcessParams) => Promise<ProcessResult>;

type FasterWhisperTranscriberOptions = {
  runProcess?: RunProcess;
  helperPath?: string;
};

export class VoiceTranscriptionError extends Error {
  constructor(
    readonly code: 'helper_failed' | 'invalid_output' | 'empty_transcript',
    message = 'Voice transcription failed. Check local voice setup and try again.',
    readonly details: VoiceTranscriptionErrorDetails = {}
  ) {
    super(message);
    this.name = 'VoiceTranscriptionError';
  }
}

export function createFasterWhisperTranscriber(
  config: VoiceTranscriptionConfig,
  options: FasterWhisperTranscriberOptions = {}
) {
  const runProcess = options.runProcess ?? runProcessWithTimeout;
  const helperPath = options.helperPath ?? DEFAULT_HELPER_PATH;

  return {
    async transcribe(audioPath: string): Promise<VoiceTranscriptionResult> {
      const result = await runProcess({
        command: config.fasterWhisperPython,
        args: [
          helperPath,
          '--audio',
          audioPath,
          '--model',
          config.whisperModelPath,
          '--device',
          config.whisperDevice,
          '--compute-type',
          config.whisperComputeType,
          '--language',
          config.whisperLanguage,
          '--beam-size',
          String(config.whisperBeamSize),
          '--vad-filter',
          String(config.whisperVadFilter)
        ],
        env: { HF_HOME: config.hfHome, PYTHONIOENCODING: 'utf-8' },
        timeoutMs: config.timeoutSeconds * 1000,
        maxStdoutChars: Math.max(MIN_STDOUT_CHARS, config.maxTextChars + STDOUT_JSON_OVERHEAD_CHARS)
      });

      if (result.exitCode !== 0) {
        throw new VoiceTranscriptionError('helper_failed', undefined, parseHelperError(result.stderr));
      }

      const parsed = parseHelperOutput(result.stdout);

      return {
        text: parsed.text.trim(),
        language: parsed.language,
        durationSeconds: parsed.durationSeconds
      };
    }
  };
}

async function runProcessWithTimeout(params: RunProcessParams): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      env: helperProcessEnv(params.env),
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new VoiceTranscriptionError('helper_failed', 'Voice transcription timed out. Please try again.'));
    }, params.timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendLimited(stdout, chunk, params.maxStdoutChars);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = appendLimited(stderr, chunk, MAX_STDERR_CHARS);
    });
    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new VoiceTranscriptionError('helper_failed'));
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      }
    });
  });
}

function appendLimited(current: string, next: string, maxChars: number): string {
  return `${current}${next}`.slice(0, maxChars);
}

function helperProcessEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_HELPER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

function parseHelperError(stderr: string): VoiceTranscriptionErrorDetails {
  const line = stderr
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (line === undefined) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }

  return {
    helperErrorCode: 'errorCode' in parsed && typeof parsed.errorCode === 'string' ? parsed.errorCode : undefined,
    helperErrorType: 'errorType' in parsed && typeof parsed.errorType === 'string' ? parsed.errorType : undefined
  };
}

function parseHelperOutput(output: string): VoiceTranscriptionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new VoiceTranscriptionError('invalid_output');
  }

  if (typeof parsed !== 'object' || parsed === null || !('text' in parsed) || typeof parsed.text !== 'string') {
    throw new VoiceTranscriptionError('invalid_output');
  }

  const language = 'language' in parsed && typeof parsed.language === 'string' ? parsed.language : undefined;
  const durationSeconds =
    'durationSeconds' in parsed && typeof parsed.durationSeconds === 'number' && Number.isFinite(parsed.durationSeconds)
      ? parsed.durationSeconds
      : undefined;
  return { text: parsed.text, language, durationSeconds };
}
