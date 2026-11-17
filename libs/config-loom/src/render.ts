import { deepMerge } from './merge';
import type { CompiledFileEntry, JsonValue } from './types';

/**
 * Produce the content of `entry` for one workspace directory, or null when
 * the workspace opts out: either `default: null` with no matching rule, or a
 * matching rule whose value is `null` (opt-out rule).
 *
 * JSON/JSONC: start from `default` and deep-merge every matching rule in
 * declaration order (deterministic: later rules win on conflicts; a `null`
 * rule suppresses the file, a later non-null rule revives it).
 * Text: the last matching rule replaces the content entirely.
 */
export function renderFile(
  entry: CompiledFileEntry,
  workspace: string,
): string | null {
  const matches = entry.rules.filter((rule) => rule.regex.test(workspace));
  if (
    matches.length === 0 &&
    (!entry.hasDefault || entry.defaultValue === null)
  ) {
    // No default (or `default: null` opt-in mode) and nothing matched.
    return null;
  }

  if (entry.format === 'text') {
    let content =
      typeof entry.defaultValue === 'string' ? entry.defaultValue : null;
    for (const match of matches) {
      content = match.value === null ? null : (match.value as string);
    }
    if (content === null) {
      return null;
    }
    return entry.banner ? `${entry.banner}\n${content}` : content;
  }

  let merged: JsonValue =
    entry.hasDefault && entry.defaultValue !== null ? entry.defaultValue : {};
  let suppressed = false;
  for (const match of matches) {
    if (match.value === null) {
      suppressed = true;
      continue;
    }
    suppressed = false;
    merged = deepMerge(merged, match.value, entry.arrays);
  }
  if (suppressed) {
    return null;
  }
  const body = `${JSON.stringify(merged, null, 2)}\n`;
  return entry.banner ? `${entry.banner}\n${body}` : body;
}
