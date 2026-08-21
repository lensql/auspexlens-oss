import { describe, it, expect } from 'vitest';
import { executeReadOnly, explainPlan, DEFAULT_MAX_ROWS } from '../src/engine/readOnly';
import { SqlGuardError } from '../src/engine/sqlGuard';

/** Records what was actually sent, which is the only thing worth asserting here. */
function fakeConnection(result: { rows?: unknown[][]; metaData?: { name: string }[] } = {}) {
  const sent: string[] = [];
  return {
    sent,
    conn: {
      async execute(sql: string) {
        sent.push(sql);
        if (sql.startsWith('SET TRANSACTION')) return {};
        return result;
      },
      async rollback() {
        sent.push('ROLLBACK');
      },
    },
  };
}

describe('the read-only transaction is re-issued per statement', () => {
  it('sends SET TRANSACTION READ ONLY before a query', async () => {
    const { conn, sent } = fakeConnection({ rows: [[1]], metaData: [{ name: 'N' }] });
    await executeReadOnly(conn, 'SELECT 1 AS n FROM dual');
    // The rollback comes first and is not decoration: SET TRANSACTION must be
    // the first statement of a transaction (ORA-01453), and the previous
    // statement left one open.
    expect(sent[0]).toBe('ROLLBACK');
    expect(sent[1]).toBe('SET TRANSACTION READ ONLY');
    expect(sent[2]).toBe('SELECT 1 AS n FROM dual');
  });

  it('sends it again on the NEXT statement, never assuming the mode survived', async () => {
    // Any commit ends read-only mode, and every DDL commits implicitly. A
    // connection put into read-only once may silently not be any more.
    const { conn, sent } = fakeConnection({ rows: [], metaData: [] });
    await executeReadOnly(conn, 'SELECT 1 FROM dual');
    await executeReadOnly(conn, 'SELECT 2 FROM dual');
    expect(sent.filter((s) => s === 'SET TRANSACTION READ ONLY')).toHaveLength(2);
  });

  it('does NOT wrap EXPLAIN PLAN — it fails with ORA-00604 inside read-only', async () => {
    const { conn, sent } = fakeConnection({ rows: [], metaData: [] });
    await executeReadOnly(conn, 'EXPLAIN PLAN FOR SELECT 1 FROM dual');
    expect(sent).not.toContain('SET TRANSACTION READ ONLY');
    // …but it IS taken out of the previous statement's transaction, which is the
    // only thing that actually leaves read-only mode.
    expect(sent).toContain('ROLLBACK');
  });
});

describe('the guard runs before the connection is touched', () => {
  it.each([
    'DROP TABLE ventas',
    'TRUNCATE TABLE ventas',
    'GRANT SELECT ANY TABLE TO x',
    'DECLARE PRAGMA AUTONOMOUS_TRANSACTION; BEGIN NULL; END;',
  ])('refuses %s without sending anything', async (sql) => {
    const { conn, sent } = fakeConnection();
    await expect(executeReadOnly(conn, sql)).rejects.toThrow(SqlGuardError);
    expect(sent).toEqual([]);
  });
});

describe('results', () => {
  it('caps rows by default', async () => {
    let opts: Record<string, unknown> | undefined;
    const conn = {
      async execute(sql: string, _b?: unknown, o?: Record<string, unknown>) {
        if (!sql.startsWith('SET')) opts = o;
        return { rows: [], metaData: [] };
      },
      async rollback() {},
    };
    await executeReadOnly(conn, 'SELECT 1 FROM dual');
    expect(opts?.['maxRows']).toBe(DEFAULT_MAX_ROWS);
  });

  it('masks in the engine, so no caller can receive raw personal data', async () => {
    const { conn } = fakeConnection({
      rows: [[1, 'ada@example.invalid']],
      metaData: [{ name: 'ID' }, { name: 'EMAIL' }],
    });
    const res = await executeReadOnly(conn, 'SELECT id, email FROM demo_customers');
    expect(String(res.rows[0]![1])).toMatch(/•/);
    expect(res.masked.columns).toEqual(['EMAIL']);
  });
});

describe('explainPlan', () => {
  it('runs EXPLAIN PLAN then reads it back, with no read-only transaction', async () => {
    const { conn, sent } = fakeConnection({ rows: [['Plan hash value: 1']], metaData: [] });
    const lines = await explainPlan(conn, 'SELECT * FROM demo_orders');
    expect(sent[0]).toBe('ROLLBACK');
    expect(sent[1]).toBe('EXPLAIN PLAN FOR SELECT * FROM demo_orders');
    expect(sent[2]).toMatch(/DBMS_XPLAN\.DISPLAY\(\)/);
    expect(sent).not.toContain('SET TRANSACTION READ ONLY');
    expect(lines[0]).toBe('Plan hash value: 1');
  });

  it('will not explain a statement the guard refuses', async () => {
    const { conn } = fakeConnection();
    await expect(explainPlan(conn, 'DROP TABLE ventas')).rejects.toThrow(SqlGuardError);
  });
});

describe('binds reach the database', () => {
  it('passes bind values through, rather than an empty array', async () => {
    // The parameterisation of every catalog query is worth nothing if the
    // executor drops the values: the statement then carries placeholders and no
    // values, and Oracle answers NJS-098. Found by the live suite, because a
    // fake connection happily ignores whatever it is handed.
    let seen: unknown;
    const conn = {
      async execute(sql: string, binds?: unknown) {
        if (!sql.startsWith('SET')) seen = binds;
        return { rows: [], metaData: [] };
      },
      async rollback() {},
    };
    await executeReadOnly(conn, 'SELECT * FROM t WHERE owner = :owner', {
      binds: { owner: 'HR' },
    });
    expect(seen).toEqual({ owner: 'HR' });
  });
});
