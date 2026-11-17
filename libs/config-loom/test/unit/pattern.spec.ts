import { synthesizePattern, globToRegExpSource } from '../../src/init';

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
