import { parseAllDocuments, stringify } from 'yaml';
import { LoomError } from './errors';
import { deepEqual } from './util';
import type { JsonValue } from './types';

/**
 * YAML files carry formatting that means nothing to their consumers:
 * indentation width, quoting style, comments, key order, flow vs block
 * style all round-trip to the same document. Clustered as raw text, two
 * copies of one document written by hand and by prettier became separate
 * clusters (spurious rules) and permanent check drift — the YAML mirror
 * of the `ts` format's token signature: here the equivalence key is the
 * PARSED document, canonicalized (`canonicalJson`), so formatting can
 * never reach the comparison.
 *
 * What still counts as a difference: list order (it is data), scalar
 * types (`"1.10"` is not `1.10`, `yes` is a string — YAML 1.2 core, the
 * `yaml` package default), and any document the parser rejects.
 *
 * Deliberate limits (rejected loudly instead of silently corrupted):
 * - multi-document streams (`---`): config-loom manages one document;
 * - custom/unknown tags (`!Ref x`): they would be dropped on re-render;
 * - duplicate keys: the parser reports them; we refuse to pick a winner.
 *
 * Anchors and aliases resolve to plain values at parse time — re-rendered
 * files carry the expanded content, which is semantically identical.
 */

/** Canonical emit shape: fixed 2-space indent, NEVER line-fold (folding
 * depends on the width setting and shreds long scalars needlessly). */
const RENDER = { lineWidth: 0, indent: 2 } as const;

/**
 * Parse exactly one YAML document from `text`, failing (LoomError, with
 * the file named) on syntax errors, multi-document streams, duplicate
 * keys and unresolvable tags. The result is JSON-safe plain data (the
 * YAML 1.2 core schema: no Date objects, `yes` stays a string).
 */
export function parseYamlDocument(text: string, fileName: string): JsonValue {
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(text);
  } catch (e) {
    throw new LoomError(
      `${fileName} is not valid YAML: ${(e as Error).message}`,
    );
  }
  const doc = docs[0];
  if (
    docs.length === 0 ||
    (docs.length === 1 && doc !== undefined && doc.contents === null)
  ) {
    throw new LoomError(
      `${fileName} holds no YAML document — a managed yaml file needs content (comments alone do not count)`,
    );
  }
  if (docs.length > 1) {
    throw new LoomError(
      `${fileName} holds ${String(docs.length)} YAML documents (--- separators); config-loom manages single-document YAML`,
    );
  }
  const first = doc as NonNullable<typeof doc>;
  if (first.errors.length > 0) {
    throw new LoomError(
      `${fileName} is not valid YAML: ${first.errors
        .map((e) => e.message)
        .slice(0, 2)
        .join('; ')}`,
    );
  }
  if (first.warnings.length > 0) {
    throw new LoomError(
      `${fileName} uses YAML features that would not survive regeneration: ${first.warnings
        .map((w) => w.code ?? w.message)
        .slice(0, 3)
        .join(', ')}`,
    );
  }
  // maxAliasCount -1: aliases expand freely; the result is plain data.
  return first.toJS({ maxAliasCount: -1 }) as JsonValue;
}

/**
 * Canonical bytes for a managed yaml file's content: stable indentation,
 * no folding, trailing newline — what `sync` writes and what authorship
 * proofs compare against.
 */
export function yamlCanonicalText(value: JsonValue): string {
  try {
    return stringify(value, RENDER);
  } catch (e) {
    throw new LoomError(`cannot render YAML document: ${(e as Error).message}`);
  }
}

/**
 * True when both texts parse to the same YAML document (key order and
 * quoting irrelevant, list order relevant). An unparseable side is never
 * equivalent — drift there must surface.
 */
export function yamlEquivalent(
  a: string,
  b: string,
  fileName: string,
): boolean {
  try {
    return deepEqual(
      parseYamlDocument(a, fileName),
      parseYamlDocument(b, fileName),
    );
  } catch {
    return false;
  }
}
