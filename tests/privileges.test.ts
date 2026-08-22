/**
 * The unit tests `privileges.ts` never had, and the absence is the story.
 *
 * `probePrivileges` shipped in 0.1.1 with `canCreate` permanently TRUE — for every
 * connection, including the least-privileged account the product itself
 * recommends — because it asked "did the statement run" of a query that always
 * runs. Nothing caught it: there was no unit test at all, and the live test
 * against the container happened to use an account that really could create, so
 * the assertion `if (p.canCreate) …` took the true branch every time and never
 * had an opinion about whether true was right.
 *
 * These are deliberately fakes rather than a database. The question is not what
 * Oracle answers — the live suite asks that against two real accounts, one with
 * privileges and one with none. The question here is whether this function reads
 * the answer, and a fake is the only way to hand it "the query ran and returned
 * nothing", which is exactly the case it used to get wrong.
 */

import { describe, it, expect } from 'vitest';
import { probePrivileges, privilegeAdvice } from '../src/catalog/privileges';

/**
 * A connection that answers each probe by what its SQL is about.
 *
 * `deniedTables` raise the way Oracle does when the privilege is missing — the
 * statement does not parse. `createPrivileges` is what user_sys_privs would
 * return, so an empty list means the EXISTS query runs and yields nothing.
 */
const fakeConn = (opts: { deniedTables?: string[]; createPrivileges?: string[] }) => ({
  execute: async (sql: string) => {
    const denied = (opts.deniedTables ?? []).find((t) => sql.toLowerCase().includes(t.toLowerCase()));
    if (denied) throw new Error(`ORA-00942: table or view does not exist (${denied})`);
    if (sql.includes('user_sys_privs')) {
      // The real query filters in SQL; the fake filters here, with the same rule,
      // so a change to the predicate that this file does not know about shows up
      // as a disagreement rather than as silence.
      const matching = (opts.createPrivileges ?? []).filter(
        (p) => p.startsWith('CREATE ') && p !== 'CREATE SESSION',
      );
      return { rows: matching.length ? [[1]] : [] };
    }
    return { rows: [[1]] };
  },
});

describe('probePrivileges', () => {
  it('an account with only CREATE SESSION cannot create — the case that was wrong', async () => {
    const p = await probePrivileges(
      fakeConn({ deniedTables: ['v$session'], createPrivileges: ['CREATE SESSION'] }),
    );
    expect(p.catalog).toBe(true);
    expect(p.performanceViews).toBe(false);
    expect(p.canCreate).toBe(false);
  });

  it('a query that RUNS and returns nothing is an answer of no', async () => {
    // The regression in one line. Before the fix this returned true, because the
    // statement executed — and executing was mistaken for finding something.
    const p = await probePrivileges(fakeConn({ createPrivileges: [] }));
    expect(p.canCreate).toBe(false);
  });

  it('a real CREATE privilege is found', async () => {
    const p = await probePrivileges(fakeConn({ createPrivileges: ['CREATE SESSION', 'CREATE TABLE'] }));
    expect(p.canCreate).toBe(true);
  });

  it('CREATE ANY TABLE counts, and so does anything else that makes objects', async () => {
    const p = await probePrivileges(fakeConn({ createPrivileges: ['CREATE ANY TABLE'] }));
    expect(p.canCreate).toBe(true);
  });

  it('no catalog access at all is reported rather than crashing', async () => {
    const p = await probePrivileges(
      fakeConn({ deniedTables: ['all_tables', 'v$session', 'user_sys_privs'] }),
    );
    expect(p).toEqual({ catalog: false, performanceViews: false, canCreate: false });
  });

  it('SELECT_CATALOG_ROLE opens the performance views', async () => {
    const p = await probePrivileges(fakeConn({ createPrivileges: ['CREATE SESSION'] }));
    expect(p.performanceViews).toBe(true);
  });
});

describe('privilegeAdvice', () => {
  it('says nothing when there is nothing to say', () => {
    // The whole point of the fix: the recommended connection — catalog readable,
    // v$ readable, no DDL — must produce silence. Advice that fires on the
    // recommended configuration is advice that gets clicked through.
    expect(privilegeAdvice({ catalog: true, performanceViews: true, canCreate: false })).toEqual([]);
  });

  it('names the exact grant when the v$ views are missing', () => {
    const advice = privilegeAdvice({ catalog: true, performanceViews: false, canCreate: false });
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatch(/GRANT SELECT_CATALOG_ROLE TO <user>/);
    // And it must not also complain about DDL, which is the noise the fix removed.
    expect(advice.join(' ')).not.toMatch(/can create objects/);
  });

  it('warns about DDL only when the account really can', () => {
    const advice = privilegeAdvice({ catalog: true, performanceViews: true, canCreate: true });
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatch(/does not block DDL/);
  });

  it('an unusable connection is told what is missing first', () => {
    const advice = privilegeAdvice({ catalog: false, performanceViews: false, canCreate: false });
    expect(advice[0]).toMatch(/cannot read the ALL_\* catalog views/);
  });
});
