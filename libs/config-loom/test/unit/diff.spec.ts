import { computeDelta, tsconfigEqual } from '../../src/diff';

describe('computeDelta', () => {
  it('returns an empty patch for equal values', () => {
    const value = { a: 1, nested: { list: [1, 2] } };
    expect(computeDelta(value, JSON.parse(JSON.stringify(value)))).toEqual({
      kind: 'delta',
      value: {},
    });
  });

  it('treats key order changes as equal', () => {
    expect(computeDelta({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual({
      kind: 'delta',
      value: {},
    });
  });

  it('emits only the keys that changed', () => {
    const base = { a: 1, b: 2, nested: { x: 1, y: 2 } };
    const target = { a: 1, b: 3, nested: { x: 1, y: 9 } };
    expect(computeDelta(base, target)).toEqual({
      kind: 'delta',
      value: { b: 3, nested: { y: 9 } },
    });
  });

  it('emits added keys', () => {
    expect(computeDelta({ a: 1 }, { a: 1, extra: true })).toEqual({
      kind: 'delta',
      value: { extra: true },
    });
  });

  it('marks removed default keys as merge-patch nulls', () => {
    const base = { a: 1, b: { c: 2, d: 3 } };
    const target = { a: 1, b: { c: 2 } };
    expect(computeDelta(base, target)).toEqual({
      kind: 'delta',
      value: { b: { d: null } },
    });
  });

  it('overrides whole arrays when they differ', () => {
    const base = { include: ['a', 'b'] };
    const target = { include: ['a'] };
    expect(computeDelta(base, target)).toEqual({
      kind: 'delta',
      value: { include: ['a'] },
    });
  });

  it('handles nested object/array mixes', () => {
    const base = { a: { list: [{ x: 1 }], flag: false } };
    const target = { a: { list: [{ x: 1 }, { x: 2 }], flag: true } };
    expect(computeDelta(base, target)).toEqual({
      kind: 'delta',
      value: { a: { list: [{ x: 1 }, { x: 2 }], flag: true } },
    });
  });
});

describe('tsconfigEqual (issue #5)', () => {
  it('treats ./-prefixed and bare paths as the same', () => {
    expect(tsconfigEqual('./dist', 'dist')).toBe(true);
    expect(
      tsconfigEqual(
        { compilerOptions: { outDir: './dist', rootDir: './src' } },
        { compilerOptions: { outDir: 'dist', rootDir: 'src' } },
      ),
    ).toBe(true);
  });

  it('treats a directory and its recursive glob as the same', () => {
    expect(tsconfigEqual(['src/**/*'], ['src'])).toBe(true);
    expect(tsconfigEqual('./src/**/*', 'src')).toBe(true);
    expect(tsconfigEqual(['./src/**/*'], ['src'])).toBe(true);
  });

  it('keeps genuinely different values apart', () => {
    expect(tsconfigEqual('dist', 'dist/src')).toBe(false);
    expect(tsconfigEqual(['src'], ['test'])).toBe(false);
    expect(tsconfigEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(tsconfigEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(tsconfigEqual('./a', 'a/b')).toBe(false);
    expect(tsconfigEqual('src/**/*', 'src/*')).toBe(false);
  });
});

describe('computeDelta with the tsconfig comparator (issue #5)', () => {
  it('prunes everything equivalent, keeping only the real difference', () => {
    const base = {
      extends: '@monorepo/config/typescript/tsconfig.json',
      compilerOptions: { outDir: './dist', rootDir: './src' },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    };
    const target = {
      extends: '@monorepo/config/typescript/tsconfig.json',
      compilerOptions: { outDir: 'dist', rootDir: 'src' },
      include: ['src'],
    };
    expect(computeDelta(base, target, tsconfigEqual)).toEqual({
      kind: 'delta',
      value: { exclude: null },
    });
  });

  it('folds an equivalent-but-differently-spelled file into the default', () => {
    const base = {
      compilerOptions: { outDir: './dist' },
      include: ['./src/**/*'],
    };
    const target = { compilerOptions: { outDir: 'dist' }, include: ['src'] };
    expect(computeDelta(base, target, tsconfigEqual)).toEqual({
      kind: 'delta',
      value: {},
    });
  });

  it('keeps overrides that are not equivalent', () => {
    const base = { compilerOptions: { outDir: './dist' } };
    const target = { compilerOptions: { outDir: 'build', jsx: 'preserve' } };
    expect(computeDelta(base, target, tsconfigEqual)).toEqual({
      kind: 'delta',
      value: { compilerOptions: { outDir: 'build', jsx: 'preserve' } },
    });
  });

  it('stays byte-strict when no comparator is given', () => {
    expect(computeDelta({ outDir: './dist' }, { outDir: 'dist' })).toEqual({
      kind: 'delta',
      value: { outDir: 'dist' },
    });
  });
});
