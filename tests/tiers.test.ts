import { describe, it, expect } from 'vitest';
import { ALWAYS_FREE, CAPABILITIES, NEEDS_CATALOG_ROLE, OUT_OF_SCOPE_V1, PLANNED,
         plannedTierOf, tierOf } from '../src/licensing/tiers';

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

describe('the principle, enforced rather than remembered', () => {
  it('keeps every safety capability free, and every connection capability too', () => {
    // The two rules the file's header states. A price experiment that moved any
    // of these would have to delete a test to do it, which is the point.
    for (const id of ALWAYS_FREE) {
      expect(tierOf(id), id).toBe('free');
    }
  });

  it('names only real capabilities as always-free', () => {
    for (const id of ALWAYS_FREE) {
      expect(CAPABILITIES.some((c) => c.id === id), id).toBe(true);
    }
  });

  it('covers every safety capability, so a new one cannot be born paid', () => {
    // A guard that only lists today's safety features would let tomorrow's ship
    // as Pro without anybody noticing. This asks the question the other way.
    for (const c of CAPABILITIES) {
      if (c.id.startsWith('safety.') || c.id.startsWith('connect.')) {
        expect(ALWAYS_FREE, c.id).toContain(c.id);
      }
    }
  });
});

describe('the roadmap: decided before it is built', () => {
  it('promises nothing it has not shipped', () => {
    // The 0.1.2 lesson, generalised. CAPABILITIES is what works; PLANNED is what
    // was decided. An id in both would be a promise with no code behind it.
    for (const p of PLANNED) {
      expect(CAPABILITIES.some((c) => c.id === p.id), p.id).toBe(false);
    }
  });

  it('reports a planned capability as out of scope to a user asking today', () => {
    for (const p of PLANNED) {
      expect(tierOf(p.id), p.id).toBe('out-of-scope');
    }
  });

  it('still remembers the tier it was given, for the change that ships it', () => {
    for (const p of PLANNED) {
      expect(plannedTierOf(p.id), p.id).toBe(p.tier);
    }
    expect(plannedTierOf('never.decided')).toBeUndefined();
  });

  it('has no duplicate ids, within itself or against the shipped list', () => {
    const ids = [...CAPABILITIES.map((c) => c.id), ...PLANNED.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('makes every AI capability Pro (PD-5)', () => {
    const ai = PLANNED.filter((c) => c.pillar === 'ai');
    expect(ai.length).toBeGreaterThan(0);
    for (const c of ai) {
      expect(c.tier, c.id).toBe('pro');
    }
  });

  it('never plans a paid feature on top of a pack the customer pays for', () => {
    // D7 extended: AWR/ASH answer without error and bill the customer's
    // Diagnostics Pack; the Tuning Pack does the same for advisors. A Pro
    // feature of ours must not silently spend a licence of theirs.
    const forbidden = /\bawr\b|\bash\b|dba_hist|diagnostics pack|tuning pack|sql tuning advisor/i;
    for (const c of PLANNED) {
      expect(forbidden.test(c.builtOn), `${c.id}: ${c.builtOn}`).toBe(false);
    }
  });

  it('starts with governance, which is the order Diego chose (PD-4)', () => {
    expect(PLANNED[0]?.pillar).toBe('governance');
  });

  it('leaves schema and data compare out of scope while PD-6 is open', () => {
    // Deliberately in neither list: unbuilt, and with no tier decided. Moving it
    // to PLANNED is what taking the decision looks like.
    for (const id of ['schema.compare', 'data.compare']) {
      expect(tierOf(id), id).toBe('out-of-scope');
      expect(plannedTierOf(id), id).toBeUndefined();
    }
  });
});
