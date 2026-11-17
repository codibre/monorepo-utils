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

function isEmptyPatch(value: JsonValue): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function deltaOf(base: JsonValue, target: JsonValue): DeltaResult {
  if (deepEqual(base, target)) {
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
 */
export function computeDelta(base: JsonValue, target: JsonValue): DeltaResult {
  return deltaOf(base, target);
}
