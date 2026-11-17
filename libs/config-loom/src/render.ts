import { deepMerge } from './merge';
import type { CompiledFileEntry, JsonValue } from './types';

/**
 * Produce the content of `entry` for one workspace directory, or null when
 * the entry opts out (default: null) and no rule matches.
 *
 * JSON/JSONC: start from `default` and deep-merge every matching rule in
 * declaration order (deterministic: later rules win on conflicts).
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
      typeof entry.defaultValue === 'string' ? entry.defaultValue : '';
    for (const match of matches) {
      content = match.value as string;
    }
    return entry.banner ? `${entry.banner}\n${content}` : content;
  }

  let merged: JsonValue =
    entry.hasDefault && entry.defaultValue !== null ? entry.defaultValue : {};
  for (const match of matches) {
    merged = deepMerge(merged, match.value, entry.arrays);
  }
  const body = `${JSON.stringify(merged, null, 2)}\n`;
  return entry.banner ? `${entry.banner}\n${body}` : body;
}
