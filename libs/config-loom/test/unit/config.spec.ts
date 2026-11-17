import { compileConfig, loadConfig } from '../../src/config';
import { LoomError } from '../../src/errors';
import { renderFile } from '../../src/render';
import { putFile, makeTempDir } from '../helpers';
import type { LoomConfigInput } from '../../src/types';

function minimal(overrides: Partial<LoomConfigInput> = {}): LoomConfigInput {
  return {
    files: {
      'tsconfig.json': {
        default: { compilerOptions: {} },
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
    expect(entry.banner).toBe(false);
    expect(entry.hasDefault).toBe(true);
  });

  it('banners *.jsonc by default; tsconfig only when explicitly asked', () => {
    const config = compileConfig(
      {
        files: {
          'renovate.jsonc': { default: {} },
          'tsconfig.json': {
            banner: '/* hand-written */',
            default: {},
          },
        },
      },
      'test',
    );
    expect(config.files['renovate.jsonc']?.banner).toContain('config-loom');
    expect(config.files['tsconfig.json']?.banner).toBe('/* hand-written */');
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
          'eslint.config.mjs': { default: 'export default [];' },
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
        { files: { 'package.json': { default: { name: 'x' } } } },
        'test',
      ),
    ).toThrow(/can never be generated/);
  });

  it('refuses absolute paths and .. escapes', () => {
    expect(() =>
      compileConfig({ files: { '/etc/passwd.json': { default: {} } } }, 'test'),
    ).toThrow(/relative path/);
    expect(() =>
      compileConfig({ files: { '../outside.json': { default: {} } } }, 'test'),
    ).toThrow(/relative path/);
  });

  it('rejects invalid regex rules and non-object rule values', () => {
    expect(() =>
      compileConfig(
        {
          files: {
            'a.json': {
              default: {},
              rules: [{ pattern: 'apps/(', value: {} }],
            },
          },
        },
        'test',
      ),
    ).toThrow(/valid regular expression/);
    expect(() =>
      compileConfig(
        {
          files: {
            'a.json': {
              default: {},
              rules: [{ pattern: 'apps/x', value: 42 }],
            },
          },
        },
        'test',
      ),
    ).toThrow(/must be an object/);
  });

  it('keeps rules in declaration order', () => {
    const config = compileConfig(
      {
        files: {
          'a.json': {
            default: {},
            rules: [
              { pattern: 'libs/.*', value: { one: 1 } },

              { pattern: 'libs/special', value: { two: 2 } },
            ],
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
      {
        files: {
          'a.json': {
            default: null,
            rules: [{ pattern: 'apps/x', value: { a: 1 } }],
          },
        },
      },
      'test',
    );
    const entry = config.files['a.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.hasDefault).toBe(true);
    expect(entry.defaultValue).toBeNull();

    // A null rule is a legal opt-out: it compiles and makes renderFile skip.
    const opted = compileConfig(
      {
        files: {
          'a.json': {
            default: { a: 1 },
            rules: [{ pattern: 'apps/x', value: null }],
          },
        },
      },
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
        { files: { 'x.mjs': { banner: true, default: 'a' } } },
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
              default: {},
            },
          },
        },
        'test',
      ),
    ).toThrow(/cannot be used with format "json"/);
  });
});

describe('loadConfig', () => {
  it('ignores the pre-YAML JSON config (no loom found)', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.jsonc',
      `// my loom
      { "files": { "tsconfig.json": { "rules": { "default": { "ok": true } } } } }`,
    );
    await expect(loadConfig(root)).rejects.toThrow(/no loom configuration/);
  });

  it('fails with a helpful error when absent', async () => {
    const root = await makeTempDir();
    await expect(loadConfig(root)).rejects.toThrow(LoomError);
    await expect(loadConfig(root)).rejects.toThrow(/loom init/);
  });
});

describe('loadConfig — YAML wire', () => {
  it('reads a spec-level default above rules, block scalars, opt-out rules', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      [
        'files:',
        '  eslint.config.mjs:',
        '    format: text',
        '    default: |',
        "      import base from '@repo/eslint';",
        '      export default base;',
        '    rules:',
        '      - pattern: apps/.*-front',
        '        value: |',
        "          import front from '@repo/eslint-front';",
        '          export default front;',
        '      - pattern: libs/legacy',
      ].join('\n'),
    );
    const { config, path } = await loadConfig(root);
    expect(path).toContain('config-loom.yaml');
    const entry = config.files['eslint.config.mjs'];
    if (!entry) throw new Error('missing entry');
    expect(entry.hasDefault).toBe(true);
    expect(entry.defaultValue).toBe(
      "import base from '@repo/eslint';\nexport default base;\n",
    );
    expect(entry.rules).toHaveLength(2);
    expect(entry.rules[0]?.value).toBe(
      "import front from '@repo/eslint-front';\nexport default front;\n",
    );
    // a rule without `value` is an opt-out
    expect(entry.rules[1]?.value).toBeNull();
  });

  it('treats the pattern `default` as a literal workspace path', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      [
        'files:',
        '  tsconfig.json:',
        '    default:',
        '      a: 1',
        '    rules:',
        '      - pattern: default',
        '        value:',
        '          a: 2',
      ].join('\n'),
    );
    const { config } = await loadConfig(root);
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.rules.map((rule) => rule.pattern)).toEqual(['default']);
    expect(entry.defaultValue).toEqual({ a: 1 });
    // a workspace literally named `default` hits the rule
    expect(entry.rules[0]?.regex.source).toContain('default');
  });

  it('rejects the pre-YAML map shape for rules', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      [
        'files:',
        '  tsconfig.json:',
        '    rules:',
        '      default:',
        '        compilerOptions:',
        '          strict: true',
      ].join('\n'),
    );
    await expect(loadConfig(root)).rejects.toThrow(
      /must be a list of \{ pattern, value \} entries/,
    );
  });

  it('rejects unknown props on a rule entry', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      [
        'files:',
        '  tsconfig.json:',
        '    rules:',
        '      - pattern: apps/x',
        '        value: {}',
        '        when: apps/x',
      ].join('\n'),
    );
    await expect(loadConfig(root)).rejects.toThrow(
      /only "pattern", "value" and "template" are allowed/,
    );
  });

  it('rejects rule entries that are not { pattern } objects', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      ['files:', '  tsconfig.json:', '    rules:', '      - default'].join(
        '\n',
      ),
    );
    await expect(loadConfig(root)).rejects.toThrow(
      /must be an object with a "pattern" prop/,
    );
  });
});

describe('loadConfig — template files', () => {
  it('loads the spec default from a template file', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'templates/eslint.mjs',
      "import base from '@repo/eslint';\nexport default base;\n",
    );
    await putFile(
      root,
      'config-loom.yaml',
      [
        'files:',
        '  eslint.config.mjs:',
        '    format: text',
        '    template: templates/eslint.mjs',
      ].join('\n'),
    );
    const { config } = await loadConfig(root);
    const entry = config.files['eslint.config.mjs'];
    if (!entry) throw new Error('missing entry');
    expect(entry.defaultValue).toBe(
      "import base from '@repo/eslint';\nexport default base;\n",
    );
  });

  it('parses json/jsonc templates (comments allowed)', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'templates/base.jsonc',
      '{ // shared base\n  "compilerOptions": { "strict": true }\n}\n',
    );
    await putFile(
      root,
      'config-loom.yaml',
      ['files:', '  tsconfig.json:', '    template: templates/base.jsonc'].join(
        '\n',
      ),
    );
    const { config } = await loadConfig(root);
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.defaultValue).toEqual({
      compilerOptions: { strict: true },
    });
  });

  it('supports rule-level templates', async () => {
    const root = await makeTempDir();
    await putFile(root, 'templates/eslint-front.mjs', 'export default 1;\n');
    await putFile(
      root,
      'config-loom.yaml',
      [
        'files:',
        '  eslint.config.mjs:',
        '    format: text',
        '    default: export default 0;\n',
        '    rules:',
        '      - pattern: apps/.*-front',
        '        template: templates/eslint-front.mjs',
      ].join('\n'),
    );
    const { config } = await loadConfig(root);
    const entry = config.files['eslint.config.mjs'];
    if (!entry) throw new Error('missing entry');
    expect(entry.rules[0]?.value).toBe('export default 1;\n');
  });

  it('template: null is the same as a null value', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      ['files:', '  tsconfig.json:', '    template: null'].join('\n'),
    );
    const { config } = await loadConfig(root);
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.hasDefault).toBe(true);
    expect(entry.defaultValue).toBeNull();
  });

  it('rejects template/default conflicts and missing files', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      [
        'files:',
        '  tsconfig.json:',
        '    default: { a: 1 }',
        '    template: somewhere.json',
      ].join('\n'),
    );
    await expect(loadConfig(root)).rejects.toThrow(/mutually exclusive/);

    await putFile(
      root,
      'config-loom.yaml',
      ['files:', '  tsconfig.json:', '    template: nowhere/base.json'].join(
        '\n',
      ),
    );
    await expect(loadConfig(root)).rejects.toThrow(/not found/);
  });

  it('keeps templates inside the repository', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      ['files:', '  tsconfig.json:', '    template: ../escape.json'].join('\n'),
    );
    await expect(loadConfig(root)).rejects.toThrow(
      /must stay inside the repository/,
    );
  });
});
