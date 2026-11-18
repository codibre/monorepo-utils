import { deepEqual } from './util';
import type { JsonValue } from './types';

export interface DeltaResult {
  /**
   * `delta` can be expressed as a merge patch; `full` means the target cannot
   * be reached by merging (a key present in the default is missing from the
   * target), so the rule must carry the complete content.
   */
  kind: 'delta' | 'full';
  value: JsonValue;
}

/**
 * Comparison used to decide a subtree is unchanged. Defaults to strict
 * `deepEqual`; callers may pass a semantic comparator so equivalent values
 * (e.g. `./dist` and `dist` in a tsconfig) collapse into the default.
 * `key` names the property the two values sit under in their parent object
 * (`undefined` for the root), so comparators can be context-aware.
 */
export type Equal = (a: JsonValue, b: JsonValue, key?: string) => boolean;

function isEmptyPatch(value: JsonValue): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function deltaOf(
  base: JsonValue,
  target: JsonValue,
  same: Equal,
  parentKey: string | undefined,
): DeltaResult {
  if (same(base, target, parentKey)) {
    return { kind: 'delta', value: {} };
  }
  const baseIsObject =
    typeof base === 'object' && base !== null && !Array.isArray(base);
  const targetIsObject =
    typeof target === 'object' && target !== null && !Array.isArray(target);
  if (baseIsObject && targetIsObject) {
    const baseObj = base as Record<string, JsonValue>;
    const targetObj = target as Record<string, JsonValue>;
    const patch: Record<string, JsonValue> = {};
    for (const key of Object.keys(baseObj)) {
      if (!(key in targetObj)) {
        // JSON Merge Patch (RFC 7386): null removes the inherited key.
        patch[key] = null;
        continue;
      }
      const inner = deltaOf(
        baseObj[key] as JsonValue,
        targetObj[key] as JsonValue,
        same,
        key,
      );
      if (inner.kind === 'full') {
        return { kind: 'full', value: target };
      }
      if (!isEmptyPatch(inner.value)) {
        patch[key] = inner.value;
      }
    }
    for (const key of Object.keys(targetObj)) {
      if (!(key in baseObj)) {
        patch[key] = targetObj[key] as JsonValue;
      }
    }
    return { kind: 'delta', value: patch };
  }
  // Scalars or arrays that differ: the patch simply overrides the value
  // (deep-merge always lets the patch win on non-object values).
  return { kind: 'delta', value: target };
}

/**
 * Compute the minimal merge patch that turns `base` into `target`
 * (RFC 7386: nulls remove keys), or signal that the full value is required.
 * `same` overrides the equality test used to skip unchanged subtrees.
 */
export function computeDelta(
  base: JsonValue,
  target: JsonValue,
  same: Equal = deepEqual,
): DeltaResult {
  return deltaOf(base, target, same, undefined);
}

/**
 * Normalize one tsconfig-ish path string for comparison: `./dist` addresses
 * the same directory as `dist`, and a directory followed by a recursive glob
 * (double-star, slash, star) includes exactly what the bare `dir` entry
 * includes, because TypeScript expands directories recursively.
 */
function normalizePathish(value: string): string {
  let out = value;
  if (out.startsWith('./')) {
    out = out.slice(2);
  }
  if (out.endsWith('/**/*')) {
    out = out.slice(0, -'/**/*'.length) || '.';
  }
  return out;
}

/**
 * Path-array keys TypeScript resolves as **sets**: the glob inventory matters,
 * the declaration order does not — `['src', 'test']` and `['test', 'src']`
 * compile the exact same file set.
 */
const PATH_SET_KEYS = new Set(['include', 'exclude', 'files']);

function normalizeTsPaths(value: JsonValue, key?: string): JsonValue {
  if (typeof value === 'string') {
    return normalizePathish(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => normalizeTsPaths(item));
    if (key !== undefined && PATH_SET_KEYS.has(key)) {
      const paths = items.filter((i): i is string => typeof i === 'string');
      if (paths.length === items.length) {
        // order- and duplicate-insensitive multiset comparison
        return [...new Set(paths)].sort();
      }
    }
    return items;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const [k, inner] of Object.entries(value)) {
      out[k] = normalizeTsPaths(inner, k);
    }
    return out;
  }
  return value;
}

/**
 * Semantic equality for tsconfig/jsconfig values: strings that only differ by
 * a leading `./` or a trailing recursive glob describe the same path, so a
 * rule repeating `dist` where the default says `./dist` carries no
 * information; and `include`/`exclude`/`files` arrays are sets — same blobs in
 * a different order (or with a duplicate entry) is the same file inventory.
 * The set reading applies only to arrays of strings; anything else keeps
 * order-sensitive comparison.
 */
export function tsconfigEqual(
  a: JsonValue,
  b: JsonValue,
  key?: string,
): boolean {
  return deepEqual(normalizeTsPaths(a, key), normalizeTsPaths(b, key));
}
