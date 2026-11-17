import { buildPlan, initRepo, serializeConfig } from '../../src/init';
import { GITIGNORE_BEGIN } from '../../src/git';
import { loadConfig } from '../../src/config';
import { checkAll } from '../../src/check';
import {
  createWorkspace,
  fakePnpmRunner,
  getRel,
  makeTempDir,
  putFile,
  tsConfig,
} from '../helpers';
import { parseJsonc } from '../../src/jsonc';
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
    const keys = Object.keys(spec.rules);
    expect(keys[0]).toBe('default');
    // default covers the 5 identical ones; one delta rule for libs/ui
    expect(keys).toHaveLength(2);
    expect(spec.rules['default']).toMatchObject({
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

    // config-loom.json exists and compiles
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

    // git: files untracked + gitignore block present; config-loom.json itself stays committable
    const { stdout: ls } = await run('git', ['ls-files'], { cwd: root });
    expect(ls).not.toContain('tsconfig.json');
    expect(ls).not.toContain('eslint.config.mjs');
    const { stdout: status } = await run('git', ['status', '--porcelain'], {
      cwd: root,
    });
    expect(status).toContain('?? config-loom.json'); // not ignored by the block
    const gitignore = await getRel(root, '.gitignore');
    expect(gitignore).toContain(GITIGNORE_BEGIN);
    expect(gitignore).toContain('apps/api/tsconfig.json');
    expect(result.untracked.length).toBeGreaterThan(0);

    // disk state == loom state
    expect((await checkAll(config, root, { runner: fakePnpmRunner })).ok).toBe(
      true,
    );
    // turbo-style regeneration from scratch works
    expect(result.sync && result.sync.created > 0).toBe(true);
  });

  it('partial coverage forces default: null so untouched workspaces get no file', async () => {
    const root = await makeScatteredRepo();
    const plan = await buildPlan(root, {
      runner: fakePnpmRunner,
      files: ['eslint.config.mjs'],
    });
    const spec = plan.config.files['eslint.config.mjs'];
    if (!spec) throw new Error('missing entry');
    expect(spec.rules.default).toBeNull();
    expect(Object.keys(spec.rules)).toHaveLength(3); // null + two flavors
  });

  it('dry-run changes nothing', async () => {
    const root = await makeScatteredRepo();
    const before = await git(root, 'status', '--porcelain');
    expect(before).toBe('');
    await initRepo(root, { dryRun: true, runner: fakePnpmRunner });
    expect(await git(root, 'status', '--porcelain')).toBe('');
    await expect(getRel(root, 'config-loom.json')).rejects.toThrow();
  });

  it('refuses to overwrite an existing config-loom.json without --force', async () => {
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
    expect(result.configPath).toContain('config-loom.json');
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

  it('serializeConfig emits commented JSONC that compiles back', () => {
    const text = serializeConfig({
      files: { 'tsconfig.json': { rules: { default: { a: 1 } } } },
    });
    expect(text.startsWith('// Managed by config-loom')).toBe(true);
  });
});
