import type { FileFormat, JsonObject, JsonValue } from './types';

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Formats whose value is the whole file, replaced verbatim by rules. */
export function isTextLike(format: FileFormat): boolean {
  return format === 'text' || format === 'ts';
}

/** Formats rendered as canonical JSON — the only ones whose canonical bytes
 * are distinctive enough to prove a generated file's authorship. */
export function isJsonFormat(format: FileFormat): boolean {
  return format === 'json' || format === 'jsonc';
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deterministic serialization: object keys sorted recursively, arrays keep
 * order. Two files that differ only by key order hash the same — that is the
 * point when clustering config files by content.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
    )
    .join(',')}}`;
}

export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Text normalization used for clustering and hashing non-JSON files:
 * CRLF -> LF, trailing whitespace stripped, exactly one final newline.
 */
export function normalizeText(text: string): string {
  const body = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n+$/s, '');
  return `${body}\n`;
}
