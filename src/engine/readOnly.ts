/**
 * The only path by which a statement reaches the database.
 *
 * Three layers, in this order, because the measurement on 2026-08-20 showed that
 * no single one of them is enough (docs/RESEARCH.md §17.2):
 *
 *   1. `sqlGuard`               — refuses everything not positively read-only.
 *                                 It owns DDL, GRANT and PL/SQL, because Oracle
 *                                 does not.
 *   2. a fresh read-only transaction PER STATEMENT — rollback, then
 *                                 `SET TRANSACTION READ ONLY`, then the statement.
 *                                 Never once per connection: any commit ends the
 *                                 mode, and every DDL commits implicitly. See
 *                                 `beginReadOnly` for why the rollback is not
 *                                 optional.
 *   3. least privilege          — not enforced here, but detected and reported.
 *                                 It was the only layer that refused every
 *                                 destructive attempt in the measurement.
 *
 * Layer 2 has an exception that had to be discovered rather than guessed:
 * `EXPLAIN PLAN` writes into the global temporary table `PLAN_TABLE$` and so
 * fails with ORA-00604 inside a read-only transaction. Basic explain is a FREE
 * feature, so wrapping everything in read-only would have broken a free feature
 * on day one. The guard marks explain as `needsReadOnlyTransaction: false`, and
 * this executor still ends the previous transaction — which is what actually
 * takes the connection out of read-only.
 */

import { assertReadOnly } from './sqlGuard';
import { maskRows, type MaskPolicy, type MaskReport } from './piiMask';

/** The bits of a node-oracledb connection this module needs. Kept narrow so the
 *  executor is testable without a database and cannot reach for anything else. */
export interface ReadOnlyCapableConnection {
  execute(
    sql: string,
    binds?: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ rows?: unknown[][]; metaData?: { name: string }[] }>;
  /** Needed to end the open transaction before starting a read-only one. See
   *  `beginReadOnly` — this is not optional plumbing. */
  rollback(): Promise<void>;
}

export interface ExecuteOptions {
  /** Row cap. A grid that tries to render an unbounded result is a hung window. */
  maxRows?: number;
  /** PII masking policy. Applied HERE, in the engine, before anything sees the rows. */
  mask?: MaskPolicy;
  /**
   * Bind values.
   *
   * Not optional plumbing: every catalog query is parameterised precisely so an
   * object name — which comes from the database and is therefore hostile input —
   * never reaches SQL by concatenation. The first version of this function
   * hardcoded an empty binds array, so the queries carried placeholders and the
   * executor carried no values, and every parameterised call failed with NJS-098.
   * The parameterisation was real and the path to it was not.
   */
  binds?: Record<string, string | number> | unknown[];
}

export interface ResultSet {
  columns: string[];
  rows: unknown[][];
  /** What the guard decided, carried through so callers can show it. */
  kind: 'query' | 'explain' | 'describe';
  masked: MaskReport;
}

export const DEFAULT_MAX_ROWS = 5_000;

/**
 * Put the connection into a fresh read-only transaction — or, for `EXPLAIN PLAN`,
 * deliberately out of one.
 *
 * **The rollback is load-bearing and was discovered the hard way.** Oracle
 * requires `SET TRANSACTION` to be the FIRST statement of a transaction
 * (ORA-01453), and a plain `SELECT` opens a transaction and leaves it open. So
 * the obvious design — "re-issue SET TRANSACTION READ ONLY before every
 * statement" — works for exactly one statement and then fails on every one after
 * it. The unit tests, which talk to a fake connection, passed the whole time; the
 * live suite against a real database is what found it.
 *
 * The same open transaction is why `EXPLAIN PLAN` needs the rollback too. It is
 * marked as not needing read-only precisely because it writes to PLAN_TABLE$ —
 * but if the connection is still inside the PREVIOUS statement's read-only
 * transaction, it fails with ORA-00604/ORA-01456 anyway. Ending the transaction
 * is what actually takes it out of read-only.
 *
 * Rolling back is safe here in a way it would not be in a read-write tool:
 * nothing this engine sends can have written anything, so there is never work to
 * lose. Each statement therefore gets its own transaction, which is also the
 * cleanest possible answer to "did the mode survive?" — it does not have to.
 */
export async function beginReadOnly(
  conn: ReadOnlyCapableConnection,
  wanted: boolean,
): Promise<void> {
  await conn.rollback();
  if (wanted) {
    await conn.execute('SET TRANSACTION READ ONLY');
  }
}

/**
 * Run one read-only statement.
 *
 * Throws `SqlGuardError` before touching the connection if the statement is not
 * read-only — the database is never asked a question the guard has already
 * answered.
 */
export async function executeReadOnly(
  conn: ReadOnlyCapableConnection,
  sql: string,
  options: ExecuteOptions = {},
): Promise<ResultSet> {
  const verdict = assertReadOnly(sql);

  await beginReadOnly(conn, verdict.needsReadOnlyTransaction);

  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const result = await conn.execute(sql, options.binds ?? [], { maxRows });

  const columns = (result.metaData ?? []).map((c) => c.name);
  const rawRows = result.rows ?? [];

  // Masking happens here and nowhere else. Every consumer — the grid, the CSV
  // export, the MCP server — receives rows that have already been through it.
  // Moving this check outward is how one consumer ends up with the raw values.
  const { rows, report } = maskRows(columns, rawRows, options.mask);

  return { columns, rows, kind: verdict.kind, masked: report };
}

/**
 * `EXPLAIN PLAN` plus the read-back, as one operation.
 *
 * Two statements, deliberately not one: `EXPLAIN PLAN FOR ...` populates
 * PLAN_TABLE$ and returns nothing, and `DBMS_XPLAN.DISPLAY()` is what renders it.
 * Neither runs inside a read-only transaction — see the note at the top.
 *
 * `DBMS_XPLAN.DISPLAY_CURSOR` is deliberately NOT used here: it needs privileges
 * on the `v$` views, which a least-privilege connection does not have. Basic
 * explain must work for the free tier with `CREATE SESSION` + `SELECT` and
 * nothing else. The cursor-level plan is a Pro feature for exactly that reason.
 */
/**
 * `EXPLAIN PLAN` plus the STRUCTURED read-back — the rows Pro's visual plan and
 * advisors consume.
 *
 * One operation on purpose, and the transaction is the reason. `EXPLAIN PLAN`
 * inserts its rows into the PLAN_TABLE global temporary WITHOUT committing, and
 * `beginReadOnly` opens every ordinary query with a ROLLBACK — which would
 * erase exactly those uncommitted rows. So "explain, then read plan_table
 * through executeReadOnly" returns an empty plan every time, wrongly, and the
 * emptiness looks like the user's mistake. The read here stays inside the same
 * transaction as the insert, which is the only ordering that works. There is a
 * live test that pins BOTH halves: this succeeds, and the tempting two-step
 * fails.
 */
export async function explainPlanRows(
  conn: ReadOnlyCapableConnection,
  sql: string,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const verdict = assertReadOnly(sql);
  if (verdict.kind !== 'query') {
    throw new Error('only a query can be explained.');
  }
  await beginReadOnly(conn, false);
  await conn.execute(`EXPLAIN PLAN FOR ${sql.replace(/;\s*$/, '')}`);
  const out = await conn.execute(
    `SELECT id, parent_id, operation, options, object_owner, object_name,
            cardinality, bytes, cost, access_predicates, filter_predicates
       FROM plan_table
      ORDER BY id`,
  );
  return {
    columns: (out.metaData ?? []).map((c) => c.name),
    rows: out.rows ?? [],
  };
}

export async function explainPlan(
  conn: ReadOnlyCapableConnection,
  sql: string,
): Promise<string[]> {
  const verdict = assertReadOnly(sql);
  if (verdict.kind !== 'query') {
    throw new Error('only a query can be explained.');
  }
  // Out of any read-only transaction first — see beginReadOnly.
  await beginReadOnly(conn, false);
  await conn.execute(`EXPLAIN PLAN FOR ${sql.replace(/;\s*$/, '')}`);
  const out = await conn.execute(
    'SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY())',
  );
  return (out.rows ?? []).map((r) => String(r[0] ?? ''));
}
