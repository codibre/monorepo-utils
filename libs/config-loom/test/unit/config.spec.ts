import { compileConfig, loadConfig } from '../../src/config';
import { LoomError } from '../../src/errors';
import { renderFile } from '../../src/render';
import { putFile, makeTempDir } from '../helpers';
import type { LoomConfigInput } from '../../src/types';

function minimal(overrides: Partial<LoomConfigInput> = {}): LoomConfigInput {
  return {
    files: {
      'tsconfig.json': {
        rules: { default: { compilerOptions: {} } },
      },
    },
    ...overrides,
  };
}

import { defaultFormatFor } from '../../src/config';

describe('defaultFormatFor', () => {
  it('prefers jsonc only where comments are safe toolchain- and IDE-side', () => {
    expect(defaultFormatFor('tsconfig.json')).toBe('jsonc');
    expect(defaultFormatFor('jsconfig.json')).toBe('jsonc');
    expect(defaultFormatFor('nest-cli.json')).toBe('json');
    expect(defaultFormatFor('tsconfig.build.json')).toBe('json');
    expect(defaultFormatFor('config-loom.jsonc')).toBe('jsonc');
    expect(defaultFormatFor('vitest.config.mts')).toBe('text');
  });
});

describe('compileConfig', () => {
  it('applies defaults (format, arrays, banner)', () => {
    const config = compileConfig(minimal(), 'test');
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.format).toBe('jsonc');
    expect(entry.arrays).toBe('replace');
    expect(entry.banner).toContain('config-loom');
    expect(entry.hasDefault).toBe(true);
  });

  it('rejects the legacy workspaces key', () => {
    const legacy = {
      ...minimal(),
      workspaces: ['apps/*'],
    } as unknown as LoomConfigInput;
    expect(() => compileConfig(legacy, 'test')).toThrow(/not supported/);
  });

  it('defaults non-json files to text format without banner', () => {
    const config = compileConfig(
      {
        files: {
          'eslint.config.mjs': { rules: { default: 'export default [];' } },
        },
      },
      'test',
    );
    const entry = config.files['eslint.config.mjs'];
    if (!entry) throw new Error('missing entry');
    expect(entry.format).toBe('text');
    expect(entry.banner).toBe(false);
  });

  it('refuses to generate package.json', () => {
    expect(() =>
      compileConfig(
        { files: { 'package.json': { rules: { default: { name: 'x' } } } } },
        'test',
      ),
    ).toThrow(/can never be generated/);
  });

  it('refuses absolute paths and .. escapes', () => {
    expect(() =>
      compileConfig(
        { files: { '/etc/passwd.json': { rules: { default: {} } } } },
        'test',
      ),
    ).toThrow(/relative path/);
    expect(() =>
      compileConfig(
        { files: { '../outside.json': { rules: { default: {} } } } },
        'test',
      ),
    ).toThrow(/relative path/);
  });

  it('rejects invalid regex rules and non-object rule values', () => {
    expect(() =>
      compileConfig(
        { files: { 'a.json': { rules: { default: {}, 'apps/(': {} } } } },
        'test',
      ),
    ).toThrow(/valid regular expression/);
    expect(() =>
      compileConfig(
        { files: { 'a.json': { rules: { default: {}, 'apps/x': 42 } } } },
        'test',
      ),
    ).toThrow(/must be an object/);
  });

  it('keeps rules in declaration order', () => {
    const config = compileConfig(
      {
        files: {
          'a.json': {
            rules: {
              default: {},
              'libs/.*': { one: 1 },
              'libs/special': { two: 2 },
            },
          },
        },
      },
      'test',
    );
    const entry = config.files['a.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.rules.map((rule) => rule.pattern)).toEqual([
      'libs/.*',
      'libs/special',
    ]);
  });

  it('accepts default: null (opt-in mode) and null opt-out rules', () => {
    const config = compileConfig(
      { files: { 'a.json': { rules: { default: null, 'apps/x': { a: 1 } } } } },
      'test',
    );
    const entry = config.files['a.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.hasDefault).toBe(true);
    expect(entry.defaultValue).toBeNull();

    // A null rule is a legal opt-out: it compiles and makes renderFile skip.
    const opted = compileConfig(
      { files: { 'a.json': { rules: { default: { a: 1 }, 'apps/x': null } } } },
      'test',
    );
    const optedEntry = opted.files['a.json'];
    if (!optedEntry) throw new Error('missing entry');
    expect(optedEntry.rules.map((rule) => rule.pattern)).toEqual(['apps/x']);
    expect(renderFile(optedEntry, 'apps/x')).toBeNull();
    expect(renderFile(optedEntry, 'apps/y')).toContain('"a": 1');
  });

  it('requires a banner string (not true) on text files and rejects it on json', () => {
    expect(() =>
      compileConfig(
        { files: { 'x.mjs': { banner: true, rules: { default: 'a' } } } },
        'test',
      ),
    ).toThrow(/not supported for text files/);
    expect(() =>
      compileConfig(
        {
          files: {
            'x.json': {
              format: 'json',
              banner: '// hi',
              rules: { default: {} },
            },
          },
        },
        'test',
      ),
    ).toThrow(/cannot be used with format "json"/);
  });
});

describe('loadConfig', () => {
  it('reads config-loom.json with comments', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.json',
      `// my loom
      { "files": { "tsconfig.json": { "rules": { "default": { "ok": true } } } } }`,
    );
    const { config, path } = await loadConfig(root);
    expect(path).toContain('config-loom.json');
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.defaultValue).toEqual({ ok: true });
  });

  it('fails with a helpful error when absent', async () => {
    const root = await makeTempDir();
    await expect(loadConfig(root)).rejects.toThrow(LoomError);
    await expect(loadConfig(root)).rejects.toThrow(/loom init/);
  });
});
