import { discoverWorkspaces, readWorkspaceGlobs } from '../../src/workspaces';
import { createWorkspace, makeTempDir, putFile } from '../helpers';

describe('readWorkspaceGlobs', () => {
  it('prefers pnpm-workspace.yaml', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'pnpm-workspace.yaml',
      "packages:\n  - 'apps/*'\n  - 'libs/**'\n",
    );
    await putFile(
      root,
      'package.json',
      JSON.stringify({ workspaces: ['ignored/*'] }),
    );
    expect(await readWorkspaceGlobs(root)).toEqual(['apps/*', 'libs/**']);
  });

  it('falls back to package.json workspaces (array and object forms)', async () => {
    const root = await makeTempDir();
    await putFile(
      root,
      'package.json',
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    expect(await readWorkspaceGlobs(root)).toEqual(['packages/*']);

    const root2 = await makeTempDir();
    await putFile(
      root2,
      'package.json',
      JSON.stringify({ workspaces: { packages: ['modules/*'] } }),
    );
    expect(await readWorkspaceGlobs(root2)).toEqual(['modules/*']);
  });

  it('returns empty when there is nothing', async () => {
    expect(await readWorkspaceGlobs(await makeTempDir())).toEqual([]);
  });
});

describe('discoverWorkspaces', () => {
  it('expands globs to directories containing package.json', async () => {
    const root = await makeTempDir();
    await createWorkspace(root, 'apps/api');
    await createWorkspace(root, 'apps/web');
    await createWorkspace(root, 'libs/ui/atoms');
    await putFile(root, 'apps/readme-only.md', '# not a workspace');

    const found = await discoverWorkspaces(root, ['apps/*', 'libs/**']);
    expect(found).toEqual(['apps/api', 'apps/web', 'libs/ui/atoms']);
  });

  it('honors negated patterns and exclude globs', async () => {
    const root = await makeTempDir();
    await createWorkspace(root, 'apps/a');
    await createWorkspace(root, 'apps/b');
    await createWorkspace(root, 'apps/skipme');

    expect(await discoverWorkspaces(root, ['apps/*', '!apps/skipme'])).toEqual([
      'apps/a',
      'apps/b',
    ]);
    expect(await discoverWorkspaces(root, ['apps/*'], ['apps/skip*'])).toEqual([
      'apps/a',
      'apps/b',
    ]);
  });

  it('never returns the root itself', async () => {
    const root = await makeTempDir();
    await putFile(root, 'package.json', '{}');
    await putFile(
      root,
      'pnpm-workspace.yaml',
      "packages:\n  - '.'\n  - 'apps/*'\n",
    );
    await createWorkspace(root, 'apps/a');
    expect(await discoverWorkspaces(root, ['.', 'apps/*'])).toEqual(['apps/a']);
  });
});
