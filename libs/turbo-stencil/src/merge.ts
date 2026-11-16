import { canonicalJson, isPlainObject } from './util';
import type { ArrayPolicy, JsonObject, JsonValue } from './types';

function mergeValues(
  base: JsonValue | undefined,
  patch: JsonValue,
  policy: ArrayPolicy,
): JsonValue {
  if (policy !== 'replace' && Array.isArray(patch)) {
    const items = [...(Array.isArray(base) ? base : []), ...patch];
    if (policy === 'concat') {
      return items;
    }
    const seen = new Set<string>();
    const unique: JsonValue[] = [];
    for (const item of items) {
      const key = canonicalJson(item);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
    }
    return unique;
  }
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: JsonObject = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      out[key] = mergeValues(base[key], value, policy);
    }
    return out;
  }
  return patch;
}

/**
 * Recursive merge used to apply each matching rule over the accumulated value.
 * Objects merge key-by-key; arrays follow the file's {@link ArrayPolicy};
 * anything else is overwritten by the patch.
 */
export function deepMerge(
  base: JsonValue,
  patch: JsonValue,
  policy: ArrayPolicy = 'replace',
): JsonValue {
  return mergeValues(base, patch, policy);
}
