import { ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import { LoomError } from './errors';
import type { JsonValue } from './types';

/**
 * Parse JSON with comments and trailing commas (tsconfig flavor). Throws a
 * LoomError naming the offending document on any syntax problem.
 */
export function parseJsonc(text: string, label: string): JsonValue {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    throw new LoomError(
      `${label}: invalid JSON: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  if (value === undefined) {
    throw new LoomError(`${label}: empty or unreadable JSON document`);
  }
  return value as JsonValue;
}
