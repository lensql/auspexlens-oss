/**
 * Deriving a CDB-root profile from a PDB one.
 *
 * The estate features are gated by which container you connected to, not by a
 * privilege — Oracle's Multitenant guide is explicit that a session in a PDB sees
 * that PDB only, and no grant changes it. So the way across is another connection
 * profile, and these tests are about the three ways that can go wrong quietly:
 * overwriting an existing profile, mangling a connect string that was never
 * host/port/service, and presenting a guess as if it were a fact.
 */
import { describe, it, expect } from 'vitest';
import { proposeRootProfile, rootProfileAdvice } from '../src/connections/rootProfile';
import type { ProfileConfig } from '../src/connections/manager';

const pdb: ProfileConfig = {
  id: 'sales',
  label: 'Sales (prod)',
  user: 'app_reader',
  connectString: 'db.example.invalid:1521/SALESPDB',
  kind: 'basic',
};

describe('the service is swapped, and nothing else is invented', () => {
  it('keeps the host and port, replacing only the service', () => {
    const { profile, service } = proposeRootProfile(pdb, 'ORCLCDB');
    expect(profile.connectString).toBe('db.example.invalid:1521/ORCLCDB');
    expect(service).toBe('ORCLCDB');
  });

  it('works when the connect string carries no explicit port', () => {
    const { profile } = proposeRootProfile({ ...pdb, connectString: 'db.example.invalid/SALESPDB' }, 'ORCLCDB');
    expect(profile.connectString).toBe('db.example.invalid/ORCLCDB');
  });

  it('preserves driver parameters that ride on the connect string', () => {
    // `?njs.stmtCacheSize=…` and friends are documented Easy Connect extensions.
    // Dropping them would silently change how the new connection behaves.
    const { profile } = proposeRootProfile(
      { ...pdb, connectString: 'db.example.invalid:1521/SALESPDB?njs.stmtCacheSize=50' },
      'ORCLCDB',
    );
    expect(profile.connectString).toBe('db.example.invalid:1521/ORCLCDB?njs.stmtCacheSize=50');
  });

  it('carries the user over rather than inventing one', () => {
    expect(proposeRootProfile(pdb, 'ORCLCDB').profile.user).toBe('app_reader');
  });

  it('labels it so the two are distinguishable in a picker', () => {
    expect(proposeRootProfile(pdb, 'ORCLCDB').profile.label).toBe('Sales (prod) — CDB root');
  });
});

describe('it never overwrites a profile that already exists', () => {
  it('uses the obvious id when it is free', () => {
    expect(proposeRootProfile(pdb, 'ORCLCDB', []).profile.id).toBe('sales-root');
  });

  it('steps aside when that id is taken', () => {
    expect(proposeRootProfile(pdb, 'ORCLCDB', ['sales-root']).profile.id).toBe('sales-root-2');
    expect(proposeRootProfile(pdb, 'ORCLCDB', ['sales-root', 'sales-root-2']).profile.id)
      .toBe('sales-root-3');
  });
});

describe('refusing rather than mangling', () => {
  it('refuses a wallet profile, whose connect string is a TNS alias', () => {
    // There is no host and service to rewrite in an alias — it is resolved from
    // tnsnames.ora. Rewriting it would produce a profile that cannot resolve.
    expect(() => proposeRootProfile({ ...pdb, kind: 'wallet', connectString: 'salespdb_high' }, 'ORCLCDB'))
      .toThrow(/TNS alias/);
  });

  it('refuses a connect string it cannot read as host:port/service', () => {
    for (const connectString of ['not a connect string', '', 'db.example.invalid', '/SALESPDB']) {
      expect(() => proposeRootProfile({ ...pdb, connectString }, 'ORCLCDB'), connectString).toThrow();
    }
  });

  it('refuses when the database reported no name to use', () => {
    expect(() => proposeRootProfile(pdb, '   ')).toThrow(/did not report a name/);
  });
});

describe('what the user is told before anything is saved', () => {
  it('says the service is the usual name, not a fact about their database', () => {
    const advice = rootProfileAdvice('ORCLCDB', 'app_reader');
    expect(advice).toContain('ORCLCDB');
    expect(advice).toMatch(/usual name/);
  });

  it('warns that a PDB-local account normally cannot log in to the root', () => {
    // The surprise that would otherwise arrive as "AuspexLens created a
    // connection that does not work".
    const advice = rootProfileAdvice('ORCLCDB', 'app_reader');
    expect(advice).toContain('app_reader');
    expect(advice).toMatch(/common user/);
    expect(advice).toMatch(/editable/);
  });
});
