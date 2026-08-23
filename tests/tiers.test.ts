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

  it('advertises wallet connections again, now that a command imports one', () => {
    // The full arc, kept because it is the rule this file lives by: free in 0.1.0
    // and 0.1.1 while unreachable, withdrawn in 0.1.2 the moment that was
    // discovered, and back in 0.2.0 in the same change that shipped
    // “AuspexLens: Import wallet”. Listed when it works, not when it is intended.
    expect(tierOf('connect.wallet')).toBe('free');
    expect(CAPABILITIES.some((c) => c.id === 'connect.wallet')).toBe(true);
  });

  it('promises reconnection only because the manager implements it', () => {
    // Paired with manager.test.ts and the live kill-session case. A capability
    // listed here is a promise to a paying market, so the test that pins the
    // promise and the test that pins the behaviour reference each other.
    expect(tierOf('connect.reconnect')).toBe('free');
  });
});
