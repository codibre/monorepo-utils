import { discoverWorkspaces } from '../../src/workspaces';
import { createWorkspace, makeTempDir, putFile } from '../helpers';

function fakeRunner(...dirs: string[]) {
  return async () => dirs.join('\n') + '\n';
}

async function repoWithWorkspaceYaml(): Promise<string> {
  const root = await makeTempDir();
  await putFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n");
  return root;
}

describe('discoverWorkspaces', () => {
  it('turns `pnpm -r exec pwd` output into sorted, root-relative posix paths', async () => {
    const root = await repoWithWorkspaceYaml();
    const run = fakeRunner(`${root}/libs/b`, `${root}/apps/a`);
    expect(await discoverWorkspaces(root, [], run)).toEqual([
      'apps/a',
      'libs/b',
    ]);
  });

  it('ignores informational pnpm lines mixed into stdout', async () => {
    const root = await repoWithWorkspaceYaml();
    const run = fakeRunner(
      'Scope: all 2 workspace projects',
      '',
      `${root}/apps/a`,
      'Done in 13ms using pnpm v12.5.1',
      `${root}/apps/b`,
    );
    expect(await discoverWorkspaces(root, [], run)).toEqual([
      'apps/a',
      'apps/b',
    ]);
  });

  it('drops the workspace root itself and paths outside the repo', async () => {
    const root = await repoWithWorkspaceYaml();
    const run = fakeRunner(root, `${root}/../sibling`, `${root}/apps/a`);
    expect(await discoverWorkspaces(root, [], run)).toEqual(['apps/a']);
  });

  it('applies exclude globs', async () => {
    const root = await repoWithWorkspaceYaml();
    const run = fakeRunner(
      `${root}/apps/keep`,
      `${root}/apps/draft-x`,
      `${root}/apps/draft-y`,
    );
    expect(await discoverWorkspaces(root, ['apps/draft-*'], run)).toEqual([
      'apps/keep',
    ]);
  });

  it('throws outside a pnpm workspace', async () => {
    const root = await makeTempDir();
    await putFile(root, 'package.json', JSON.stringify({ name: 'solo' }));
    await expect(discoverWorkspaces(root)).rejects.toThrow(
      /only supports pnpm workspaces/,
    );
  });

  it('throws when pnpm lists nothing', async () => {
    const root = await repoWithWorkspaceYaml();
    await expect(discoverWorkspaces(root, [], fakeRunner())).rejects.toThrow(
      /no workspaces/,
    );
  });

  it('integrates with a real pnpm (dep-less fixtures need no install)', async () => {
    const root = await makeTempDir('loom-real-pnpm-');
    await putFile(
      root,
      'pnpm-workspace.yaml',
      "packages:\n  - 'apps/*'\n  - 'libs/*'\n",
    );
    await createWorkspace(root, 'apps/a');
    await createWorkspace(root, 'libs/b');
    const dirs = await discoverWorkspaces(root);
    expect(dirs).toEqual(['apps/a', 'libs/b']);
  }, 60_000);
});
