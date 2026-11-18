import {
  assertTypeScript,
  tsEquivalent,
  tsSignature,
} from '../../src/tsformat';
import { LoomError } from '../../src/errors';

// The exact two spellings from issue #12: same code, divergent spacing.
const SPACED = `import { mergeConfig } from 'vitest/config';
import base from '@monorepo/config/vitest';

export default mergeConfig(base, { test: { root: './' } });
`;
const COMPACT = `import {mergeConfig} from 'vitest/config';
import base from '@monorepo/config/vitest';

export default mergeConfig(base, {test: {root: './'}});
`;

describe('ts token signature', () => {
  it('folds the formatting-only drift from issue #12', () => {
    expect(tsSignature(SPACED, 'vitest.config.ts')).toBe(
      tsSignature(COMPACT, 'vitest.config.ts'),
    );
  });

  it('folds comments, quote style and trailing commas', () => {
    expect(tsSignature("export default { a: 'b', };\n", 'x.ts')).toBe(
      tsSignature('// the reason\nexport default { a: "b" };', 'x.ts'),
    );
    // Template literals without substitution fold with plain strings.
    expect(tsSignature('export default "./";\n', 'x.ts')).toBe(
      tsSignature('export default `./`;\n', 'x.ts'),
    );
  });

  it('keeps meaning: operators and literals never fold', () => {
    expect(tsSignature('const x = a + b;\n', 'x.ts')).not.toBe(
      tsSignature('const x = a - b;\n', 'x.ts'),
    );
    expect(tsSignature('export default { a: 1 };\n', 'x.ts')).not.toBe(
      tsSignature('export default { a: 2 };\n', 'x.ts'),
    );
    expect(tsSignature('export default "x";\n', 'x.ts')).not.toBe(
      tsSignature('export default "y";\n', 'x.ts'),
    );
    expect(tsSignature('export default x;\n', 'x.ts')).not.toBe(
      tsSignature('export default y;\n', 'x.ts'),
    );
  });

  it('keeps semicolons: ASI makes dropping one a semantic change', () => {
    // `a;(b)()` calls b and calls the result with `a` as receiver context;
    // `a\n(b)()` calls a(b)() — the streams must differ.
    expect(tsSignature('a;(b)();\n', 'x.ts')).not.toBe(
      tsSignature('a\n(b)();\n', 'x.ts'),
    );
  });

  it('does not drop the comma before an OPEN bracket (only trailing ones)', () => {
    // In `f(a, (b))` the comma is followed by OpenParen — it must stay, so
    // the call keeps two arguments.
    expect(tsSignature('f(a, (b));\n', 'x.ts')).not.toBe(
      tsSignature('f(a(b));\n', 'x.ts'),
    );
  });

  it('accepts tsx per extension and rejects JSX in a plain .ts file', () => {
    const jsx = 'const x = <div id="a">hi</div>;\nexport default x;\n';
    expect(() => tsSignature(jsx, 'c.tsx')).not.toThrow();
    expect(() => tsSignature(jsx, 'c.ts')).toThrow(LoomError);
  });

  it('assertTypeScript reports the file and the first syntax error', () => {
    expect(() => assertTypeScript('export default {', 'bad.ts')).toThrow(
      /bad\.ts is not valid TypeScript/,
    );
    expect(() =>
      assertTypeScript('export default 1;\n', 'ok.ts'),
    ).not.toThrow();
  });

  it('parses the JS dialects by extension: cjs, mjs and JSX-in-.js', () => {
    expect(() =>
      tsSignature(
        "module.exports = { preset: 'ts-jest' };\n",
        'jest.config.cjs',
      ),
    ).not.toThrow();
    expect(() =>
      tsSignature(
        'export { default } from "./base.mjs";\n',
        'eslint.config.mjs',
      ),
    ).not.toThrow();
    // React repos put JSX in plain .js files — the JS family accepts it.
    expect(() =>
      tsSignature(
        'const x = <div id="a">hi</div>;\nmodule.exports = x;\n',
        'legacy.js',
      ),
    ).not.toThrow();
    // Whitespace drift folds in JS too.
    expect(tsSignature('module.exports={a:1,\n};\n', 'jest.config.cjs')).toBe(
      tsSignature('// cjs\nmodule.exports = { a: 1 };\n', 'jest.config.cjs'),
    );
    // But garbage is still garbage.
    expect(() => tsSignature('module.exports = (((\n', 'x.cjs')).toThrow(
      LoomError,
    );
  });

  it('tsEquivalent is loose: an unparseable file is never equivalent', () => {
    expect(tsEquivalent(SPACED, COMPACT, 'vitest.config.ts')).toBe(true);
    expect(tsEquivalent('const x = ;', 'const x = ;', 'x.ts')).toBe(false);
    expect(tsEquivalent('const x = 1;\n', 'const x = 2;\n', 'x.ts')).toBe(
      false,
    );
  });
});
