import {
  synthesizePattern,
  synthesizeExclude,
  globToRegExpSource,
} from '../../src/init';

describe('synthesizeExclude', () => {
  it('finds prefix and suffix naming families', () => {
    const all = [
      'apps/medicine-quotation-api',
      'apps/medicine-quotation-cli',
      'packages/capacitor-a',
      'packages/capacitor-b',
      'packages/medicine-quotation-sdk',
      'packages/mq-apm',
      'packages/mq-bus',
      'packages/mq-logger',
      'packages/farmaciasapp-medicine-quotation-sdk',
      'packages/panvel-medicine-quotation-sdk',
    ];
    const present = new Set([
      'apps/medicine-quotation-api',
      'packages/capacitor-a',
      'packages/capacitor-b',
      'packages/medicine-quotation-sdk',
    ]);
    const missing = all.filter((ws) => !present.has(ws));
    expect(synthesizeExclude(missing, present, all)).toEqual([
      'packages/.*-medicine-quotation-sdk',
      'packages/mq-.*',
      'apps/medicine-quotation-cli',
    ]);
  });

  it('collapses a directory whose whole subtree lacks the file', () => {
    const all = ['apps/a', 'apps/b', 'libs/x'];
    expect(
      synthesizeExclude(
        ['apps/a', 'apps/b', 'libs/x'],
        new Set(['libs/x']),
        all,
      ),
    ).toEqual(['apps/.*', 'libs/x']);
  });

  it('never excludes a workspace that holds the file', () => {
    const all = ['packages/a-x', 'packages/b-x', 'packages/c-x'];
    expect(
      synthesizeExclude(
        ['packages/a-x', 'packages/b-x'],
        new Set(['packages/c-x']),
        all,
      ),
    ).toEqual(['packages/a-x|packages/b-x']);
  });

  it('returns null when nothing collapses compactly', () => {
    const all = [
      'apps/x1',
      'apps/x2',
      'apps/x3',
      'apps/x4',
      'apps/x5',
      'apps/x6',
    ];
    expect(
      synthesizeExclude(
        ['apps/x2', 'apps/x3', 'apps/x4', 'apps/x5', 'apps/x6'],
        new Set(['apps/x1']),
        all,
      ),
    ).toBeNull();
  });
});

describe('synthesizePattern', () => {
  it('globToRegExpSource translates only the shapes we understand', () => {
    expect(globToRegExpSource('apps/*')).toBe('apps/[^/]+');
    expect(globToRegExpSource('libs/services/**')).toBe(
      'libs/services(?:/.*)?',
    );
    expect(globToRegExpSource('apps/*/nested')).toBeNull();
  });

  it('escapes a single member', () => {
    expect(synthesizePattern(['apps/api-gateway'], ['apps/api-gateway'])).toBe(
      'apps/api-gateway',
    );
  });

  it('uses the shared parent + suffix when it matches exactly the cluster', () => {
    const all = [
      'libs/auth-application',
      'libs/billing-application',
      'libs/ui',
    ];
    const pattern = synthesizePattern(
      ['libs/auth-application', 'libs/billing-application'],
      all,
    );
    expect(pattern).toBe('libs/.*-application');
  });

  it('falls back to the exact alternation when a cleverer pattern would over-match', () => {
    const all = [
      'libs/a-application',
      'libs/b-application',
      'libs/c-application-tools',
    ];
    const pattern = synthesizePattern(
      ['libs/a-application', 'libs/b-application'],
      all,
    );
    const regex = new RegExp(`^(?:${pattern})$`);
    expect(all.filter((ws) => regex.test(ws))).toEqual([
      'libs/a-application',
      'libs/b-application',
    ]);
  });

  it('collapses members under one parent into a prefixed alternation', () => {
    const all = ['apps/bff', 'apps/vd-gestao-admin', 'apps/other'];
    const pattern = synthesizePattern(
      ['apps/bff', 'apps/vd-gestao-admin'],
      all,
    );
    const regex = new RegExp(`^(?:${pattern})$`);
    expect(all.filter((ws) => regex.test(ws))).toEqual([
      'apps/bff',
      'apps/vd-gestao-admin',
    ]);
  });

  it('always produces a regex that matches exactly the members', () => {
    const all = ['a/x', 'b/y', 'c/x', 'deep/dir/x', 'x'];
    const members = ['a/x', 'c/x', 'x'];
    const pattern = synthesizePattern(members, all);
    const regex = new RegExp(`^(?:${pattern})$`);
    expect(all.filter((ws) => regex.test(ws)).sort()).toEqual(members);
  });

  it('widens a fully covered directory to a subtree wildcard', () => {
    const all = ['apps/a', 'apps/b', 'libs/ui'];
    expect(synthesizePattern(['apps/a', 'apps/b'], all)).toBe('apps/.*');
  });

  it('uses the whole-subtree shape when the cluster is every descendant', () => {
    const all = ['services/nest/a', 'services/nest/deep/b', 'apps/web'];
    expect(
      synthesizePattern(['services/nest/a', 'services/nest/deep/b'], all),
    ).toBe('services/nest/.*');
  });

  it('uses a bounded common name prefix so future siblings join for free', () => {
    const all = [
      'packages/capacitor-native-google-auth',
      'packages/capacitor-residential-fetch',
      'packages/medicine-quotation-sdk',
    ];
    expect(
      synthesizePattern(
        [
          'packages/capacitor-native-google-auth',
          'packages/capacitor-residential-fetch',
        ],
        all,
      ),
    ).toBe('packages/capacitor-.*');
  });

  it('uses ** as the full-repo shape when the cluster covers everything', () => {
    const all = ['apps/a', 'apps/b', 'libs/ui'];
    expect(synthesizePattern(all, all, ['**'])).toBe('.*');
  });

  it('still validates glob candidates: over-match falls back', () => {
    const all = ['apps/a', 'apps/b', 'libs/ui'];
    const pattern = synthesizePattern(['apps/a', 'libs/ui'], all, [
      'apps/*',
      'libs/*',
    ]);
    const regex = new RegExp(`^(?:${pattern})$`);
    expect(all.filter((ws) => regex.test(ws)).sort()).toEqual([
      'apps/a',
      'libs/ui',
    ]);
  });
});

// Issue #3: clusters spanning many subfolders used to fall back to one huge
// full-path alternation. They must now collapse into per-directory shapes.
describe('synthesizePattern generalization (issue #3)', () => {
  const workspaces = [
    'apps/bff',
    'apps/gestao-vd-admin',
    'apps/worker',
    'libs/adapters/cache',
    'libs/adapters/configcat',
    'libs/adapters/s3',
    'libs/adapters/sftp',
    'libs/adapters/sqs',
    'libs/adapters/storage',
    'libs/adapters/database',
    'libs/adapters/http',
    'libs/domain/models',
    'libs/domain/ports',
    'libs/shared/datetime',
    'libs/shared/validation',
    'libs/shared/errors',
  ];
  const members = [
    'apps/bff',
    'apps/gestao-vd-admin',
    'apps/worker',
    'libs/adapters/cache',
    'libs/adapters/configcat',
    'libs/adapters/s3',
    'libs/adapters/sftp',
    'libs/adapters/sqs',
    'libs/adapters/storage',
    'libs/domain/models',
    'libs/shared/datetime',
    'libs/shared/validation',
  ];

  it('composes per-directory shapes instead of a full-path list', () => {
    const pattern = synthesizePattern(members, workspaces);
    const regex = new RegExp(`^(?:${pattern})$`);
    expect(workspaces.filter((ws) => regex.test(ws)).sort()).toEqual(
      [...members].sort(),
    );
    const raw = members.join('|');
    expect(pattern.length).toBeLessThan(raw.length);
    expect(pattern).toContain('apps/.*');
    // adapters is a mostly-covered directory: the guard shape wins there.
    expect(pattern).toContain('(?!database$|http$)');
  });

  it('a future sibling in a guarded directory joins without editing the key', () => {
    const pattern = synthesizePattern(members, workspaces);
    const regex = new RegExp(`^(?:${pattern})$`);
    expect(regex.test('apps/future-app')).toBe(true);
    expect(regex.test('libs/adapters/queue')).toBe(true);
    expect(regex.test('libs/adapters/database')).toBe(false);
    expect(regex.test('libs/adapters/http')).toBe(false);
  });

  it('factors the shared directory prefix once', () => {
    const all = [
      'libs/adapters/db',
      'libs/adapters/cache',
      'libs/domain/models',
      'libs/domain/auth',
      'libs/shared/logger',
      'apps/web',
    ];
    const pattern = synthesizePattern(
      ['libs/adapters/cache', 'libs/domain/models', 'libs/shared/logger'],
      all,
    );
    expect(pattern.startsWith('libs/(?:')).toBe(true);
    const regex = new RegExp(`^(?:${pattern})$`);
    expect(all.filter((ws) => regex.test(ws)).sort()).toEqual([
      'libs/adapters/cache',
      'libs/domain/models',
      'libs/shared/logger',
    ]);
  });

  it('expresses near-total coverage as a root-level exclusion', () => {
    // A small repository has compact per-directory shapes; the root guard
    // only earns the key when the composite would be much longer.
    const dirs: string[] = [];
    for (let i = 0; i < 12; i++) {
      dirs.push(`group-${i}/project`);
    }
    const all = [...dirs, 'tools/exceptions-a', 'tools/exceptions-b'];
    const pattern = synthesizePattern(dirs, all);
    expect(pattern).toBe('(?!tools/exceptions-a$|tools/exceptions-b$).*');
    // per-directory shapes are preferred when they are not much longer:
    const small = ['apps/a', 'apps/b', 'libs/x', 'libs/y', 'libs/z'];
    const composite = synthesizePattern(
      ['apps/a', 'apps/b', 'libs/x', 'libs/y'],
      small,
    );
    expect(composite.startsWith('(?!')).toBe(false);
    const regex = new RegExp(`^(?:${composite})$`);
    expect(small.filter((ws) => regex.test(ws)).sort()).toEqual([
      'apps/a',
      'apps/b',
      'libs/x',
      'libs/y',
    ]);
  });

  it('keeps a naming-family key over a more aggressive guard', () => {
    const all = [
      'libs/auth-application',
      'libs/billing-application',
      'libs/ui',
    ];
    expect(
      synthesizePattern(
        ['libs/auth-application', 'libs/billing-application'],
        all,
      ),
    ).toBe('libs/.*-application');
  });
});
