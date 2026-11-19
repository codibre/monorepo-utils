import { addFiles } from '../../src/add';
import { checkAll } from '../../src/check';
import { loadConfig } from '../../src/config';
import { GITIGNORE_BEGIN } from '../../src/git';
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
import { parse as parseYaml } from 'yaml';
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

/**
 * Repo with a loom over tsconfig.json, workspaces at TWO depths (apps/api →
 * `../..`, tool → `..`) so {{root}} rendering is exercised, no git repo.
 */
async function baseRepo(): Promise<string> {
  const root = await makeTempDir();
  await putFile(
    root,
    'pnpm-workspace.yaml',
    "packages:\n  - 'apps/*'\n  - 'libs/*'\n  - 'tool'\n",
  );
  await putFile(
    root,
    'package.json',
    JSON.stringify({ name: 'root', private: true }),
  );
  const common = tsConfig();
  await createWorkspace(root, 'apps/api', { 'tsconfig.json': common });
  await createWorkspace(root, 'apps/web', { 'tsconfig.json': common });
  await createWorkspace(root, 'libs/math-application', {
    'tsconfig.json': common,
  });
  await createWorkspace(root, 'tool', { 'tsconfig.json': common });
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

describe('loom add', () => {
  it('seeds known templates at every workspace with per-depth {{root}}', async () => {
    const root = await baseRepo();
    const result = await addFiles(
      root,
      ['.release-it.js', '.release-it.json'],
      {
        runner: fakePnpmRunner,
      },
    );

    expect(result.added.map((entry) => entry.source)).toEqual([
      'known',
      'known',
    ]);
    expect((await getRel(root, 'apps/api/.release-it.js')).trim()).toBe(
      "module.exports = require('../../.release-it.base.js');",
    );
    expect((await getRel(root, 'tool/.release-it.js')).trim()).toBe(
      "module.exports = require('../.release-it.base.js');",
    );
    expect(await getRel(root, 'apps/web/.release-it.json')).toContain(
      '"extends": "../../.release-it.base.js"',
    );
    expect(await getRel(root, 'tool/.release-it.json')).toContain(
      '"extends": "../.release-it.base.js"',
    );

    const loom = await readLoom(root);
    expect(loom.files['.release-it.js']).toMatchObject({ format: 'ts' });
    expect(loom.files['.release-it.json']).toMatchObject({ format: 'json' });
    // the stored value keeps the token; only rendering expands it
    expect(String(loom.files['.release-it.js']?.default)).toContain('{{root}}');

    const { config } = await loadConfig(root);
    const check = await checkAll(config, root, { runner: fakePnpmRunner });
    expect(check.drift.map((item) => `${item.workspace}/${item.file}`)).toEqual(
      [],
    );
    expect(check.ok).toBe(true);
  });

  it('refuses files that are already managed', async () => {
    const root = await baseRepo();
    await expect(
      addFiles(root, ['tsconfig.json'], { runner: fakePnpmRunner }),
    ).rejects.toThrow(/already managed/);
  });

  it('hints --template and init for unknown names with no known template', async () => {
    const root = await baseRepo();
    await expect(
      addFiles(root, ['weird.xyz'], { runner: fakePnpmRunner }),
    ).rejects.toThrow(/no content source.*--template/s);
  });

  it('takes content from --template but only for a single filename', async () => {
    const root = await baseRepo();
    await putFile(root, 'templates/notes.txt', 'hello loom\n');
    const result = await addFiles(root, ['NOTES.txt'], {
      template: 'templates/notes.txt',
      runner: fakePnpmRunner,
    });
    expect(result.added[0]?.source).toBe('template');
    expect(await getRel(root, 'apps/api/NOTES.txt')).toBe('hello loom\n');
    expect(await getRel(root, 'tool/NOTES.txt')).toBe('hello loom\n');
    await expect(
      addFiles(root, ['a.txt', 'b.txt'], {
        template: 'templates/notes.txt',
        runner: fakePnpmRunner,
      }),
    ).rejects.toThrow(/single filename|ONE file name/);
  });

  it('narrows scope with --include and --exclude', async () => {
    const root = await baseRepo();
    await addFiles(root, ['.release-it.json'], {
      include: ['apps/.*'],
      exclude: ['apps/web'],
      runner: fakePnpmRunner,
    });
    expect(await getRel(root, 'apps/api/.release-it.json')).toContain(
      'extends',
    );
    await expect(getRel(root, 'apps/web/.release-it.json')).rejects.toThrow();
    await expect(
      getRel(root, 'libs/math-application/.release-it.json'),
    ).rejects.toThrow();
    const loom = await readLoom(root);
    expect(loom.files['.release-it.json']?.include).toEqual(['apps/.*']);
    expect(loom.files['.release-it.json']?.exclude).toEqual(['apps/web']);
  });

  it('keeps the init contract: gitignore block shape and untracking', async () => {
    const root = await baseRepo();
    await git(root, 'init', '-q');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-qm', 'chore: loom v1');

    // A pre-existing .release-it.js that happens to be tracked (the exact
    // incident from codibre/fluent-iterable#103): add must generate,
    // untrack it, and list it in the block like init would.
    await putFile(
      root,
      'apps/web/.release-it.js',
      "module.exports = require('../../.release-it.base.js');\n",
    );
    await git(root, 'add', '-f', 'apps/web/.release-it.js');
    await git(root, 'commit', '-qm', 'chore: stray tracked shim');

    const result = await addFiles(root, ['.release-it.js'], {
      runner: fakePnpmRunner,
    });
    expect(result.untracked).toContain('apps/web/.release-it.js');
    const stillTracked = await git(root, 'ls-files');
    expect(stillTracked).not.toContain('apps/web/.release-it.js');

    const ignore = await getRel(root, '.gitignore');
    expect(ignore).toContain(GITIGNORE_BEGIN);
    // exactly the init block shape: glob-synthesized lines, new file listed
    // side by side with the pre-managed ones for every workspace shape
    expect(ignore).toContain('apps/*/.release-it.js');
    expect(ignore).toContain('libs/*/.release-it.js');
    expect(ignore).toContain('tool/.release-it.js');
    expect(ignore).toContain('apps/*/tsconfig.json');
    expect(ignore).toContain('tool/tsconfig.json');

    // the file stays ON DISK (untrack, not delete)
    expect(await getRel(root, 'apps/web/.release-it.js')).toContain(
      'release-it.base',
    );

    const { config } = await loadConfig(root);
    const check = await checkAll(config, root, { runner: fakePnpmRunner });
    expect(check.ok).toBe(true);
  });

  it('dry run plans everything and writes nothing', async () => {
    const root = await baseRepo();
    const before = await getRel(root, 'config-loom.yaml');
    const result = await addFiles(root, ['.release-it.js'], {
      dryRun: true,
      runner: fakePnpmRunner,
    });
    expect(result.added[0]?.generated.length).toBeGreaterThan(0);
    expect(await getRel(root, 'config-loom.yaml')).toBe(before);
    await expect(getRel(root, 'apps/api/.release-it.js')).rejects.toThrow();
  });
});
