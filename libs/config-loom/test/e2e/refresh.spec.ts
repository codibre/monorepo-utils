import { checkAll } from '../../src/check';
import { addFiles } from '../../src/add';
import { loadConfig } from '../../src/config';
import { refreshLoom } from '../../src/refresh';
import { renderFile, scopeFor } from '../../src/render';
import { syncAll } from '../../src/sync';
import { initRepo } from '../../src/init';
import {
  createWorkspace,
  fakePnpmRunner,
  getRel,
  makeTempDir,
  putFile,
  tsConfig,
} from '../helpers';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml, stringify } from 'yaml';
import type { LoomConfigInput } from '../../src/types';

const run = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    { cwd: root },
  );
  return stdout;
}

async function baseRepo(): Promise<string> {
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
  const common = tsConfig();
  await createWorkspace(root, 'apps/api', { 'tsconfig.json': common });
  await createWorkspace(root, 'apps/web', { 'tsconfig.json': common });
  await createWorkspace(root, 'libs/data', { 'tsconfig.json': common });
  await initRepo(root, {
    runner: fakePnpmRunner,
    files: ['tsconfig.json'],
    yes: true,
    force: true,
    noWire: true,
  });
  return root;
}

async function readLoom(root: string): Promise<LoomConfigInput> {
  return parseYaml(await getRel(root, 'config-loom.yaml'), {
    prettyErrors: true,
  }) as LoomConfigInput;
}

async function check(root: string): Promise<string[]> {
  const { config } = await loadConfig(root);
  const result = await checkAll(config, root, { runner: fakePnpmRunner });
  return result.drift.map((item) => `${item.workspace}/${item.file}`);
}

describe('loom refresh', () => {
  it('adopts the manual config of a new project as a rule (idempotent)', async () => {
    const root = await baseRepo();
    await createWorkspace(root, 'libs/newproj', {
      'tsconfig.json': tsConfig({ resolveJsonModule: true }),
    });

    const result = await refreshLoom(root, { runner: fakePnpmRunner });
    const report = result.reports.find((r) => r.file === 'tsconfig.json');
    expect(report?.status).toBe('updated');
    expect(result.changed).toBe(true);

    // the loom now reproduces the hand-written file for that workspace
    const { config } = await loadConfig(root);
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('entry vanished');
    const scope = scopeFor(entry, 'libs/newproj');
    expect(scope).not.toBeNull();
    const rendered = renderFile(entry, 'libs/newproj');
    expect(rendered).toBe(await getRel(root, 'libs/newproj/tsconfig.json'));

    // other workspaces keep their (unchanged) bytes and the loom is stable
    expect(await check(root)).toEqual([]);
    const again = await refreshLoom(root, { runner: fakePnpmRunner });
    expect(again.changed).toBe(false);
    expect(again.reports.find((r) => r.file === 'tsconfig.json')?.status).toBe(
      'unchanged',
    );
  });

  it('turns a hand edit of a generated file into the workspace rule', async () => {
    const root = await baseRepo();
    const webBefore = await getRel(root, 'apps/web/tsconfig.json');
    await putFile(
      root,
      'apps/api/tsconfig.json',
      tsConfig({ target: 'es2024' }),
    );

    const result = await refreshLoom(root, { runner: fakePnpmRunner });
    expect(result.changed).toBe(true);
    expect(await getRel(root, 'apps/web/tsconfig.json')).toBe(webBefore);

    const { config } = await loadConfig(root);
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('entry vanished');
    const scope = scopeFor(entry, 'apps/api');
    expect(scope).not.toBeNull();
    const rendered = renderFile(entry, 'apps/api');
    expect(rendered).toBe(await getRel(root, 'apps/api/tsconfig.json'));
    expect(rendered).toContain('es2024');
    expect(await check(root)).toEqual([]);
  });

  it('preserves alias keys, curated excludes and untouched entries', async () => {
    const root = await baseRepo();
    // curate the loom: alias entry + a repo-wide exclude, then materialize
    const loom = await readLoom(root);
    loom.exclude = ['^libs/legacy$'];
    loom.files['tsbuild'] = {
      filename: 'tsconfig.build.json',
      include: ['^apps/'],
      default: { compilerOptions: { declaration: true } },
    };
    await putFile(root, 'config-loom.yaml', stringify(loom));
    const { config } = await loadConfig(root);
    await syncAll(config, root, { runner: fakePnpmRunner });

    // a legacy workspace (excluded repo-wide) with its own manual config
    await createWorkspace(root, 'libs/legacy', {
      'tsconfig.build.json':
        JSON.stringify({ compilerOptions: { outFile: 'legacy.js' } }, null, 2) +
        '\n',
    });

    await refreshLoom(root, { runner: fakePnpmRunner });
    const after = await readLoom(root);
    expect(after.exclude).toEqual(['^libs/legacy$']);
    expect(after.files['tsbuild']).toBeDefined();
    expect(after.files['tsbuild']?.filename).toBe('tsconfig.build.json');
    // the excluded workspace keeps its manual file byte-for-byte
    expect(await getRel(root, 'libs/legacy/tsconfig.build.json')).toContain(
      'legacy.js',
    );
    expect(await getRel(root, 'libs/legacy/tsconfig.build.json')).not.toContain(
      'declaration',
    );
  });

  it('restricts re-derivation to the requested filenames', async () => {
    const root = await baseRepo();
    // change the managed tsconfig AND seed a second file via add
    await createWorkspace(root, 'apps/api', {
      'tsconfig.json': tsConfig({ target: 'es2024' }),
    });
    await refreshLoom(root, { runner: fakePnpmRunner });
    await putFile(
      root,
      'templates/pretty.json',
      JSON.stringify({ printWidth: 100 }, null, 2) + '\n',
    );
    await addFiles(root, ['.prettierrc.json'], {
      template: 'templates/pretty.json',
      runner: fakePnpmRunner,
    });
    const before = await readLoom(root);

    // now only the prettier files change (by hand, in every workspace)
    for (const ws of ['apps/api', 'apps/web', 'libs/data']) {
      await putFile(
        root,
        `${ws}/.prettierrc.json`,
        JSON.stringify({ printWidth: 80, semi: true }, null, 2) + '\n',
      );
    }
    await refreshLoom(root, {
      filenames: ['.prettierrc.json'],
      runner: fakePnpmRunner,
    });
    const after = await readLoom(root);
    expect(after.files['tsconfig.json']).toEqual(before.files['tsconfig.json']);
    expect(after.files['.prettierrc.json']).toBeDefined();
    expect(JSON.stringify(after.files['.prettierrc.json'])).toContain('80');
    expect(await check(root)).toEqual([]);
  });

  it('rejects filenames that are not managed', async () => {
    const root = await baseRepo();
    await expect(
      refreshLoom(root, { filenames: ['nope.txt'], runner: fakePnpmRunner }),
    ).rejects.toThrow(/not managed/);
  });

  it('dry run reports the plan and writes nothing', async () => {
    const root = await baseRepo();
    const before = await getRel(root, 'config-loom.yaml');
    const manual = tsConfig({ target: 'es2024' });
    await putFile(root, 'apps/api/tsconfig.json', manual);

    const result = await refreshLoom(root, {
      dryRun: true,
      runner: fakePnpmRunner,
    });
    expect(result.changed).toBe(true);
    expect(result.newConfig).toContain('apps/api');
    // nothing on disk moved
    expect(await getRel(root, 'config-loom.yaml')).toBe(before);
    expect(await getRel(root, 'apps/api/tsconfig.json')).toBe(manual);
  });

  it('re-untracks managed files that got committed and rebuilds the block', async () => {
    const root = await baseRepo();
    await git(root, 'init', '-q');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-qm', 'chore: committed');
    // somebody force-adds the generated file back into the index
    await git(root, 'add', '-f', 'apps/web/tsconfig.json');

    const result = await refreshLoom(root, { runner: fakePnpmRunner });
    expect(result.untracked).toContain('apps/web/tsconfig.json');
    expect(await git(root, 'ls-files')).not.toContain('apps/web/tsconfig.json');
    expect(await getRel(root, '.gitignore')).toContain('apps/*/tsconfig.json');
    expect(await check(root)).toEqual([]);
  });
});
