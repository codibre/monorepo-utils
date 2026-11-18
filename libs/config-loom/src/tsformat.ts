import { LoomError } from './errors';
import * as ts from 'typescript';

/**
 * Semantic comparison for `ts` format files.
 *
 * A TypeScript/JavaScript config file carries formatting that means nothing
 * to its runtime: indentation, line breaks, comments, string quote style,
 * trailing commas. Clustered as plain text, every formatter tweak spawns a
 * "rule" whose value differs from the default by noise only. This module
 * turns a source file into a **token signature** — the deterministic
 * stream of significant tokens — so two files are equal exactly when their
 * code is, no matter how differently they are printed.
 *
 * What folds (formatting, irrelevant): whitespace and line breaks, comments
 * (the scanner runs with trivia skipped), `'x'` vs `"x"`, trailing commas
 * in objects/arrays/argument lists.
 * What never folds (meaning): operators (`a+b` vs `a-b`), identifiers and
 * string values, semicolons (ASI makes `a;(b)` and `a\n(b)` different code,
 * so a dropped semicolon is NOT a formatting choice), parenthesization.
 */

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ts: ts.ScriptKind.TS,
  mts: ts.ScriptKind.TS,
  cts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
};

function scriptKindFor(fileName: string): ts.ScriptKind {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  const ext = base.slice(base.lastIndexOf('.') + 1).toLowerCase();
  return SCRIPT_KINDS[ext] ?? ts.ScriptKind.TS;
}

/** JS-family files in the wild legitimately carry JSX (and sometimes even
 * type annotations); the TSX dialect parses all of that, so a JS-family
 * file is valid when EITHER dialect accepts it. */
function isJsFamily(fileName: string): boolean {
  const kind = scriptKindFor(fileName);
  return kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX;
}

function parseDiags(
  text: string,
  fileName: string,
  kind: ts.ScriptKind,
): readonly ts.Diagnostic[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  return (
    (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? []
  );
}

/**
 * Fail with a readable message when `text` is not syntactically valid
 * TypeScript/JavaScript (per the extension of `fileName`; JS-family files
 * also pass when the TSX dialect accepts them).
 *
 * `parseDiagnostics` is not in the public d.ts (it is an internal field the
 * compiler always populates on a freshly parsed SourceFile); the cast is the
 * cheapest stable read — building a LanguageService or transpileModule just
 * to hear about syntax errors costs more and says the same thing.
 */
export function assertTypeScript(text: string, fileName: string): void {
  const diagnostics = parseDiags(text, fileName, scriptKindFor(fileName));
  if (diagnostics.length === 0) {
    return;
  }
  if (
    isJsFamily(fileName) &&
    parseDiags(text, fileName, ts.ScriptKind.TSX).length === 0
  ) {
    return;
  }
  const first = ts.flattenDiagnosticMessageText(
    diagnostics[0]?.messageText ?? 'syntax error',
    ' ',
  );
  const more =
    diagnostics.length > 1
      ? ` (and ${String(diagnostics.length - 1)} more syntax error(s))`
      : '';
  throw new LoomError(
    `${fileName} is not valid TypeScript/JavaScript: ${first}${more}`,
  );
}

/**
 * Token kinds whose lexeme carries meaning beyond the kind itself. The
 * scanner only refreshes its token value for literals and identifiers, so
 * punctuation/keywords MUST NOT read it (a stale value from the previous
 * literal would leak into the signature).
 */
const VALUE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.PrivateIdentifier,
]);

const CLOSE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseParenToken,
]);

/**
 * Signature name for a kind: a substitution-free template literal is the
 * same string value written with different backticks-quoting, so it shares
 * the StringLiteral name.
 */
function kindName(kind: ts.SyntaxKind): string {
  if (kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    return ts.SyntaxKind[ts.SyntaxKind.StringLiteral];
  }
  return ts.SyntaxKind[kind] ?? String(kind);
}

/**
 * The canonical token stream of a source file, joined with `;`. Trivia
 * (whitespace, comments, shebangs) is skipped by the scanner; a trailing
 * comma followed by a closing bracket is dropped. Throws when the text is
 * not valid TypeScript.
 */
export function tsSignature(text: string, fileName: string): string {
  assertTypeScript(text, fileName);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    ts.LanguageVariant.Standard,
    text,
  );
  const tokens: Array<{ kind: ts.SyntaxKind; value: string }> = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    tokens.push({
      kind: token,
      value: VALUE_KINDS.has(token) ? scanner.getTokenValue() : '',
    });
    token = scanner.scan();
  }
  const parts: string[] = [];
  for (const [index, entry] of tokens.entries()) {
    if (entry.kind === ts.SyntaxKind.CommaToken) {
      const next = tokens[index + 1];
      if (!next || CLOSE_KINDS.has(next.kind)) {
        continue;
      }
    }
    const name = kindName(entry.kind);
    parts.push(entry.value ? `${name}(${JSON.stringify(entry.value)})` : name);
  }
  return parts.join(';');
}

/**
 * Loose equivalence for sync/check: two sources are the same code when both
 * parse and their token signatures match. A file that does not parse is
 * never equivalent to anything (sync rewrites it from the loom).
 */
export function tsEquivalent(a: string, b: string, fileName: string): boolean {
  try {
    return tsSignature(a, fileName) === tsSignature(b, fileName);
  } catch {
    return false;
  }
}
