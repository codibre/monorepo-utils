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
    expect(defaultFormatFor('vitest.config.mts')).toBe('ts');
    expect(defaultFormatFor('eslint.config.mjs')).toBe('ts');
    expect(defaultFormatFor('jest.config.cjs')).toBe('ts');
    expect(defaultFormatFor('nest-cli.yml')).toBe('yaml');
    expect(defaultFormatFor('CodeQL-YAML.yaml')).toBe('yaml');
    expect(defaultFormatFor('NOTICE')).toBe('text');
  });
});

describe('compileConfig', () => {
  it('applies defaults (format, arrays, banner)', () => {
    const config = compileConfig(minimal(), 'test');
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.scopes).toHaveLength(1);
    const scope = entry.scopes[0]!;
    expect(scope.format).toBe('jsonc');
    expect(scope.arrays).toBe('replace');
    expect(scope.banner).toBe(false);
    expect(scope.include).toHaveLength(0);
    expect(scope.exclude).toHaveLength(0);
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
    expect(config.files['renovate.jsonc']?.scopes[0]?.banner).toContain(
      'config-loom',
    );
    expect(config.files['tsconfig.json']?.scopes[0]?.banner).toBe(
      '/* hand-written */',
    );
  });

  it('rejects the legacy workspaces key', () => {
    const legacy = {
      ...minimal(),
      workspaces: ['apps/*'],
    } as unknown as LoomConfigInput;
    expect(() => compileConfig(legacy, 'test')).toThrow(/not supported/);
  });

  it('defaults scripts to ts format and other files to text, no banner', () => {
    const config = compileConfig(
      {
        files: {
          'eslint.config.mjs': { default: 'export default [];' },
          'NOTICE.txt': { default: 'hello\n' },
        },
      },
      'test',
    );
    const es = config.files['eslint.config.mjs'];
    if (!es) throw new Error('missing entry');
    expect(es.scopes[0]?.format).toBe('ts');
    expect(es.scopes[0]?.banner).toBe(false);
    const text = config.files['NOTICE.txt'];
    if (!text) throw new Error('missing entry');
    expect(text.scopes[0]?.format).toBe('text');
    expect(text.scopes[0]?.banner).toBe(false);
  });

  it('refuses to generate package.json', () => {
    expect(() =>
      compileConfig(
        { files: { 'package.json': { default: { name: 'x' } } } },
        'test',
      ),
    ).toThrow(/can never be generated/);
  });

  it('refuses absolute paths and .. escapes (filename prop included)', () => {
    expect(() =>
      compileConfig({ files: { '/etc/passwd.json': { default: {} } } }, 'test'),
    ).toThrow(/relative path/);
    expect(() =>
      compileConfig({ files: { '../outside.json': { default: {} } } }, 'test'),
    ).toThrow(/relative path/);
    expect(() =>
      compileConfig(
        { files: { alias: { filename: '../escape.json', default: {} } } },
        'test',
      ),
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
    expect(entry.scopes[0]?.rules.map((rule) => rule.pattern)).toEqual([
      'libs/.*',
      'libs/special',
    ]);
  });

  it('rejects null and missing defaults: scoping is include/exclude work', () => {
    expect(() =>
      compileConfig(
        {
          files: {
            'a.json': {
              default: null,
              rules: [{ pattern: 'apps/x', value: { a: 1 } }],
            },
          },
        },
        'test',
      ),
    ).toThrow(/"default" must have a value/);
    expect(() =>
      compileConfig(
        {
          files: {
            'a.json': {
              rules: [{ pattern: 'apps/x', value: { a: 1 } }],
            },
          },
        },
        'test',
      ),
    ).toThrow(/"default" is required/);
    // A null rule value is a rejection too — no opt-out semantics left.
    expect(() =>
      compileConfig(
        {
          files: {
            'a.json': {
              default: { a: 1 },
              rules: [{ pattern: 'apps/x', value: null }],
            },
          },
        },
        'test',
      ),
    ).toThrow(/needs a "value"/);
  });

  it('rejects a banner string (true) on text files and any banner on json', () => {
    expect(() =>
      compileConfig(
        { files: { 'style.txt': { banner: true, default: 'a' } } },
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

  it('compiles ts entries: source strings, // banner on request, parse-checked', () => {
    const config = compileConfig(
      {
        files: {
          'vitest.config.ts': {
            banner: true,
            default: "import base from '@repo/vitest';\nexport default base;\n",
            rules: [{ pattern: 'apps/web', value: 'export default {};\n' }],
          },
        },
      },
      'test',
    );
    const scope = config.files['vitest.config.ts']?.scopes[0];
    expect(scope?.format).toBe('ts');
    expect(scope?.banner).toMatch(/^\/\/ Generated by config-loom/);
    // A ts file is a string — an inline YAML mapping is not a program.
    expect(() =>
      compileConfig({ files: { 'x.ts': { default: {} } } }, 'test'),
    ).toThrow(/must be a string for ts files/);
    // Broken TypeScript fails at load, not at render.
    expect(() =>
      compileConfig(
        { files: { 'x.ts': { default: 'export default {' } } },
        'test',
      ),
    ).toThrow(/x\.ts is not valid TypeScript\/JavaScript/);
    expect(() =>
      compileConfig(
        {
          files: {
            'x.ts': {
              default: 'export default 1;\n',
              rules: [{ pattern: 'apps/broken', value: 'const (' }],
            },
          },
        },
        'test',
      ),
    ).toThrow(/rule "apps\/broken"/);
  });

  it('compiles yaml entries: text values parse deep, # banner on request, parse-checked', () => {
    const config = compileConfig(
      {
        files: {
          'nest-cli.yml': {
            banner: true,
            default: 'monorepo: true\nsourceRoot: src\n',
          },
        },
      },
      'test',
    );
    const scope = config.files['nest-cli.yml']?.scopes[0];
    expect(scope?.format).toBe('yaml');
    expect(scope?.banner).toMatch(/^# Generated by config-loom/);
    expect(scope?.defaultValue).toEqual({ monorepo: true, sourceRoot: 'src' });
    // Mappings inline in the loom are accepted too (like json).
    const inline = compileConfig(
      { files: { 'x.yml': { default: { a: 1 } } } },
      'test',
    );
    expect(inline.files['x.yml']?.scopes[0]?.defaultValue).toEqual({ a: 1 });
    // Broken YAML fails at load, not at render.
    expect(() =>
      compileConfig({ files: { 'x.yml': { default: 'a: [1,\n' } } }, 'test'),
    ).toThrow(/not valid YAML/);
    expect(() =>
      compileConfig(
        { files: { 'x.yml': { default: 'a: 1\n---\nb: 2\n' } } },
        'test',
      ),
    ).toThrow(/YAML documents/);
    // A scalar document is not a manageable mapping.
    expect(() =>
      compileConfig({ files: { 'x.yml': { default: 'just text\n' } } }, 'test'),
    ).toThrow(/must contain a YAML mapping/);
  });

  it('parses json values written as text (block scalar style)', () => {
    const config = compileConfig(
      {
        files: {
          'tsconfig.json': {
            default: '{ "compilerOptions": { "strict": true } }\n',
          },
        },
      },
      'test',
    );
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.scopes[0]?.defaultValue).toEqual({
      compilerOptions: { strict: true },
    });
    expect(renderFile(entry, 'libs/x')).toContain('"strict": true');
  });

  it('rejects broken or non-object json value text', () => {
    expect(() =>
      compileConfig(
        { files: { 'a.json': { format: 'json', default: '{ oops' } } },
        'test',
      ),
    ).toThrow(LoomError);
    expect(() =>
      compileConfig(
        { files: { 'a.json': { format: 'json', default: '[1, 2]' } } },
        'test',
      ),
    ).toThrow(/must contain a JSON object/);
  });

  it('groups entries sharing one filename; first matching scope renders', () => {
    const config = compileConfig(
      {
        files: {
          'libs-base': {
            filename: 'tsconfig.json',
            include: 'libs/.*',
            default: { libs: true },
          },
          rest: {
            filename: 'tsconfig.json',
            default: { rest: true },
          },
        },
      },
      'test',
    );
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.scopes).toHaveLength(2);
    expect(renderFile(entry, 'libs/one')).toContain('"libs": true');
    expect(renderFile(entry, 'apps/one')).toContain('"rest": true');
  });

  it('scope exclude is decisive: it hides the file even if a later entry matches', () => {
    const config = compileConfig(
      {
        files: {
          scoped: {
            filename: 'tsconfig.json',
            include: ['libs/.*'],
            exclude: 'libs/generated/.*',
            default: { scoped: true },
          },
          fallback: {
            filename: 'tsconfig.json',
            default: { fallback: true },
          },
        },
      },
      'test',
    );
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(renderFile(entry, 'libs/one')).toContain('"scoped": true');
    expect(renderFile(entry, 'libs/generated/x')).toBeNull();
    expect(renderFile(entry, 'apps/one')).toContain('"fallback": true');
  });

  it('rejects invalid include/exclude shapes and regexes', () => {
    expect(() =>
      compileConfig(
        {
          files: {
            'a.json': { default: {}, include: 42 as unknown as string },
          },
        },
        'test',
      ),
    ).toThrow(/"include" must be a string or a list of strings/);
    expect(() =>
      compileConfig(
        { files: { 'a.json': { default: {}, exclude: 'apps/(' } } },
        'test',
      ),
    ).toThrow(/exclude "apps\/\(" is not a valid regular expression/);
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
  it('reads default, block scalars, include/exclude regex lists', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      [
        'files:',
        '  eslint.config.mjs:',
        '    format: text',
        '    include:',
        '      - apps/.*',
        '      - libs/.*',
        '    exclude: libs/generated/.*',
        '    default: |',
        "      import base from '@repo/eslint';",
        '      export default base;',
        '    rules:',
        '      - pattern: apps/.*-front',
        '        value: |',
        "          import front from '@repo/eslint-front';",
        '          export default front;',
      ].join('\n'),
    );
    const { config, path } = await loadConfig(root);
    expect(path).toContain('config-loom.yaml');
    const entry = config.files['eslint.config.mjs'];
    if (!entry) throw new Error('missing entry');
    const scope = entry.scopes[0]!;
    expect(scope.defaultValue).toBe(
      "import base from '@repo/eslint';\nexport default base;\n",
    );
    expect(scope.rules).toHaveLength(1);
    expect(scope.rules[0]?.value).toBe(
      "import front from '@repo/eslint-front';\nexport default front;\n",
    );
    expect(renderFile(entry, 'apps/web-front')).toContain('eslint-front');
    expect(renderFile(entry, 'libs/core')).toContain('eslint');
    expect(renderFile(entry, 'libs/generated/x')).toBeNull();
    expect(renderFile(entry, 'tools/ci')).toBeNull(); // include restricts
  });

  it('reads json defaults as JSON text block scalars', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      [
        'files:',
        '  tsconfig.json:',
        '    default: |',
        '      {',
        '        "compilerOptions": { "strict": true }',
        '      }',
        '    rules:',
        '      - pattern: libs/.*',
        '        value: |',
        '          {',
        '            "compilerOptions": { "composite": true }',
        '          }',
      ].join('\n'),
    );
    const { config } = await loadConfig(root);
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(renderFile(entry, 'libs/x')).toContain('"composite": true');
    expect(renderFile(entry, 'libs/x')).toContain('"strict": true');
    expect(renderFile(entry, 'apps/x')).not.toContain('composite');
  });

  it('supports multiple entries writing the same filename', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      [
        'files:',
        '  tsconfig-libs:',
        '    filename: tsconfig.json',
        '    include: libs/.*',
        '    default: |',
        '      { "libs": true }',
        '  tsconfig-apps:',
        '    filename: tsconfig.json',
        '    include: apps/.*',
        '    default: |',
        '      { "apps": true }',
      ].join('\n'),
    );
    const { config } = await loadConfig(root);
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(entry.scopes).toHaveLength(2);
    expect(renderFile(entry, 'libs/x')).toContain('"libs": true');
    expect(renderFile(entry, 'apps/x')).toContain('"apps": true');
    expect(renderFile(entry, 'tools/x')).toBeNull();
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
    const scope = entry.scopes[0]!;
    expect(scope.rules.map((rule) => rule.pattern)).toEqual(['default']);
    expect(scope.defaultValue).toEqual({ a: 1 });
    // a workspace literally named `default` hits the rule
    expect(scope.rules[0]?.regex.source).toContain('default');
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
        '    default: {}',
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
      [
        'files:',
        '  tsconfig.json:',
        '    default: {}',
        '    rules:',
        '      - default',
      ].join('\n'),
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
    expect(entry.scopes[0]?.defaultValue).toBe(
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
    expect(entry.scopes[0]?.defaultValue).toEqual({
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
    expect(entry.scopes[0]?.rules[0]?.value).toBe('export default 1;\n');
  });

  it('rejects template: null (values must have content)', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'config-loom.yaml',
      ['files:', '  tsconfig.json:', '    template: null'].join('\n'),
    );
    await expect(loadConfig(root)).rejects.toThrow(
      /"template" must be a repo-relative path string/,
    );
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
