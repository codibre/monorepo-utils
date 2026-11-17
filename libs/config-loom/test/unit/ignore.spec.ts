import {
  synthesizeIgnoreList,
  synthesizeIgnorePatterns,
} from '../../src/ignore';

describe('synthesizeIgnorePatterns', () => {
  it('widens to the pnpm workspace globs when nothing else lives there', () => {
    const patterns = synthesizeIgnorePatterns('tsconfig.json', {
      workspaces: ['apps/api', 'apps/web', 'libs/math'],
      globs: ['apps/*', 'libs/*'],
      tracked: [
        'apps/api/tsconfig.json',
        'apps/web/tsconfig.json',
        'libs/math/tsconfig.json',
      ],
      managed: new Set([
        'apps/api/tsconfig.json',
        'apps/web/tsconfig.json',
        'libs/math/tsconfig.json',
      ]),
    });
    expect(patterns).toEqual(['apps/*/tsconfig.json', 'libs/*/tsconfig.json']);
  });

  it('rejects a wildcard that would swallow a tracked file the loom does not own', () => {
    const patterns = synthesizeIgnorePatterns('tsconfig.json', {
      workspaces: ['apps/api', 'apps/web'],
      globs: ['apps/*'],
      tracked: [
        'apps/api/tsconfig.json',
        'apps/web/tsconfig.json',
        'apps/legacy/tsconfig.json', // hand-owned, tracked, not managed
      ],
      managed: new Set(['apps/api/tsconfig.json', 'apps/web/tsconfig.json']),
    });
    expect(patterns).toEqual([
      'apps/api/tsconfig.json',
      'apps/web/tsconfig.json',
    ]);
  });

  it('ignores negated globs when widening', () => {
    const patterns = synthesizeIgnorePatterns('tsconfig.json', {
      workspaces: ['apps/api'],
      globs: ['!apps/secret', 'apps/*'],
      tracked: ['apps/api/tsconfig.json'],
      managed: new Set(['apps/api/tsconfig.json']),
    });
    expect(patterns).toEqual(['apps/*/tsconfig.json']);
  });

  it('collapses workspaces below every glob onto their parent directory', () => {
    const patterns = synthesizeIgnorePatterns('tsconfig.json', {
      workspaces: ['services/nest/api', 'services/nest/web', 'tools/cli'],
      globs: ['apps/*'],
      tracked: [
        'services/nest/api/tsconfig.json',
        'services/nest/web/tsconfig.json',
        'tools/cli/tsconfig.json',
      ],
      managed: new Set([
        'services/nest/api/tsconfig.json',
        'services/nest/web/tsconfig.json',
        'tools/cli/tsconfig.json',
      ]),
    });
    expect(patterns).toEqual([
      'services/nest/*/tsconfig.json',
      'tools/*/tsconfig.json', // a lone member under a glob still widens:
      // future members of the glob join the ignore rule for free
    ]);
  });

  it('synthesizes per file and dedupes across the whole plan', () => {
    const patterns = synthesizeIgnoreList(
      [
        { workspace: 'apps/api', file: 'tsconfig.json' },
        { workspace: 'apps/web', file: 'tsconfig.json' },
        { workspace: 'apps/web', file: 'vitest.config.mts' },
      ],
      ['apps/*'],
      new Set([
        'apps/api/tsconfig.json',
        'apps/web/tsconfig.json',
        'apps/web/vitest.config.mts',
      ]),
    );
    expect(patterns).toEqual([
      'apps/*/tsconfig.json',
      'apps/*/vitest.config.mts',
    ]);
  });
});
