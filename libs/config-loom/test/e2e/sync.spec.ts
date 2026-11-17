import { checkAll } from '../../src/check';
import { compileConfig } from '../../src/config';
import { renderFile } from '../../src/render';
import { syncAll } from '../../src/sync';
import {
  createWorkspace,
  fakePnpmRunner,
  getRel,
  makeTempDir,
  putFile,
} from '../helpers';
import { parseJsonc } from '../../src/jsonc';
import type { LoomConfigInput } from '../../src/types';

const CONFIG: LoomConfigInput = {
  files: {
    'tsconfig.json': {
      format: 'jsonc',
      rules: {
        default: {
          compilerOptions: { target: 'es2023', strict: true },
          include: ['src'],
        },
        'apps/.*-legacy': { compilerOptions: { target: 'es2020' } },
        'libs/ui': {
          compilerOptions: { jsx: 'react-jsx' },
          include: ['src', 'test'],
        },
      },
    },
    'eslint.config.mjs': {
      format: 'text',
      rules: {
        default: "export { default } from '@repo/eslint-config';\n",
        'apps/core': "export { default } from '@repo/eslint-config/front';\n",
      },
    },
  },
};

async function makeRepo(): Promise<string> {
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
  await createWorkspace(root, 'apps/core');
  await createWorkspace(root, 'apps/my-legacy');
  await createWorkspace(root, 'libs/ui');
  await createWorkspace(root, 'libs/math');
  return root;
}

describe('syncAll', () => {
  it('generates every file, applying rules by declaration order', async () => {
    const root = await makeRepo();
    const config = compileConfig(CONFIG, 'test');
    const result = await syncAll(config, root, { runner: fakePnpmRunner });

    expect(result.created).toBe(8); // 4 workspaces x 2 files
    expect(result.updated).toBe(0);

    const legacy = parseJsonc(
      await getRel(root, 'apps/my-legacy/tsconfig.json'),
      'legacy',
    ) as any;
    expect(legacy.compilerOptions.target).toBe('es2020');
    expect(legacy.compilerOptions.strict).toBe(true);

    const ui = parseJsonc(
      await getRel(root, 'libs/ui/tsconfig.json'),
      'ui',
    ) as any;
    expect(ui.compilerOptions.jsx).toBe('react-jsx');
    expect(ui.include).toEqual(['src', 'test']);

    const plain = parseJsonc(
      await getRel(root, 'libs/math/tsconfig.json'),
      'math',
    ) as any;
    expect(plain.compilerOptions.target).toBe('es2023');

    const eslintCore = await getRel(root, 'apps/core/eslint.config.mjs');
    expect(eslintCore).toContain('front');
    const eslintLib = await getRel(root, 'libs/math/eslint.config.mjs');
    expect(eslintLib).toContain('@repo/eslint-config');
  });

  it('starts jsonc files with the banner and keeps them tsc-parseable', async () => {
    const root = await makeRepo();
    const config = compileConfig(CONFIG, 'test');
    await syncAll(config, root, { runner: fakePnpmRunner });
    const raw = await getRel(root, 'libs/math/tsconfig.json');
    expect(raw.split('\n')[0]).toContain('config-loom');
    expect(() => parseJsonc(raw, 'tsconfig.json')).not.toThrow();
  });

  it('is idempotent: second run changes nothing', async () => {
    const root = await makeRepo();
    const config = compileConfig(CONFIG, 'test');
    await syncAll(config, root, { runner: fakePnpmRunner });
    const second = await syncAll(config, root, { runner: fakePnpmRunner });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(8);
  });

  it('repairs hand edits (drift) and respects dryRun', async () => {
    const root = await makeRepo();
    const config = compileConfig(CONFIG, 'test');
    await syncAll(config, root, { runner: fakePnpmRunner });
    await putFile(root, 'libs/math/tsconfig.json', '{ "compilerOptions": {} }');

    const dry = await syncAll(config, root, {
      dryRun: true,
      runner: fakePnpmRunner,
    });
    expect(dry.updated).toBe(1);
    expect(
      (parseJsonc(await getRel(root, 'libs/math/tsconfig.json'), 'math') as any)
        .compilerOptions.strict,
    ).toBe(undefined);

    const wet = await syncAll(config, root, { runner: fakePnpmRunner });
    expect(wet.updated).toBe(1);
    expect(
      (parseJsonc(await getRel(root, 'libs/math/tsconfig.json'), 'math') as any)
        .compilerOptions.strict,
    ).toBe(true);
  });

  it('text entries: last matching rule wins, earlier ones still apply as base', async () => {
    const root = await makeRepo();
    const config = compileConfig(
      {
        files: {
          'style.txt': {
            format: 'text',
            rules: {
              default: 'base\n',
              'apps/.*': 'apps\n',
              'apps/core': 'core\n',
            },
          },
        },
      },
      'test',
    );
    await syncAll(config, root, { runner: fakePnpmRunner });
    expect(await getRel(root, 'apps/core/style.txt')).toBe('core\n');
    expect(await getRel(root, 'apps/my-legacy/style.txt')).toBe('apps\n');
    expect(await getRel(root, 'libs/ui/style.txt')).toBe('base\n');
  });

  it('default: null generates only for matched workspaces', async () => {
    const root = await makeRepo();
    const config = compileConfig(
      {
        files: {
          'vitest.config.mts': {
            format: 'text',
            rules: {
              default: null,
              'libs/.*': "export default { test: { name: 'lib' } };\n",
            },
          },
        },
      },
      'test',
    );
    const result = await syncAll(config, root, { runner: fakePnpmRunner });
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(2);
    expect(await getRel(root, 'libs/ui/vitest.config.mts')).toContain('lib');
    await expect(getRel(root, 'apps/core/vitest.config.mts')).rejects.toThrow();
  });

  it('renderFile is a pure helper over compiled entries', () => {
    const config = compileConfig(CONFIG, 'test');
    const entry = config.files['tsconfig.json'];
    if (!entry) throw new Error('missing entry');
    expect(renderFile(entry, 'docs/not-a-workspace')).toContain('es2023');
    expect(renderFile(entry, 'apps/other-legacy')).toContain('es2020');
  });

  it('a null rule opts workspaces out and removes the generated file', async () => {
    const root = await makeRepo();
    const config = compileConfig(CONFIG, 'test');
    await syncAll(config, root, { runner: fakePnpmRunner });

    const opted = compileConfig(
      {
        files: {
          'tsconfig.json': {
            format: 'jsonc',
            rules: {
              ...CONFIG.files['tsconfig.json']!.rules,
              'libs/math': null,
            },
          },
        },
      },
      'test',
    );

    // check reports the file as stale before anyone syncs
    const drift = await checkAll(opted, root, { runner: fakePnpmRunner });
    expect(drift.ok).toBe(false);
    expect(drift.drift).toEqual([
      expect.objectContaining({
        file: 'tsconfig.json',
        workspace: 'libs/math',
        status: 'deleted',
      }),
    ]);

    const result = await syncAll(opted, root, { runner: fakePnpmRunner });
    expect(result.deleted).toBe(1);
    await expect(getRel(root, 'libs/math/tsconfig.json')).rejects.toThrow();
    expect((await checkAll(opted, root, { runner: fakePnpmRunner })).ok).toBe(
      true,
    );
  });

  it('a later non-null rule revives a workspace after a broad opt-out', async () => {
    const root = await makeRepo();
    const config = compileConfig(
      {
        files: {
          'tsconfig.json': {
            format: 'jsonc',
            rules: { default: { a: 1 }, 'libs/.*': null, 'libs/ui': { b: 2 } },
          },
        },
      },
      'test',
    );
    await syncAll(config, root, { runner: fakePnpmRunner });
    await expect(getRel(root, 'libs/math/tsconfig.json')).rejects.toThrow();
    const ui = parseJsonc(
      await getRel(root, 'libs/ui/tsconfig.json'),
      'ui',
    ) as any;
    expect(ui.a).toBe(1);
    expect(ui.b).toBe(2);
  });

  it('never deletes a file it cannot prove it generated', async () => {
    const root = await makeRepo();
    const config = compileConfig(
      {
        files: {
          'style.txt': { format: 'text', rules: { default: 'base\n' } },
        },
      },
      'test',
    );
    await syncAll(config, root, { runner: fakePnpmRunner });

    const opted = compileConfig(
      {
        files: {
          'style.txt': {
            format: 'text',
            rules: { default: 'base\n', 'libs/ui': null },
          },
        },
      },
      'test',
    );
    // text entries carry no banner by default -> authorship unprovable -> skip
    const result = await syncAll(opted, root, { runner: fakePnpmRunner });
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await getRel(root, 'libs/ui/style.txt')).toBe('base\n');
  });
});

describe('checkAll', () => {
  it('passes right after sync and fails on stale or missing files', async () => {
    const root = await makeRepo();
    const config = compileConfig(CONFIG, 'test');
    await syncAll(config, root, { runner: fakePnpmRunner });
    expect((await checkAll(config, root, { runner: fakePnpmRunner })).ok).toBe(
      true,
    );

    await putFile(root, 'libs/math/tsconfig.json', '{"compilerOptions":{}}');
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rm(join(root, 'apps/core/eslint.config.mjs'));

    const result = await checkAll(config, root, { runner: fakePnpmRunner });
    expect(result.ok).toBe(false);
    expect(result.drift.map((item) => item.status).sort()).toEqual([
      'created',
      'updated',
    ]);
  });
});
