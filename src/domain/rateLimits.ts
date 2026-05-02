import type { JsonObject, JsonValue } from '../codex/protocol.js';

type BucketEntry = {
  label: string;
  bucket: JsonObject;
};

type WindowDetails = {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number | string;
};

const WINDOW_KEYS = ['primary', 'secondary'] as const;

export function formatRateLimits(snapshot: JsonValue): string {
  const entries = collectBucketEntries(snapshot);
  const lines: string[] = [];
  let creditsLine: string | null = null;

  for (const entry of entries) {
    for (const windowKey of WINDOW_KEYS) {
      const details = readWindowDetails(entry.bucket[windowKey]);
      if (details === null) {
        continue;
      }

      lines.push(formatWindowLine(entry.label, windowKey, details));
    }

    creditsLine ??= formatCredits(entry.bucket.credits);
  }

  if (creditsLine !== null) {
    lines.push(creditsLine);
  }

  return ['Codex limits:', ...(lines.length === 0 ? ['No rate limit details available yet.'] : lines)].join('\n');
}

function collectBucketEntries(snapshot: JsonValue): BucketEntry[] {
  if (!isObject(snapshot)) {
    return [];
  }

  if (hasRateLimitWindow(snapshot)) {
    return [{ label: bucketLabel(snapshot, 'Current'), bucket: snapshot }];
  }

  const current = snapshot.rateLimits;
  if (isObject(current)) {
    return [{ label: bucketLabel(current, 'Current'), bucket: current }];
  }

  const byLimitId = snapshot.rateLimitsByLimitId;
  if (!isObject(byLimitId)) {
    return [];
  }

  return Object.entries(byLimitId)
    .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
    .map(([limitId, bucket]) => ({
      label: bucketLabel(bucket, limitId),
      bucket
    }));
}

function hasRateLimitWindow(value: JsonObject): boolean {
  return WINDOW_KEYS.some((key) => isObject(value[key]));
}

function readWindowDetails(value: JsonValue | undefined): WindowDetails | null {
  if (!isObject(value)) {
    return null;
  }

  const usedPercent = getNumber(value, 'usedPercent') ?? getNumber(value, 'used_percent');
  if (usedPercent === undefined) {
    return null;
  }

  return {
    usedPercent,
    windowDurationMins:
      getNumber(value, 'windowDurationMins') ??
      getNumber(value, 'windowDurationMinutes') ??
      getNumber(value, 'windowMinutes') ??
      getNumber(value, 'window_minutes'),
    resetsAt:
      getNumber(value, 'resetsAt') ??
      getNumber(value, 'resetAt') ??
      getNumber(value, 'reset_at') ??
      getString(value, 'resetsAt') ??
      getString(value, 'resetAt') ??
      getString(value, 'reset_at')
  };
}

function formatWindowLine(label: string, windowName: string, details: WindowDetails): string {
  const used = clampPercent(details.usedPercent);
  const remaining = clampPercent(100 - used);
  const duration = details.windowDurationMins === undefined ? '' : ` (${formatDuration(details.windowDurationMins)})`;
  const reset = details.resetsAt === undefined ? '' : `; resets ${formatReset(details.resetsAt)}`;

  return `- ${label} ${windowName}${duration}: ${formatPercent(remaining)} remaining, ${formatPercent(used)} used${reset}`;
}

function formatCredits(value: JsonValue | undefined): string | null {
  if (!isObject(value)) {
    return null;
  }

  if (value.unlimited === true) {
    return 'Credits: unlimited';
  }

  const balance = getString(value, 'balance');
  return balance === undefined || balance.trim().length === 0 ? null : `Credits: ${balance.trim()}`;
}

function bucketLabel(bucket: JsonObject, fallback: string): string {
  const limitName = getString(bucket, 'limitName');
  if (limitName !== undefined && limitName.trim().length > 0) {
    return limitName.trim();
  }

  const limitId = getString(bucket, 'limitId');
  return humanizeLabel(limitId ?? fallback);
}

function humanizeLabel(value: string): string {
  const normalized = value.replace(/[_-]+/g, ' ').trim();
  return normalized.length === 0 ? 'Current' : normalized;
}

function formatDuration(minutes: number): string {
  if (Number.isFinite(minutes) && minutes > 0) {
    if (minutes % 1440 === 0) {
      return `${minutes / 1440}d`;
    }

    if (minutes % 60 === 0) {
      return `${minutes / 60}h`;
    }

    return `${minutes}m`;
  }

  return 'unknown window';
}

function formatReset(value: number | string): string {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  const date = new Date(typeof timestamp === 'number' && timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
    date.getUTCHours()
  )}:${pad(date.getUTCMinutes())} UTC`;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, value));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNumber(source: JsonObject, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' ? value : undefined;
}

function getString(source: JsonObject, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}
