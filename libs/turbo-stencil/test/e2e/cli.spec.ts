import { main } from '../../src/cli';
import { compileConfig } from '../../src/config';
import { syncAll } from '../../src/sync';
import { createWorkspace, makeTempDir, putFile } from '../helpers';

async function loadFrom(root: string) {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const text = await readFile(path.join(root, 'stencil.json'), 'utf8');
  return { config: compileConfig(JSON.parse(text), 'stencil.json') };
}

async function makeRepoWithStencil(): Promise<string> {
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
    'stencil.json',
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
      expect.stringContaining('stencil <command>'),
    );
    expect(await main(['version'])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0.0.0'));
  });

  it('unknown command exits 2', async () => {
    expect(await main(['frobnicate'])).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown command'),
    );
  });

  it('sync then check exit 0', async () => {
    const root = await makeRepoWithStencil();
    expect(await main(['sync', '--root', root])).toBe(0);
    expect(await main(['check', '--root', root])).toBe(0);
  });

  it('check exits 1 when files are stale and sync repairs', async () => {
    const root = await makeRepoWithStencil();
    expect(await main(['check', '--root', root])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('out of sync'),
    );
    expect(await main(['sync', '--root', root])).toBe(0);
    expect(await main(['check', '--root', root])).toBe(0);
  });

  it('sync without a stencil.json fails with a useful message', async () => {
    const root = await makeTempDir();
    expect(await main(['sync', '--root', root])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('stencil init'),
    );
  });

  it('dry-run writes nothing', async () => {
    const root = await makeRepoWithStencil();
    expect(await main(['sync', '--root', root, '--dry-run'])).toBe(0);
    // same repo, programmatic check of the same invariant
    const { config } = await loadFrom(root);
    const check = await syncAll(config, root, { dryRun: true });
    expect(check.created).toBe(1);
    await syncAll(config, root);
    const after = await syncAll(config, root, { dryRun: true });
    expect(after.created).toBe(0);
  });
});
