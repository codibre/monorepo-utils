import { deepMerge } from './merge';
import { yamlCanonicalText } from './yamlformat';
import { isTextLike } from './util';
import type { CompiledFileEntry, CompiledScope, JsonValue } from './types';

/**
 * `{{root}}` placeholder: render expands it per workspace into the relative
 * path walking up to the repo root (one `../` per path segment), so uniform
 * shims that reference a repo-root file — the release-it base config is the
 * canonical case — are stored once in the loom yet stay correct at any
 * workspace nesting depth.
 */
export const ROOT_TOKEN = '{{root}}';

function rootWalk(workspace: string): string {
  const depth = workspace.split('/').filter((part) => part !== '').length;
  // no trailing separator: templates write `{{root}}/file`, so `..`,`../..`
  return depth === 0 ? '.' : '../'.repeat(depth).slice(0, -1);
}

function applyRootToken(body: string, workspace: string): string {
  return body.includes(ROOT_TOKEN)
    ? body.split(ROOT_TOKEN).join(rootWalk(workspace))
    : body;
}

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
    return applyRootToken(
      scope.banner ? `${scope.banner}\n${content}` : content,
      workspace,
    );
  }

  let merged: JsonValue = scope.defaultValue;
  for (const match of matches) {
    merged = deepMerge(merged, match.value, scope.arrays);
  }
  const body =
    scope.format === 'yaml'
      ? yamlCanonicalText(merged)
      : `${JSON.stringify(merged, null, 2)}\n`;
  return applyRootToken(
    scope.banner ? `${scope.banner}\n${body}` : body,
    workspace,
  );
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
      const body =
        scope.format === 'yaml'
          ? yamlCanonicalText(v)
          : `${JSON.stringify(v, null, 2)}\n`;
      return scope.banner ? `${scope.banner}\n${body}` : body;
    };
    const base = scope.defaultValue;
    out.push(wrap(base));
    for (const rule of scope.rules) {
      out.push(wrap(deepMerge(base, rule.value, scope.arrays)));
    }
  }
  // Tokenized candidates cannot be rendered without a workspace: expand
  // depths 1..4 so delete-authorship proof still matches files written to
  // real (nested) workspaces. Deeper nesting simply falls back to the
  // conservative "unprovable, keep on disk" path.
  const expanded: string[] = [];
  for (const candidate of out) {
    expanded.push(candidate);
    if (candidate.includes(ROOT_TOKEN)) {
      for (let depth = 1; depth <= 4; depth += 1) {
        expanded.push(
          candidate.split(ROOT_TOKEN).join('../'.repeat(depth).slice(0, -1)),
        );
      }
    }
  }
  return expanded;
}
