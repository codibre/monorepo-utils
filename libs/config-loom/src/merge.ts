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
      // JSON Merge Patch (RFC 7386): a null in the patch removes the key,
      // so a rule can drop something inherited from `default`.
      if (value === null) {
        delete out[key];
        continue;
      }
      out[key] = mergeValues(base[key], value, policy);
    }
    return out;
  }
  return patch;
}

/**
 * Recursive merge used to apply each matching rule over the accumulated value.
 * Objects merge key-by-key; arrays follow the file's {@link ArrayPolicy};
 * a null value inside an object removes that key (RFC 7386); anything else
 * is overwritten by the patch. (A rule whose WHOLE value is null is handled
 * earlier: it opts the matched workspaces out of the file entirely.)
 */
export function deepMerge(
  base: JsonValue,
  patch: JsonValue,
  policy: ArrayPolicy = 'replace',
): JsonValue {
  return mergeValues(base, patch, policy);
}
