import { buildPlan, initRepo, serializeConfig } from '../../src/init';
import { GITIGNORE_BEGIN } from '../../src/git';
import { loadConfig, compileConfig } from '../../src/config';
import { checkAll } from '../../src/check';
import { syncAll } from '../../src/sync';
import {
  createWorkspace,
  fakePnpmRunner,
  getRel,
  makeTempDir,
  putFile,
  tsConfig,
} from '../helpers';
import { parseJsonc } from '../../src/jsonc';
import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoomConfigInput } from '../../src/types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    { cwd: root },
  );
  return stdout;
}

async function makeScatteredRepo(): Promise<string> {
  const root = await makeTempDir();
  await putFile(
    root,
    'pnpm-workspace.yaml',
    "packages:\n  - 'apps/*'\n  - 'libs/*'\n",
  );
  await putFile(
    root,
    'package.json',
    JSON.stringify({ name: 'root', private: true }),
  );
  await git(root, 'init', '-q');

  // 3 identical tsconfigs, 1 different
  const common = tsConfig();
  await createWorkspace(root, 'apps/api', { 'tsconfig.json': common });
  await createWorkspace(root, 'apps/web', { 'tsconfig.json': common });
  await createWorkspace(root, 'libs/math-application', {
    'tsconfig.json': common,
  });
  await createWorkspace(root, 'libs/ui', {
    'tsconfig.json': tsConfig({ jsx: 'react-jsx' }),
  });
  // eslint config only in 2 workspaces, 2 flavors
  await createWorkspace(root, 'apps/admin', {
    'tsconfig.json': common,
    'eslint.config.mjs': "export { default } from '@repo/eslint-config';\n",
  });
  await createWorkspace(root, 'apps/portal', {
    'tsconfig.json': common,
    'eslint.config.mjs':
      "export { default } from '@repo/eslint-config/front';\n",
  });
  await git(root, 'add', '-A');
  await git(root, 'commit', '-qm', 'feat: scatter configs');
  return root;
}

describe('loom init', () => {
  it('builds a plan with clusters, default and delta rules', async () => {
    const root = await makeScatteredRepo();
    const plan = await buildPlan(root, {
      runner: fakePnpmRunner,
      files: ['tsconfig.json'],
    });
    const spec = plan.config.files['tsconfig.json'];
    if (!spec) throw new Error('missing entry');
    // default covers the 5 identical ones; one delta rule for libs/ui
    expect(spec.rules ?? []).toHaveLength(1);
    expect(spec.rules?.[0]?.pattern).toBe('libs/ui');
    expect(spec.default).toMatchObject({
      compilerOptions: { target: 'es2023' },
    });
    const cluster = plan.clusters.find((c) => c.kind === 'delta');
    if (!cluster) throw new Error('expected a delta cluster');
    expect(cluster.members).toEqual(['libs/ui']);
    expect(plan.unmanaged).toHaveLength(0);
  });

  it('runs the full flow: write config, gitignore, regenerate, check passes', async () => {
    const root = await makeScatteredRepo();
    const result = await initRepo(root, { yes: true, runner: fakePnpmRunner });

    // config-loom.yaml exists and compiles
    const { config } = await loadConfig(root);
    expect(config.files['tsconfig.json']).toBeDefined();
    expect(config.files['eslint.config.mjs']).toBeDefined();

    // managed files regenerated (content canonicalized)
    expect(
      (
        parseJsonc(
          await getRel(root, 'apps/api/tsconfig.json'),
          'apps/api/tsconfig.json',
        ) as any
      ).compilerOptions.target,
    ).toBe('es2023');
    expect(
      (
        parseJsonc(
          await getRel(root, 'libs/ui/tsconfig.json'),
          'libs/ui/tsconfig.json',
        ) as any
      ).compilerOptions.jsx,
    ).toBe('react-jsx');

    // eslint flavor preserved
    expect(await getRel(root, 'apps/portal/eslint.config.mjs')).toContain(
      'front',
    );

    // git: files untracked + gitignore block present; config-loom.yaml itself stays committable
    const { stdout: ls } = await run('git', ['ls-files'], { cwd: root });
    expect(ls).not.toContain('tsconfig.json');
    expect(ls).not.toContain('eslint.config.mjs');
    const { stdout: status } = await run('git', ['status', '--porcelain'], {
      cwd: root,
    });
    expect(status).toContain('?? config-loom.yaml'); // not ignored by the block
    const gitignore = await getRel(root, '.gitignore');
    expect(gitignore).toContain(GITIGNORE_BEGIN);
    // wildcard-first: pnpm workspace globs widened over the managed file
    expect(gitignore).toContain('apps/*/tsconfig.json');
    expect(gitignore).toContain('libs/*/tsconfig.json');
    expect(gitignore).toContain('apps/*/eslint.config.mjs');
    expect(gitignore).not.toContain('libs/*/eslint.config.mjs');
    expect(gitignore).not.toContain('apps/api/tsconfig.json\n');
    expect(result.untracked.length).toBeGreaterThan(0);

    // disk state == loom state
    expect((await checkAll(config, root, { runner: fakePnpmRunner })).ok).toBe(
      true,
    );
    // turbo-style regeneration from scratch works
    expect(result.sync && result.sync.created > 0).toBe(true);
  });

  it('partial coverage collapses into default + exclude when the missing set is compact', async () => {
    const root = await makeScatteredRepo();
    const plan = await buildPlan(root, {
      runner: fakePnpmRunner,
      files: ['eslint.config.mjs'],
    });
    const spec = plan.config.files['eslint.config.mjs'];
    if (!spec) throw new Error('missing entry');
    // Majority flavor becomes the default; the minority keeps a rule; the
    // workspaces without the file collapse into an exclude family.
    expect(spec.default).toBe(
      "export { default } from '@repo/eslint-config';\n",
    );
    expect(spec.rules ?? []).toHaveLength(1); // the front flavor
    expect(spec.exclude).toEqual(['apps/api|apps/web', 'libs/.*']);

    // file placement: only the two present workspaces ever get the file
    const config = { files: { 'eslint.config.mjs': spec } };
    await syncAll(compileConfig(config, 'test'), root, {
      runner: fakePnpmRunner,
    });
    expect(await getRel(root, 'apps/admin/eslint.config.mjs')).toContain(
      "'@repo/eslint-config'",
    );
    expect(await getRel(root, 'apps/portal/eslint.config.mjs')).toContain(
      'front',
    );
    await expect(getRel(root, 'apps/api/eslint.config.mjs')).rejects.toThrow();
    await expect(getRel(root, 'libs/ui/eslint.config.mjs')).rejects.toThrow();
  });

  it('jsonc partial coverage gets a real default plus a compact exclude', async () => {
    const root = await makeScatteredRepo();
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rm(join(root, 'libs/ui/tsconfig.json'));

    const plan = await buildPlan(root, {
      runner: fakePnpmRunner,
      files: ['tsconfig.json'],
    });
    const spec = plan.config.files['tsconfig.json'];
    if (!spec) throw new Error('missing entry');
    // the workspace that lacks the file becomes a hard exclude, so every
    // remaining workspace (including future ones) inherits a real default
    expect(spec.default).toMatchObject({
      compilerOptions: { target: 'es2023' },
      include: ['src'],
    });
    expect(spec.exclude).toEqual(['libs/ui']);
    expect((spec.rules ?? []).some((rule) => rule.value === null)).toBe(false);

    await initRepo(root, {
      yes: true,
      runner: fakePnpmRunner,
      files: ['tsconfig.json'],
    });
    await expect(getRel(root, 'libs/ui/tsconfig.json')).rejects.toThrow();

    // a workspace added later inherits the default without editing anything
    await createWorkspace(root, 'apps/later');
    const { config } = await loadConfig(root);
    await syncAll(config, root, { runner: fakePnpmRunner });
    expect(
      (
        parseJsonc(
          await getRel(root, 'apps/later/tsconfig.json'),
          'later',
        ) as any
      ).compilerOptions.target,
    ).toBe('es2023');
  });

  it('scopes a sparse file with an include when the missing set has no family cover', async () => {
    const root = await makeTempDir();
    await putFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n");
    await putFile(
      root,
      'package.json',
      JSON.stringify({ name: 'root', private: true }),
    );
    await createWorkspace(root, 'apps/x1', { 'tsconfig.json': tsConfig() });
    for (const n of ['x2', 'x3', 'x4', 'x5', 'x6']) {
      await createWorkspace(root, `apps/${n}`);
    }
    const plan = await buildPlan(root, {
      runner: fakePnpmRunner,
      files: ['tsconfig.json'],
    });
    const spec = plan.config.files['tsconfig.json'];
    if (!spec) throw new Error('missing entry');
    // 5 scattered singletons are not a family: the file is scoped to its
    // holder instead of carrying a null default.
    expect(spec.default).toMatchObject({
      compilerOptions: { target: 'es2023' },
      include: ['src'],
    });
    expect(spec.include).toBe('apps/x1');
    expect(spec.exclude).toBeUndefined();
    expect(spec.rules ?? []).toEqual([]);
  });

  it('dry-run changes nothing', async () => {
    const root = await makeScatteredRepo();
    const before = await git(root, 'status', '--porcelain');
    expect(before).toBe('');
    await initRepo(root, { dryRun: true, runner: fakePnpmRunner });
    expect(await git(root, 'status', '--porcelain')).toBe('');
    await expect(getRel(root, 'config-loom.yaml')).rejects.toThrow();
  });

  it('refuses to overwrite an existing config without --force', async () => {
    const root = await makeScatteredRepo();
    await initRepo(root, { yes: true, runner: fakePnpmRunner });
    await expect(
      initRepo(root, { yes: true, runner: fakePnpmRunner }),
    ).rejects.toThrow(/--force/);
    const result = await initRepo(root, {
      yes: true,
      force: true,
      runner: fakePnpmRunner,
    });
    expect(result.configPath).toContain('config-loom.yaml');
  });

  it('excludes unparsable files from the template but still manages the path', async () => {
    const root = await makeScatteredRepo();
    await putFile(root, 'libs/broken/tsconfig.json', '{ this is not json');
    await createWorkspace(root, 'libs/broken'); // ensure package.json exists
    await putFile(root, 'libs/broken/tsconfig.json', '{ this is not json');

    const plan = await buildPlan(root, {
      runner: fakePnpmRunner,
      files: ['tsconfig.json'],
    });
    expect(
      plan.unmanaged.some((entry) => entry.workspace === 'libs/broken'),
    ).toBe(true);
    // the unparseable content did not inform the template, but sync still
    // takes over the managed filename (it is in the plan's default scope)
    await initRepo(root, {
      yes: true,
      force: true,
      files: ['tsconfig.json'],
      runner: fakePnpmRunner,
    });
    expect(
      (parseJsonc(await getRel(root, 'libs/broken/tsconfig.json'), 'x') as any)
        .compilerOptions.target,
    ).toBe('es2023');
  });

  it('wires postinstall and turbo.json root task when turbo.json exists', async () => {
    const root = await makeScatteredRepo();
    await putFile(
      root,
      'turbo.json',
      JSON.stringify(
        { tasks: { build: { dependsOn: ['^build'] }, test: {} } },
        null,
        2,
      ),
    );
    await git(root, 'add', '-A');
    await git(root, 'commit', '-qm', 'chore: add turbo');

    const result = await initRepo(root, {
      yes: true,
      files: ['tsconfig.json'],
      runner: fakePnpmRunner,
    });

    expect(result.wire?.scriptsAdded).toEqual(['postinstall', 'config-loom']);
    expect(result.wire?.turbo?.addedTask).toBe(true);
    expect(result.wire?.turbo?.dependsOnAdded).toEqual(['build', 'test']);

    const pkg = JSON.parse(await getRel(root, 'package.json'));
    expect(pkg.scripts.postinstall).toBe('config-loom sync');
    const turbo = parseJsonc(
      await getRel(root, 'turbo.json'),
      'turbo.json',
    ) as unknown as {
      tasks: Record<
        string,
        {
          dependsOn?: unknown[];
          cache?: boolean;
          outputs?: unknown[];
        }
      >;
    };
    const rootTask = turbo.tasks['//#config-loom'];
    expect(rootTask?.cache).toBe(true);
    expect(rootTask?.outputs).toEqual([
      'apps/**/tsconfig.json',
      'libs/**/tsconfig.json',
    ]);
    expect(turbo.tasks.build?.dependsOn).toEqual(['^build', '//#config-loom']);
    expect(rootTask?.dependsOn).toBeUndefined();
  });

  it('serializeConfig emits YAML with a spec-level default that compiles back', () => {
    const text = serializeConfig({
      files: {
        'tsconfig.json': {
          default: { a: 1 },
          rules: [{ pattern: 'libs/x', value: { b: 2 } }],
        },
      },
    });
    expect(text.startsWith('# Managed by config-loom')).toBe(true);
    const data = parseYaml(text) as {
      files: Record<
        string,
        {
          default?: unknown;
          rules?: Array<{ pattern: string; value: unknown }>;
        }
      >;
    };
    const entry = data.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    // json values are written as JSON text block scalars — JSON as text
    expect(entry.default).toBe('{\n  "a": 1\n}\n');
    expect(entry.rules).toEqual([
      { pattern: 'libs/x', value: '{\n  "b": 2\n}\n' },
    ]);
  });
});

describe('loom init tsconfig intelligence (issue #5)', () => {
  it('prunes rule fields equivalent to the default', async () => {
    const root = await makeTempDir();
    await putFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'libs/*'\n");
    await putFile(
      root,
      'package.json',
      JSON.stringify({ name: 'root', private: true }),
    );
    await git(root, 'init', '-q');
    const base =
      JSON.stringify(
        {
          extends: '@monorepo/config/typescript/tsconfig.json',
          compilerOptions: { outDir: './dist', rootDir: './src' },
          include: ['src/**/*'],
          exclude: ['node_modules', 'dist'],
        },
        null,
        2,
      ) + '\n';
    const variant =
      JSON.stringify(
        {
          extends: '@monorepo/config/typescript/tsconfig.json',
          compilerOptions: { outDir: 'dist', rootDir: 'src' },
          include: ['src'],
        },
        null,
        2,
      ) + '\n';
    await createWorkspace(root, 'libs/alpha', { 'tsconfig.json': base });
    await createWorkspace(root, 'libs/beta', { 'tsconfig.json': base });
    await createWorkspace(root, 'libs/gamma', { 'tsconfig.json': base });
    await createWorkspace(root, 'libs/delta', { 'tsconfig.json': variant });
    await git(root, 'add', '-A');
    await git(root, 'commit', '-qm', 'feat: scatter configs');

    const plan = await buildPlan(root, {
      runner: fakePnpmRunner,
      files: ['tsconfig.json'],
    });
    const spec = plan.config.files['tsconfig.json'];
    if (!spec) throw new Error('missing entry');
    // Only the genuine difference (no `exclude`) survives in the rule.
    expect(spec.default).toEqual({
      extends: '@monorepo/config/typescript/tsconfig.json',
      compilerOptions: { outDir: './dist', rootDir: './src' },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    });
    expect(spec.rules).toEqual([
      { pattern: 'libs/delta', value: { exclude: null } },
    ]);

    // The variant folds into the default spelling (`./dist` ≡ `dist`),
    // keeping only its real difference: no `exclude`.
    const config = compileConfig(plan.config, 'test');
    const sync = await syncAll(config, root, { runner: fakePnpmRunner });
    expect(sync.created + sync.updated).toBeGreaterThan(0);
    const delta = parseJsonc(
      await getRel(root, 'libs/delta/tsconfig.json'),
      'libs/delta/tsconfig.json',
    );
    const expected = JSON.parse(base) as Record<string, unknown>;
    delete expected.exclude;
    expect(delta).toEqual(expected);
    expect((await checkAll(config, root, { runner: fakePnpmRunner })).ok).toBe(
      true,
    );
  });

  it('treats reordered include/exclude lists as the default', async () => {
    const root = await makeTempDir();
    await putFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'libs/*'\n");
    await putFile(
      root,
      'package.json',
      JSON.stringify({ name: 'root', private: true }),
    );
    await git(root, 'init', '-q');
    const base =
      JSON.stringify(
        {
          compilerOptions: { outDir: 'dist' },
          include: ['src', 'test'],
          exclude: ['node_modules', 'dist'],
        },
        null,
        2,
      ) + '\n';
    // same blobs, different order: TypeScript compiles the exact same set
    const shuffled =
      JSON.stringify(
        {
          compilerOptions: { outDir: 'dist' },
          include: ['test', 'src'],
          exclude: ['dist', 'node_modules'],
        },
        null,
        2,
      ) + '\n';
    await createWorkspace(root, 'libs/alpha', { 'tsconfig.json': base });
    await createWorkspace(root, 'libs/beta', { 'tsconfig.json': base });
    await createWorkspace(root, 'libs/shuffle', { 'tsconfig.json': shuffled });
    await git(root, 'add', '-A');
    await git(root, 'commit', '-qm', 'feat: scatter configs');

    const plan = await buildPlan(root, {
      runner: fakePnpmRunner,
      files: ['tsconfig.json'],
    });
    const spec = plan.config.files['tsconfig.json'];
    if (!spec) throw new Error('missing entry');
    // the permutation is not information: no rule at all
    expect(spec.rules ?? []).toEqual([]);
    const config = compileConfig(plan.config, 'test');
    await syncAll(config, root, { runner: fakePnpmRunner });
    // the shuffled file normalizes to the default ordering, and everything
    // is stable from then on
    expect(
      parseJsonc(await getRel(root, 'libs/shuffle/tsconfig.json'), 'x'),
    ).toEqual(JSON.parse(base));
    expect((await checkAll(config, root, { runner: fakePnpmRunner })).ok).toBe(
      true,
    );
  });
});

describe('loom init YAML wire (pattern prop)', () => {
  it('writes rules as a { pattern, value } list with block scalars for text', async () => {
    const root = await makeScatteredRepo();
    await initRepo(root, { yes: true, runner: fakePnpmRunner });
    const text = await getRel(root, 'config-loom.yaml');
    expect(text.startsWith('# Managed by config-loom.')).toBe(true);
    const data = parseYaml(text) as {
      files: Record<
        string,
        {
          default?: unknown;
          rules?: Array<{ pattern: string; value: unknown }>;
        }
      >;
    };
    const eslintEntry = data.files['eslint.config.mjs'];
    const tsEntry = data.files['tsconfig.json'];
    if (!eslintEntry || !tsEntry) throw new Error('missing entry');
    // `default` is a spec property above `rules`, never a pattern; json
    // defaults are JSON TEXT block scalars, readable as JSON.
    expect(typeof eslintEntry.default).toBe('string');
    expect(typeof tsEntry.default).toBe('string');
    expect(String(tsEntry.default)).toContain('"compilerOptions"');
    expect(
      (tsEntry.rules ?? []).some((rule) => rule.pattern === 'default'),
    ).toBe(false);
    expect(tsEntry.rules?.[0]?.pattern).toBe('libs/ui');
    // the text default renders as a plain YAML block scalar
    expect(text).toMatch(/default: [-|]/);
  });

  it('converts a legacy config-loom.json to config-loom.yaml on --force', async () => {
    const root = await makeScatteredRepo();
    await putFile(root, 'config-loom.json', '// stale\n{ "files": {} }\n');
    await git(root, 'add', 'config-loom.json');
    await git(root, 'commit', '-m', 'legacy loom');
    const result = await initRepo(root, {
      yes: true,
      force: true,
      runner: fakePnpmRunner,
    });
    expect(result.configPath).toContain('config-loom.yaml');
    await expect(getRel(root, 'config-loom.json')).rejects.toThrow();
    const status = await git(root, 'status', '--porcelain');
    expect(status).toMatch(/^D {1,2}config-loom\.json$/m);
    // the YAML config actually drives generation
    expect(await getRel(root, 'apps/api/tsconfig.json')).toContain(
      'compilerOptions',
    );
    const { config } = await loadConfig(root);
    expect((await checkAll(config, root, { runner: fakePnpmRunner })).ok).toBe(
      true,
    );
  });

  it('serializeConfig round-trips through loadConfig', async () => {
    const root = await makeTempDir();
    const config: LoomConfigInput = {
      files: {
        'tsconfig.json': {
          format: 'jsonc',
          arrays: 'replace',
          include: 'libs/.*',
          exclude: 'libs/generated/.*',
          default: { compilerOptions: { strict: true } },
          rules: [
            {
              pattern: 'libs/.*',
              value: { compilerOptions: { composite: null } },
            },
          ],
        },
        'eslint.config.mjs': {
          format: 'text',
          arrays: 'replace',
          default: "import a from 'a';\nexport default a;\n",
          rules: [
            {
              pattern: 'apps/x',
              value: "import x from 'x';\nexport default x;\n",
            },
          ],
        },
      },
    };
    const yaml = serializeConfig(config);
    await putFile(root, 'config-loom.yaml', yaml);
    // json values are written as JSON text block scalars, not YAML props
    expect(yaml).toMatch(/default: \|\n\s+\{\n\s+"compilerOptions"/);
    const { config: loaded } = await loadConfig(root);
    const ts = loaded.files['tsconfig.json'];
    const es = loaded.files['eslint.config.mjs'];
    if (!ts || !es) throw new Error('missing entry');
    expect(ts.scopes[0]?.defaultValue).toEqual({
      compilerOptions: { strict: true },
    });
    expect(ts.scopes[0]?.rules[0]).toMatchObject({
      pattern: 'libs/.*',
      value: { compilerOptions: { composite: null } },
    });
    expect(ts.scopes[0]?.include).toHaveLength(1);
    expect(ts.scopes[0]?.exclude).toHaveLength(1);
    expect(es.scopes[0]?.defaultValue).toBe(
      "import a from 'a';\nexport default a;\n",
    );
    expect(es.scopes[0]?.rules[0]?.value).toBe(
      "import x from 'x';\nexport default x;\n",
    );
  });
});

describe('init auto-templating (issue #13)', () => {
  async function makeNoticeRepo(): Promise<string> {
    const root = await makeTempDir();
    await putFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n");
    await putFile(
      root,
      'package.json',
      JSON.stringify({ name: 'root', private: true }),
    );
    const big =
      Array.from({ length: 45 }, (_, i) => `notice line ${i}`).join('\n') +
      '\n';
    const variant = big.replace('notice line 10', 'NOTICE TEN differs');
    await createWorkspace(root, 'apps/a', { 'NOTICE.txt': big });
    await createWorkspace(root, 'apps/b', { 'NOTICE.txt': big });
    await createWorkspace(root, 'apps/c', { 'NOTICE.txt': variant });
    return root;
  }

  it('moves big default and rule values to .config-loom templates', async () => {
    const root = await makeNoticeRepo();
    const big = await readFile(path.join(root, 'apps/a/NOTICE.txt'), 'utf8');
    const result = await initRepo(root, {
      runner: fakePnpmRunner,
      yes: true,
      noWire: true,
      files: ['NOTICE.txt'],
    });
    expect(result.plan.templates.map((t) => t.path).sort()).toEqual([
      '.config-loom/NOTICE.txt/default.txt',
      '.config-loom/NOTICE.txt/rule-1.txt',
    ]);
    expect(
      await readFile(
        path.join(root, '.config-loom/NOTICE.txt/default.txt'),
        'utf8',
      ),
    ).toBe(big);
    const written = await readFile(result.configPath, 'utf8');
    expect(written).toContain('template: .config-loom/NOTICE.txt/default.txt');
    expect(written).toContain('template: .config-loom/NOTICE.txt/rule-1.txt');
    expect(written).not.toContain('notice line 0');
    // Round trip: sync regenerated every file byte-identically from the
    // templates, and the variant rule still reaches apps/c.
    const { config } = await loadConfig(root);
    const check = await checkAll(config, root, { runner: fakePnpmRunner });
    expect(check.ok).toBe(true);
    expect(
      await readFile(path.join(root, 'apps/c/NOTICE.txt'), 'utf8'),
    ).toContain('NOTICE TEN differs');
  });

  it('templateThreshold 0 keeps everything inline', async () => {
    const root = await makeNoticeRepo();
    const plan = await buildPlan(root, {
      runner: fakePnpmRunner,
      files: ['NOTICE.txt'],
      templateThreshold: 0,
    });
    expect(plan.templates).toEqual([]);
    expect(serializeConfig(plan.config)).toContain('notice line 0');
  });

  it('big structured defaults become JSON text templates', async () => {
    const root = await makeTempDir();
    await putFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n");
    await putFile(
      root,
      'package.json',
      JSON.stringify({ name: 'root', private: true }),
    );
    const many = Object.fromEntries(
      Array.from({ length: 45 }, (_, i) => [`key${i}`, i]),
    );
    const text = JSON.stringify(many, null, 2);
    await createWorkspace(root, 'apps/a', { 'tsconfig.json': text });
    await createWorkspace(root, 'apps/b', { 'tsconfig.json': text });
    const result = await initRepo(root, {
      runner: fakePnpmRunner,
      yes: true,
      noWire: true,
      files: ['tsconfig.json'],
    });
    expect(result.plan.templates.map((t) => t.path)).toEqual([
      '.config-loom/tsconfig.json/default.json',
    ]);
    const { config } = await loadConfig(root);
    const check = await checkAll(config, root, { runner: fakePnpmRunner });
    expect(check.ok).toBe(true);
  });
});
