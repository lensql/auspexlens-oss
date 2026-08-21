import { describe, it, expect } from 'vitest';
import { CAPABILITIES, NEEDS_CATALOG_ROLE, OUT_OF_SCOPE_V1, tierOf } from '../src/licensing/tiers';

describe('the free/paid boundary', () => {
  it('has no duplicate capability ids', () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps everything the marketing shows for free actually free', () => {
    // The hero lesson from RedLens: what a free call-to-action demonstrates has
    // to be free in fact, not just in the screenshot.
    for (const id of ['editor.execute', 'explorer.objects', 'explain.basic', 'mcp.readOnly',
                      'safety.readOnly', 'safety.piiMask']) {
      expect(tierOf(id), id).toBe('free');
    }
  });

  it('every capability needing SELECT_CATALOG_ROLE is a real capability', () => {
    for (const id of NEEDS_CATALOG_ROLE) {
      expect(CAPABILITIES.some((c) => c.id === id), id).toBe(true);
    }
  });

  it('AWR and ASH are out of scope by decision, not missing by accident', () => {
    expect(OUT_OF_SCOPE_V1).toContain('awr.snapshots');
    expect(OUT_OF_SCOPE_V1).toContain('ash.history');
    expect(tierOf('awr.snapshots')).toBe('out-of-scope');
  });

  it('thick mode and its auth modes are out of scope', () => {
    for (const id of ['driver.thick', 'auth.kerberos', 'auth.ociIam']) {
      expect(tierOf(id), id).toBe('out-of-scope');
    }
  });

  it('an unknown id is out of scope rather than accidentally free', () => {
    expect(tierOf('something.invented')).toBe('out-of-scope');
  });
});
