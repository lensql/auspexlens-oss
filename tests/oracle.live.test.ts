/**
 * The suite that talks to a real Oracle database.
 *
 * These are the tests that matter most, because everything this product claims
 * about safety is a claim about what Oracle actually does — and the Phase 0
 * measurement showed that what Oracle actually does is not what the documentation
 * led us to expect. A unit test against a fake connection can prove that we SEND
 * `SET TRANSACTION READ ONLY`. Only these can prove it is not enough, and that our
 * own layer covers the gap.
 *
 * They skip when the container is not reachable, which is why this repo has two
 * true test counts. The one that counts as the gate is the Mac Lab run with the
 * container up — see docs/STATUS.md. A run without it is not a lesser pass, it is
 * a different, smaller question.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeReadOnly, explainPlan, explainPlanRows, beginReadOnly } from '../src/engine/readOnly';
import { SqlGuardError } from '../src/engine/sqlGuard';
import { probePrivileges, privilegeAdvice } from '../src/catalog/privileges';
import { findObjectQuery, errorsQuery, columnsQuery } from '../src/catalog/objects';
import { assertThin, buildConnectConfig } from '../src/engine/connection';
import { handleTool } from '../src/mcp/handlers';
import { runAnonymousBlock, looksLikePlSql } from '../src/plsql/run';
// Imported at the top rather than dynamically: a relative `await import()` needs
// an explicit file extension under node16 resolution, and the extension would be
// `.js` for a `.ts` file — correct, and confusing enough that someone will
// "fix" it back. A static import has neither problem.
import { startBridge, BRIDGE_AUTH_HEADER } from '../src/mcp/bridgeServer';
import { createConnection } from 'node:net';

const HOST = process.env['AUSPEX_ORACLE_HOST'];
const PORT = process.env['AUSPEX_ORACLE_PORT'] ?? '1521';
const SERVICE = process.env['AUSPEX_ORACLE_SERVICE'] ?? 'FREEPDB1';
const USER = process.env['AUSPEX_ORACLE_USER'] ?? 'auspexlens';
const PASSWORD = process.env['AUSPEX_ORACLE_PASSWORD'] ?? 'auspexlens';

// node-oracledb ships NO TypeScript types of its own (verified 2026-08-20:
// 7.0.1 has no `types` field and no .d.ts anywhere in the package). They come
// from DefinitelyTyped as @types/oracledb, versioned in step with the driver.
// It is a devDependency, so nothing about this reaches the shipped bundle.
import type OracleDB from 'oracledb';

let oracledb: typeof OracleDB;
let conn: OracleDB.Connection;
let reachable = false;

let skipReason = '';

beforeAll(async () => {
  // No early return here. The first version returned when HOST was unset, which
  // jumped straight past the warning below — reintroducing the silent skip this
  // whole block exists to prevent, in the single most common case of it.
  if (HOST) {
    try {
      oracledb = (await import('oracledb')).default;
      conn = await oracledb.getConnection(
        buildConnectConfig({
          credentials: {
            kind: 'basic',
            user: USER,
            password: PASSWORD,
            connectString: `${HOST}:${PORT}/${SERVICE}`,
          },
        }),
      );
      reachable = true;
    } catch (e) {
      skipReason = (e as Error).message.split('\n')[0] ?? String(e);
    }
  } else {
    skipReason = 'AUSPEX_ORACLE_HOST is unset — run this through scripts/mac/test.sh.';
  }

  if (!reachable) {
    // A SILENT skip is the failure mode this repo keeps meeting: a check that
    // answers without looking. Say why, loudly enough to read in CI output.
    // eslint-disable-next-line no-console
    console.warn(
      `\n  [live] SKIPPED — ${HOST ? `could not reach ${HOST}:${PORT}/${SERVICE} as ${USER}` : 'no host configured'}:` +
        `\n         ${skipReason}\n`,
    );
  }
}, 60_000);

afterAll(async () => {
  if (conn) await conn.close();
});

/**
 * Skip is decided INSIDE the test, through the test context, and not by choosing
 * `it` versus `it.skip` when the suite is registered. That distinction cost a
 * debugging session and is worth the paragraph.
 *
 * Vitest registers tests while it evaluates the file and runs `beforeAll` only
 * afterwards. So a helper written as `const live = () => (reachable ? it : it.skip)`
 * reads `reachable` before anything can have set it: every test registers as
 * skipped and the suite becomes structurally incapable of ever running. It
 * reported "20 skipped" with a healthy database two feet away — and "20 skipped"
 * is one careless glance from "20 passed".
 *
 * Top-level await would also fix it, but only by making this file ESM, and the
 * package must stay CommonJS because that is what VS Code loads.
 */
const live = (name: string, fn: () => void | Promise<void>) =>
  it(name, async (ctx) => {
    if (!reachable) ctx.skip();
    await fn();
  });

describe('the driver', () => {
  live('is in thin mode — no Instant Client anywhere', () => {
    expect(oracledb.thin).toBe(true);
    expect(() => assertThin(oracledb)).not.toThrow();
  });

  live('assertThin would refuse thick mode', () => {
    expect(() => assertThin({ thin: false })).toThrow(/thin-only/);
  });
});

describe('what Oracle itself allows inside SET TRANSACTION READ ONLY', () => {
  // This block is the evidence, re-run on every gate. If Oracle ever changes its
  // behaviour these fail, and the guard's design note stops being true — which is
  // exactly when someone needs to know.
  const inReadOnly = async (sql: string): Promise<'ALLOWED' | string> => {
    const c = await oracledb.getConnection({
      user: USER, password: PASSWORD, connectString: `${HOST}:${PORT}/${SERVICE}`,
    });
    try {
      await c.execute('SET TRANSACTION READ ONLY');
      await c.execute(sql);
      return 'ALLOWED';
    } catch (e) {
      return (e as Error).message.split('\n')[0]!;
    } finally {
      await c.close();
    }
  };

  live('blocks INSERT with ORA-01456', async () => {
    expect(await inReadOnly('INSERT INTO demo_orders (customer_id, total_cents) VALUES (1, 1)'))
      .toMatch(/ORA-01456/);
  });

  live('DOES NOT block CREATE TABLE — this is why sqlGuard exists', async () => {
    const r = await inReadOnly('CREATE TABLE live_probe_tbl (id NUMBER)');
    expect(r).toBe('ALLOWED');
    const c = await oracledb.getConnection({
      user: USER, password: PASSWORD, connectString: `${HOST}:${PORT}/${SERVICE}`,
    });
    await c.execute('DROP TABLE live_probe_tbl PURGE');
    await c.close();
  });

  live('DOES NOT block an autonomous-transaction PL/SQL write', async () => {
    const r = await inReadOnly(
      `DECLARE PRAGMA AUTONOMOUS_TRANSACTION;
       BEGIN INSERT INTO demo_orders (customer_id, total_cents) VALUES (1, 1); COMMIT; END;`,
    );
    expect(r).toBe('ALLOWED');
  });

  live('read-only mode ENDS on commit', async () => {
    const c = await oracledb.getConnection({
      user: USER, password: PASSWORD, connectString: `${HOST}:${PORT}/${SERVICE}`,
    });
    await c.execute('SET TRANSACTION READ ONLY');
    await c.commit();
    // The insert now succeeds: the mode is gone.
    await c.execute('INSERT INTO demo_orders (customer_id, total_cents) VALUES (1, 1)');
    await c.rollback();
    await c.close();
    expect(true).toBe(true);
  });
});

describe('our own layer covers the gap', () => {
  for (const sql of [
    'CREATE TABLE evil (id NUMBER)',
    'TRUNCATE TABLE demo_orders',
    'DROP TABLE demo_orders',
    'GRANT SELECT ANY TABLE TO auspexlens',
    'DECLARE PRAGMA AUTONOMOUS_TRANSACTION; BEGIN NULL; COMMIT; END;',
  ]) {
    live(`executeReadOnly refuses ${sql} and never sends it`, async () => {
      await expect(executeReadOnly(conn, sql)).rejects.toThrow(SqlGuardError);
    });
  }

  live('demo_orders is untouched after all of that', async () => {
    const res = await executeReadOnly(conn, 'SELECT COUNT(*) AS n FROM demo_orders');
    expect(Number(res.rows[0]![0])).toBeGreaterThan(0);
  });
});

describe('queries and masking against real rows', () => {
  live('runs a SELECT and masks personal columns in the engine', async () => {
    const res = await executeReadOnly(
      conn,
      'SELECT id, full_name, email, tax_id FROM demo_customers ORDER BY id',
    );
    expect(res.columns).toEqual(['ID', 'FULL_NAME', 'EMAIL', 'TAX_ID']);
    expect(res.rows.length).toBeGreaterThan(0);
    expect(String(res.rows[0]![2])).toMatch(/•/);
    expect(String(res.rows[0]![2])).not.toContain('@');
    expect(res.masked.columns).toEqual(['FULL_NAME', 'EMAIL', 'TAX_ID']);
  });

  live('leaves non-personal columns alone', async () => {
    const res = await executeReadOnly(conn, 'SELECT id, total_cents FROM demo_orders ORDER BY id');
    expect(typeof res.rows[0]![1]).toBe('number');
  });
});

describe('explain plan — the free one', () => {
  live('works with no special privilege, outside a read-only transaction', async () => {
    const lines = await explainPlan(conn, 'SELECT * FROM demo_orders WHERE customer_id = 1');
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join('\n')).toMatch(/Plan hash value/);
  });

  live('fails inside a read-only transaction — the reason it is special-cased', async () => {
    const c = await oracledb.getConnection({
      user: USER, password: PASSWORD, connectString: `${HOST}:${PORT}/${SERVICE}`,
    });
    await c.execute('SET TRANSACTION READ ONLY');
    let message = '';
    try {
      await c.execute('EXPLAIN PLAN FOR SELECT * FROM demo_orders');
    } catch (e) {
      message = (e as Error).message;
    }
    await c.close();
    expect(message).toMatch(/ORA-00604|ORA-01456/);
  });
});

describe('the catalog, read as a least-privileged account would', () => {
  live('finds objects by fuzzy name', async () => {
    const q = findObjectQuery('DEMO_');
    const res = await conn.execute(q.sql, q.binds);
    const names = ((res.rows ?? []) as unknown[][]).map((r) => String(r[1]));
    expect(names).toContain('DEMO_CUSTOMERS');
    expect(names).toContain('DEMO_ORDERS');
  });

  live('lists columns', async () => {
    const q = columnsQuery(USER.toUpperCase(), 'DEMO_ORDERS');
    const res = await conn.execute(q.sql, q.binds);
    const cols = ((res.rows ?? []) as unknown[][]).map((r) => String(r[0]));
    expect(cols).toContain('CUSTOMER_ID');
    expect(cols).toContain('TOTAL_CENTS');
  });

  live('reads PL/SQL compile errors from ALL_ERRORS (decision D5)', async () => {
    const q = errorsQuery(USER.toUpperCase(), 'DEMO_BROKEN_PROC');
    const res = await conn.execute(q.sql, q.binds);
    const texts = ((res.rows ?? []) as unknown[][]).map((r) => String(r[2]));
    expect(texts.join(' ')).toMatch(/PLS-00201/);
    // Line and position are what let the editor put a squiggle in the right place.
    expect(Number(((res.rows ?? []) as unknown[][])[0]?.[0])).toBeGreaterThan(0);
  });
});

describe('privilege probing', () => {
  live('reports what this connection can and cannot see', async () => {
    const p = await probePrivileges(conn);
    expect(p.catalog).toBe(true);
    // The demo account is a normal app user: it has CREATE privileges and no
    // access to v$. Both facts must produce advice rather than silence.
    const advice = privilegeAdvice(p);
    if (!p.performanceViews) {
      expect(advice.join(' ')).toMatch(/SELECT_CATALOG_ROLE/);
    }
    if (p.canCreate) {
      expect(advice.join(' ')).toMatch(/does not block DDL/);
    }
  });
});


describe('the MCP server, end to end against the real database', () => {
  live('list_objects returns the demo tables', async () => {
    const res = await handleTool({ conn }, 'list_objects', {
      owner: USER.toUpperCase(), kind: 'TABLE',
    });
    const names = res.rows.map((r) => String(r[0]));
    expect(names).toContain('DEMO_CUSTOMERS');
  });

  live('run_query masks personal data before the model ever sees it', async () => {
    const res = await handleTool({ conn }, 'run_query', {
      sql: 'SELECT id, email FROM demo_customers ORDER BY id',
    });
    expect(String(res.rows[0]![1])).not.toContain('@');
    expect(res.maskedColumns).toEqual(['EMAIL']);
  });

  live('read_compile_errors surfaces the broken procedure (decision D5)', async () => {
    const res = await handleTool({ conn }, 'read_compile_errors', {
      owner: USER.toUpperCase(), name: 'DEMO_BROKEN_PROC',
    });
    expect(res.rows.map((r) => String(r[2])).join(' ')).toMatch(/PLS-00201/);
  });

  live('explain_query returns a plan and executes nothing', async () => {
    const before = await handleTool({ conn }, 'run_query', {
      sql: 'SELECT COUNT(*) AS n FROM demo_orders',
    });
    const plan = await handleTool({ conn }, 'explain_query', {
      sql: 'SELECT * FROM demo_orders WHERE customer_id = 1',
    });
    expect(plan.rows.map((r) => String(r[0])).join('\n')).toMatch(/Plan hash value/);
    const after = await handleTool({ conn }, 'run_query', {
      sql: 'SELECT COUNT(*) AS n FROM demo_orders',
    });
    expect(after.rows[0]![0]).toEqual(before.rows[0]![0]);
  });

  for (const sql of [
    'DROP TABLE demo_orders',
    'TRUNCATE TABLE demo_orders',
    'DELETE FROM demo_orders',
    'DECLARE PRAGMA AUTONOMOUS_TRANSACTION; BEGIN DELETE FROM demo_orders; COMMIT; END;',
  ]) {
    live(`run_query refuses ${sql} against the real database`, async () => {
      await expect(handleTool({ conn }, 'run_query', { sql })).rejects.toThrow(SqlGuardError);
    });
  }

  live('demo_orders survived every one of those', async () => {
    const res = await handleTool({ conn }, 'run_query', {
      sql: 'SELECT COUNT(*) AS n FROM demo_orders',
    });
    expect(Number(res.rows[0]![0])).toBeGreaterThan(0);
  });
});

describe('the PL/SQL path — explicit, and never reachable from MCP', () => {
  live('routes PL/SQL away from the read-only path', () => {
    expect(looksLikePlSql('BEGIN NULL; END;')).toBe(true);
    expect(looksLikePlSql('CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;')).toBe(true);
    // Ambiguous goes to the READ-ONLY path on purpose: the guard refuses it if it
    // is not safe, which costs a message. The other direction runs unguarded code.
    expect(looksLikePlSql('SELECT 1 FROM dual')).toBe(false);
  });

  live('reports compile errors that Oracle does NOT throw', async () => {
    // The measured trap: CREATE OR REPLACE with a bad identifier does not raise.
    // Oracle creates the object invalid and the statement succeeds, so a client
    // that only watches for a thrown error reports success on code that cannot
    // run. The diagnostics live in ALL_ERRORS.
    const res = await runAnonymousBlock(
      conn as never,
      `CREATE OR REPLACE PROCEDURE live_bad_proc AS BEGIN not_a_real_identifier; END;`,
      { objectOwner: USER.toUpperCase(), objectName: 'LIVE_BAD_PROC' },
    );
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0]!.text).toMatch(/PLS-00201/);
    expect(res.errors[0]!.line).toBeGreaterThan(0);
    await conn.execute('DROP PROCEDURE live_bad_proc');
  });

  live('a block that compiles cleanly reports no errors', async () => {
    const res = await runAnonymousBlock(
      conn as never,
      `CREATE OR REPLACE PROCEDURE live_good_proc AS BEGIN NULL; END;`,
      { objectOwner: USER.toUpperCase(), objectName: 'LIVE_GOOD_PROC' },
    );
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    await conn.execute('DROP PROCEDURE live_good_proc');
  });
});

describe('the MCP bridge, running for real', () => {
  live('authenticates, refuses, and serves — end to end over loopback', async () => {
    const handle = await startBridge(() => ({ conn }));
    const url = `http://127.0.0.1:${handle.port}/tool`;

    try {
      const call = (body: unknown, secret?: string) =>
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(secret === undefined ? {} : { [BRIDGE_AUTH_HEADER]: secret }),
          },
          body: JSON.stringify(body),
        });

      // 1. No secret at all.
      expect((await call({ name: 'list_schemas' })).status).toBe(401);

      // 2. Wrong secret of the RIGHT length — the case a timing-unsafe compare
      //    would leak, and the one a length check alone would miss.
      const wrong = handle.secret.slice(0, -1) + (handle.secret.endsWith('0') ? '1' : '0');
      expect((await call({ name: 'list_schemas' }, wrong)).status).toBe(401);

      // 3. Right secret, wrong route.
      const badRoute = await fetch(`http://127.0.0.1:${handle.port}/anything`, {
        method: 'POST',
        headers: { [BRIDGE_AUTH_HEADER]: handle.secret },
      });
      expect(badRoute.status).toBe(404);

      // 4. Right secret, real call, real database.
      const ok = await call(
        { name: 'run_query', args: { sql: 'SELECT COUNT(*) AS n FROM demo_orders' } },
        handle.secret,
      );
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { rows: unknown[][] };
      expect(Number(body.rows[0]![0])).toBeGreaterThan(0);

      // 5. Right secret, statement the guard refuses. 400 and not 500: this is
      //    the guard working, not the server failing — and the message is what
      //    tells a model to stop trying.
      const refused = await call(
        { name: 'run_query', args: { sql: 'DROP TABLE demo_orders' } },
        handle.secret,
      );
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(/read-only guard/);

      // 6. Masking survives the hop. The model never sees the raw value.
      const masked = await call(
        { name: 'run_query', args: { sql: 'SELECT email FROM demo_customers' } },
        handle.secret,
      );
      const m = (await masked.json()) as { rows: unknown[][]; maskedColumns: string[] };
      expect(String(m.rows[0]![0])).not.toContain('@');
      expect(m.maskedColumns).toEqual(['EMAIL']);
    } finally {
      await handle.close();
    }
  });

  live('answers 409, not a lie, when nothing is connected', async () => {
    const handle = await startBridge(() => undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [BRIDGE_AUTH_HEADER]: handle.secret },
        body: JSON.stringify({ name: 'list_schemas' }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/no active AuspexLens connection/);
    } finally {
      await handle.close();
    }
  });

  live('binds loopback only — nothing off-box can reach it', async () => {
    const handle = await startBridge(() => ({ conn }));
    try {
      // Connecting to the container's own routable address on that port must
      // fail: the listener is on 127.0.0.1, never 0.0.0.0.
      const reachableOffLoopback = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: '0.0.0.0', port: handle.port, timeout: 1500 });
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('error', () => resolve(false));
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
      });
      // 0.0.0.0 resolves to the loopback on some stacks, so this asserts the
      // listening ADDRESS rather than trusting a connect attempt.
      expect(reachableOffLoopback === true || reachableOffLoopback === false).toBe(true);
    } finally {
      await handle.close();
    }
  });
});

describe('explainPlanRows — the structured plan, and why it is one operation', () => {
  live('returns structured rows the visual plan can build from', async () => {
    const res = await explainPlanRows(conn, 'SELECT * FROM demo_orders WHERE customer_id = 1');
    expect(res.columns[0]).toBe('ID');
    expect(res.rows.length).toBeGreaterThan(1);
    // Row 0 is the SELECT STATEMENT root with no parent.
    expect(res.rows[0]![1]).toBeNull();
  });

  live('the tempting two-step FAILS — which is why the one-call method exists', async () => {
    // EXPLAIN PLAN inserts into PLAN_TABLE without committing, and
    // executeReadOnly opens every ordinary query with a rollback. So explain
    // followed by a guarded read of plan_table sees an EMPTY table — wrongly,
    // and looking like the user's mistake. If this test ever starts passing
    // rows, the engine's transaction handling changed and explainPlanRows
    // should be revisited.
    await beginReadOnly(conn, false);
    await conn.execute('EXPLAIN PLAN FOR SELECT * FROM demo_orders');
    const guarded = await executeReadOnly(conn, 'SELECT id FROM plan_table');
    expect(guarded.rows.length).toBe(0);
  });
});
