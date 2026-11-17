import { deepMerge } from '../../src/merge';
import type { JsonValue } from '../../src/types';

describe('deepMerge', () => {
  it('merges nested objects key by key', () => {
    const base = { a: 1, nested: { x: 1, y: 2 } };
    const patch = { b: 2, nested: { y: 3, z: 4 } };
    expect(deepMerge(base, patch)).toEqual({
      a: 1,
      b: 2,
      nested: { x: 1, y: 3, z: 4 },
    });
  });

  it('replaces arrays by default', () => {
    const base = { include: ['a', 'b'] };
    const patch = { include: ['c'] };
    expect(deepMerge(base, patch)).toEqual({ include: ['c'] });
  });

  it('concatenates arrays with the concat policy', () => {
    const base = { include: ['a', 'b'] };
    const patch = { include: ['b', 'c'] };
    expect(deepMerge(base, patch, 'concat')).toEqual({
      include: ['a', 'b', 'b', 'c'],
    });
  });

  it('de-duplicates arrays with the unique policy', () => {
    const base = { include: ['a', { deep: 1 }] };
    const patch = { include: ['a', 'c', { deep: 1 }] };
    expect(deepMerge(base, patch, 'unique')).toEqual({
      include: ['a', { deep: 1 }, 'c'],
    });
  });

  it('lets the patch win on type mismatch', () => {
    expect(deepMerge({ a: { b: 1 } }, { a: 'text' })).toEqual({ a: 'text' });
    expect(deepMerge({ a: [1] }, { a: 5 })).toEqual({ a: 5 });
  });

  it('adds keys the base does not have', () => {
    const base: JsonValue = { compilerOptions: { strict: true } };
    const patch: JsonValue = {
      compilerOptions: { paths: { '@x': ['src/x'] } },
    };
    expect(deepMerge(base, patch)).toEqual({
      compilerOptions: { strict: true, paths: { '@x': ['src/x'] } },
    });
  });

  it('removes inherited keys with merge-patch nulls (RFC 7386)', () => {
    const base: JsonValue = {
      compilerOptions: { strict: true, target: 'es2022' },
      include: ['src'],
    };
    const patch: JsonValue = { compilerOptions: { target: null } };
    expect(deepMerge(base, patch)).toEqual({
      compilerOptions: { strict: true },
      include: ['src'],
    });
  });
});
