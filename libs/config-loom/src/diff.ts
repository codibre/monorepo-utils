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
 */
export type Equal = (a: JsonValue, b: JsonValue) => boolean;

function isEmptyPatch(value: JsonValue): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function deltaOf(base: JsonValue, target: JsonValue, same: Equal): DeltaResult {
  if (same(base, target)) {
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
  return deltaOf(base, target, same);
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

function normalizeTsPaths(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return normalizePathish(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTsPaths(item));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = normalizeTsPaths(inner);
    }
    return out;
  }
  return value;
}

/**
 * Semantic equality for tsconfig/jsconfig values: strings that only differ by
 * a leading `./` or a trailing recursive glob describe the same path, so a
 * rule repeating `dist` where the default says `./dist` carries no
 * information.
 */
export function tsconfigEqual(a: JsonValue, b: JsonValue): boolean {
  return deepEqual(normalizeTsPaths(a), normalizeTsPaths(b));
}
