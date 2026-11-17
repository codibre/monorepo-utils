import { synthesizePattern } from '../../src/init';

describe('synthesizePattern', () => {
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
});
