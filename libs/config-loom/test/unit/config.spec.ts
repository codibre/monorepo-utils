import { compileConfig, loadConfig } from '../../src/config';
import { LoomError } from '../../src/errors';
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

  it('accepts default: null (opt-in mode) but not null rules', () => {
    const config = compileConfig(
      { files: { 'a.json': { rules: { default: null, 'apps/x': { a: 1 } } } } },
      'test',
    );
    const entry = config.files['a.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.hasDefault).toBe(true);
    expect(entry.defaultValue).toBeNull();
    expect(() =>
      compileConfig(
        { files: { 'a.json': { rules: { default: {}, 'apps/x': null } } } },
        'test',
      ),
    ).toThrow(/cannot be null/);
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
  it('reads loom.json with comments', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'loom.json',
      `// my loom
      { "files": { "tsconfig.json": { "rules": { "default": { "ok": true } } } } }`,
    );
    const { config, path } = await loadConfig(root);
    expect(path).toContain('loom.json');
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
