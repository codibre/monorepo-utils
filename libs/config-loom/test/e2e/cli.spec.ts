import { main } from '../../src/cli';
import { compileConfig } from '../../src/config';
import { syncAll } from '../../src/sync';
import {
  createWorkspace,
  fakePnpmRunner,
  makeTempDir,
  putFile,
} from '../helpers';

async function loadFrom(root: string) {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const text = await readFile(path.join(root, 'config-loom.json'), 'utf8');
  return { config: compileConfig(JSON.parse(text), 'config-loom.json') };
}

async function makeRepoWithLoom(): Promise<string> {
  const root = await makeTempDir();
  await putFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n");
  await putFile(
    root,
    'package.json',
    JSON.stringify({ name: 'root', private: true }),
  );
  await createWorkspace(root, 'apps/api');
  await putFile(
    root,
    'config-loom.json',
    JSON.stringify({
      files: {
        'tsconfig.json': {
          rules: { default: { compilerOptions: { strict: true } } },
        },
      },
    }),
  );
  return root;
}

describe('cli main()', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('help and version exit 0', async () => {
    expect(await main(['help'])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('loom <command>'),
    );
    expect(await main(['version'])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/\d+\.\d+\.\d+/));
  });

  it('unknown command exits 2', async () => {
    expect(await main(['frobnicate'])).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown command'),
    );
  });

  it('sync then check exit 0', async () => {
    const root = await makeRepoWithLoom();
    expect(
      await main(['sync', '--root', root], { runner: fakePnpmRunner }),
    ).toBe(0);
    expect(
      await main(['check', '--root', root], { runner: fakePnpmRunner }),
    ).toBe(0);
  });

  it('check exits 1 when files are stale and sync repairs', async () => {
    const root = await makeRepoWithLoom();
    expect(
      await main(['check', '--root', root], { runner: fakePnpmRunner }),
    ).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('out of sync'),
    );
    expect(
      await main(['sync', '--root', root], { runner: fakePnpmRunner }),
    ).toBe(0);
    expect(
      await main(['check', '--root', root], { runner: fakePnpmRunner }),
    ).toBe(0);
  });

  it('sync without a config-loom.json fails with a useful message', async () => {
    const root = await makeTempDir();
    expect(
      await main(['sync', '--root', root], { runner: fakePnpmRunner }),
    ).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('loom init'));
  });

  it('dry-run writes nothing', async () => {
    const root = await makeRepoWithLoom();
    expect(
      await main(['sync', '--root', root, '--dry-run'], {
        runner: fakePnpmRunner,
      }),
    ).toBe(0);
    // same repo, programmatic check of the same invariant
    const { config } = await loadFrom(root);
    const check = await syncAll(config, root, {
      dryRun: true,
      runner: fakePnpmRunner,
    });
    expect(check.created).toBe(1);
    await syncAll(config, root, { runner: fakePnpmRunner });
    const after = await syncAll(config, root, {
      dryRun: true,
      runner: fakePnpmRunner,
    });
    expect(after.created).toBe(0);
  });
});
