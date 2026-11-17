import { computeDelta } from '../../src/diff';

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
