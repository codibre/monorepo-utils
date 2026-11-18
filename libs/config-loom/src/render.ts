import { deepMerge } from './merge';
import { isTextLike } from './util';
import type { CompiledFileEntry, CompiledScope, JsonValue } from './types';

/**
 * The entry scope that generates `file` for this workspace: the first scope
 * whose `include` matches (or has no include) and whose `exclude` does not.
 * A scope's exclude is decisive — once a scope claims a workspace, its
 * exclude removes the file outright, even if a later entry would match.
 */
export function scopeFor(
  entry: CompiledFileEntry,
  workspace: string,
): CompiledScope | null {
  for (const scope of entry.scopes) {
    if (
      scope.include.length === 0 ||
      scope.include.some((re) => re.test(workspace))
    ) {
      if (scope.exclude.some((re) => re.test(workspace))) {
        return null;
      }
      return scope;
    }
  }
  return null;
}

/**
 * Produce the content of `entry` for one workspace directory, or null when
 * no entry scope covers it (the workspace does not get the file).
 *
 * JSON/JSONC: start from the scope's `default` and deep-merge every
 * matching rule in declaration order (deterministic: later rules win on
 * conflicts). Text/TS: the last matching rule replaces the content
 * entirely.
 */
export function renderFile(
  entry: CompiledFileEntry,
  workspace: string,
): string | null {
  const scope = scopeFor(entry, workspace);
  if (scope === null) {
    return null;
  }
  const matches = scope.rules.filter((rule) => rule.regex.test(workspace));

  if (isTextLike(scope.format)) {
    let content: string | null =
      typeof scope.defaultValue === 'string' ? scope.defaultValue : null;
    for (const match of matches) {
      content = match.value as string;
    }
    if (content === null) {
      return null;
    }
    return scope.banner ? `${scope.banner}\n${content}` : content;
  }

  let merged: JsonValue = scope.defaultValue;
  for (const match of matches) {
    merged = deepMerge(merged, match.value, scope.arrays);
  }
  const body = `${JSON.stringify(merged, null, 2)}\n`;
  return scope.banner ? `${scope.banner}\n${body}` : body;
}

/**
 * The exact byte sequences a sync could have written for this file when no
 * scope opted out: every scope's `default` render plus one render per rule
 * as if it alone had matched (banner included). Sync uses this to prove
 * authorship of a file it must delete after a scope change, where no banner
 * is present.
 */
export function renderCandidates(entry: CompiledFileEntry): string[] {
  const out: string[] = [];
  for (const scope of entry.scopes) {
    if (isTextLike(scope.format)) {
      const wrap = (c: string) => (scope.banner ? `${scope.banner}\n${c}` : c);
      if (typeof scope.defaultValue === 'string') {
        out.push(wrap(scope.defaultValue));
      }
      for (const rule of scope.rules) {
        if (typeof rule.value === 'string') out.push(wrap(rule.value));
      }
      continue;
    }
    const wrap = (v: JsonValue) => {
      const body = `${JSON.stringify(v, null, 2)}\n`;
      return scope.banner ? `${scope.banner}\n${body}` : body;
    };
    const base = scope.defaultValue;
    out.push(wrap(base));
    for (const rule of scope.rules) {
      out.push(wrap(deepMerge(base, rule.value, scope.arrays)));
    }
  }
  return out;
}
