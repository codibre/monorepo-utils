import {
  parseYamlDocument,
  yamlCanonicalText,
  yamlEquivalent,
} from '../../src/yamlformat';
import { LoomError } from '../../src/errors';

describe('parseYamlDocument', () => {
  it('parses plain documents as JSON-safe data (YAML 1.2 core)', () => {
    expect(parseYamlDocument('a: 1\nb: yes\nc: 2024-01-01\n', 'x.yml')).toEqual(
      {
        a: 1,
        b: 'yes',
        c: '2024-01-01',
      },
    );
  });

  it('expands anchors to plain values', () => {
    expect(parseYamlDocument('base: &b {x: 1}\nuse: *b\n', 'x.yml')).toEqual({
      base: { x: 1 },
      use: { x: 1 },
    });
  });

  it('rejects multi-document streams, custom tags, duplicates and empties', () => {
    expect(() => parseYamlDocument('a: 1\n---\nb: 2\n', 'x.yml')).toThrow(
      LoomError,
    );
    expect(() => parseYamlDocument('r: !Ref x\n', 'x.yml')).toThrow(
      /would not survive regeneration/,
    );
    expect(() => parseYamlDocument('a: 1\na: 2\n', 'x.yml')).toThrow(LoomError);
    expect(() => parseYamlDocument('# just a comment\n', 'x.yml')).toThrow(
      /holds no YAML document/,
    );
    expect(() => parseYamlDocument('a: [1,\n', 'x.yml')).toThrow(
      /not valid YAML/,
    );
  });
});

describe('yamlEquivalent', () => {
  it('folds indentation, quotes, comments and key order', () => {
    const a = 'steps:\n    - run: test\n    - run: build\n';
    const b = '# pipeline\nsteps:\n  - run: "test"\n  - run: build\n';
    expect(yamlEquivalent(a, b, 'ci.yml')).toBe(true);
    expect(yamlEquivalent('b: 1\na: 2\n', '{a: 2, b: 1}', 'x.yml')).toBe(true);
  });

  it('keeps meaning: list order and scalar types are data', () => {
    expect(yamlEquivalent('l: [a, b]\n', 'l: [b, a]\n', 'x.yml')).toBe(false);
    expect(yamlEquivalent('v: "1.10"\n', 'v: 1.10\n', 'x.yml')).toBe(false);
    expect(yamlEquivalent('v: yes\n', 'v: true\n', 'x.yml')).toBe(false);
  });

  it('never calls an unparseable file equivalent', () => {
    expect(yamlEquivalent('a: [1,\n', 'a: [1,\n', 'x.yml')).toBe(false);
  });
});

describe('yamlCanonicalText', () => {
  it('renders stable canonical bytes', () => {
    const text = yamlCanonicalText({
      a: 'x',
      l: [1, 2],
      n: { d: 'two\nlines\n' },
    });
    expect(text).toBe(
      'a: x\nl:\n  - 1\n  - 2\nn:\n  d: |\n    two\n    lines\n',
    );
    // Re-parsing the canonical text yields the same document.
    expect(
      yamlEquivalent(
        text,
        yamlCanonicalText({ l: [1, 2], a: 'x', n: { d: 'two\nlines\n' } }),
        'x.yml',
      ),
    ).toBe(true);
    // String scalars that look like numbers/bools stay quoted.
    expect(yamlCanonicalText({ v: '1.10' })).toBe('v: "1.10"\n');
  });
});
