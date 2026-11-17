import { deriveOutputs, wireRepo } from '../../src/wire';
import { getRel, makeTempDir, putFile } from '../helpers';

/** Drop full-line comments so JSON.parse can read a JSONC fixture. */
function stripComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

async function makeWireRepo(turbo: string): Promise<string> {
  const root = await makeTempDir();
  await putFile(
    root,
    'package.json',
    JSON.stringify(
      { name: 'root', private: true, scripts: { build: 'turbo build' } },
      null,
      2,
    ),
  );
  await putFile(root, 'turbo.json', turbo);
  return root;
}

const TURBO_V2 = `{
  // our pipeline lives here
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": {},
    "lint": { "dependsOn": ["^lint"] }
  }
}
`;

describe('deriveOutputs', () => {
  it('globs each top-level directory at any depth', () => {
    expect(
      deriveOutputs(
        ['apps/api', 'apps/web', 'libs/ui/atoms'],
        ['tsconfig.json', 'eslint.config.mjs'],
      ),
    ).toEqual([
      'apps/**/eslint.config.mjs',
      'apps/**/tsconfig.json',
      'libs/**/eslint.config.mjs',
      'libs/**/tsconfig.json',
    ]);
  });
});

describe('wireRepo', () => {
  it('adds scripts and the turbo root task, preserving comments', async () => {
    const root = await makeWireRepo(TURBO_V2);
    const report = await wireRepo(root, { outputs: ['apps/**/tsconfig.json'] });

    expect(report.scriptsAdded).toEqual(['postinstall', 'config-loom']);
    expect(report.turbo?.addedTask).toBe(true);
    expect(report.turbo?.dependsOnAdded).toEqual(['build', 'test', 'lint']);

    const pkg = JSON.parse(await getRel(root, 'package.json'));
    expect(pkg.scripts.postinstall).toBe('config-loom sync');
    expect(pkg.scripts['config-loom']).toBe('config-loom sync');
    expect(pkg.scripts.build).toBe('turbo build');

    const turboText = await getRel(root, 'turbo.json');
    expect(turboText).toContain('// our pipeline lives here');
    expect(turboText).not.toContain('//**'); // comment never swallows entries
    const turbo = JSON.parse(
      turboText.includes('//') ? stripComments(turboText) : turboText,
    );
    expect(turbo.tasks['//#config-loom']).toEqual({
      inputs: ['config-loom.yaml', 'config-loom.yml', 'pnpm-workspace.yaml'],
      outputs: ['apps/**/tsconfig.json'],
      cache: true,
    });
    expect(turbo.tasks.build.dependsOn).toEqual(['^build', '//#config-loom']);
    expect(turbo.tasks.test.dependsOn).toEqual(['//#config-loom']);
    expect(turbo.tasks.lint.dependsOn).toEqual(['^lint', '//#config-loom']);
  });

  it('is idempotent', async () => {
    const root = await makeWireRepo(TURBO_V2);
    await wireRepo(root, { outputs: ['apps/**/tsconfig.json'] });
    const once = await getRel(root, 'turbo.json');
    const oncePkg = await getRel(root, 'package.json');

    const second = await wireRepo(root, { outputs: ['apps/**/tsconfig.json'] });
    expect(second.scriptsAdded).toEqual([]);
    expect(second.turbo).toBeNull();
    expect(second.notes).toEqual([]);
    expect(await getRel(root, 'turbo.json')).toBe(once);
    expect(await getRel(root, 'package.json')).toBe(oncePkg);
  });

  it('never overwrites an existing postinstall', async () => {
    const root = await makeWireRepo(TURBO_V2);
    await putFile(
      root,
      'package.json',
      JSON.stringify({ scripts: { postinstall: 'husky' } }, null, 2),
    );
    const report = await wireRepo(root, { outputs: [] });
    expect(report.scriptsAdded).toEqual(['config-loom']);
    expect(report.notes.join(' ')).toContain('husky');
    expect(
      JSON.parse(await getRel(root, 'package.json')).scripts.postinstall,
    ).toBe('husky');
  });

  it('supports turbo v1 pipeline key', async () => {
    const root = await makeWireRepo(
      JSON.stringify({ pipeline: { build: {} } }, null, 2),
    );
    const report = await wireRepo(root, { outputs: [] });
    expect(report.turbo?.addedTask).toBe(true);
    const turbo = JSON.parse(await getRel(root, 'turbo.json'));
    expect(turbo.pipeline['//#config-loom']).toBeDefined();
    expect(turbo.tasks).toBeUndefined();
  });

  it('dry run writes nothing', async () => {
    const root = await makeWireRepo(TURBO_V2);
    const before = await getRel(root, 'turbo.json');
    const beforePkg = await getRel(root, 'package.json');
    const report = await wireRepo(root, {
      outputs: [],
      dryRun: true,
    });
    expect(report.turbo?.addedTask).toBe(true);
    expect(await getRel(root, 'turbo.json')).toBe(before);
    expect(await getRel(root, 'package.json')).toBe(beforePkg);
  });
});
