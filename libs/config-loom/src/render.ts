import { deepMerge } from './merge';
import type { CompiledFileEntry, JsonValue } from './types';

/**
 * Produce the content of `entry` for one workspace directory, or null when
 * the workspace opts out: either `default: null` with no matching rule, or a
 * matching rule whose value is `null` (opt-out rule).
 *
 * JSON/JSONC: start from `default` and deep-merge every matching rule in
 * declaration order (deterministic: later rules win on conflicts; a `null`
 * rule suppresses the file, a later non-null rule revives it — but a
 * workspace matching the per-file `exclude` list never gets the file).
 * Text: the last matching rule replaces the content entirely.
 */
export function renderFile(
  entry: CompiledFileEntry,
  workspace: string,
): string | null {
  if (entry.exclude.some((pattern) => pattern.test(workspace))) {
    // Hard per-file opt-out: no file, no matter what default/rules say.
    return null;
  }
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

/**
 * The exact byte sequences a sync could have written for this entry when no
 * opt-out applied: the `default` render plus one render per rule as if it
 * alone had matched (banner included). Sync uses this to prove authorship
 * of a file it must delete after an opt-out, where no banner is present.
 */
export function renderCandidates(entry: CompiledFileEntry): string[] {
  if (entry.format === 'text') {
    const wrap = (c: string) => (entry.banner ? `${entry.banner}\n${c}` : c);
    const out: string[] = [];
    if (typeof entry.defaultValue === 'string') {
      out.push(wrap(entry.defaultValue));
    }
    for (const rule of entry.rules) {
      if (typeof rule.value === 'string') out.push(wrap(rule.value));
    }
    return out;
  }
  const wrap = (v: JsonValue) => {
    const body = `${JSON.stringify(v, null, 2)}\n`;
    return entry.banner ? `${entry.banner}\n${body}` : body;
  };
  const base: JsonValue =
    entry.hasDefault && entry.defaultValue !== null ? entry.defaultValue : {};
  const out: string[] = [wrap(base)];
  for (const rule of entry.rules) {
    if (rule.value === null) continue;
    out.push(wrap(deepMerge(base, rule.value, entry.arrays)));
  }
  return out;
}
