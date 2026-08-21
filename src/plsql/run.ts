/**
 * Running PL/SQL — the one path that is deliberately NOT read-only.
 *
 * There is a real tension here and it is worth stating plainly rather than
 * resolving quietly. Decision D5 puts "run PL/SQL blocks" in the FREE tier. The
 * read-only guard refuses every PL/SQL block, and correctly: a block can write,
 * and with `PRAGMA AUTONOMOUS_TRANSACTION` it writes even inside Oracle's own
 * read-only transaction (measured — docs/RESEARCH.md §17.2).
 *
 * The resolution is **two paths and one floor**:
 *
 *   executeReadOnly        the guarded path. Everything reaches the database
 *                          through it: the editor's queries, the results grid,
 *                          the exports, and — crucially — the MCP server.
 *   runAnonymousBlock      this path. Explicit, initiated by a human in an
 *                          editor, never reachable from the MCP server and never
 *                          from anything a language model can influence.
 *
 * The distinction that makes this safe is not "who calls it" as a convention. It
 * is that the MCP server imports the read-only engine and does not import this
 * module at all, and a test asserts exactly that. A boundary maintained by
 * discipline is a boundary; a boundary maintained by a test is a control.
 */

import type { ReadOnlyCapableConnection } from '../engine/readOnly';
import { errorsQuery } from '../catalog/objects';

/** A PL/SQL compile diagnostic, shaped for an editor squiggle. */
export interface CompileError {
  line: number;
  position: number;
  text: string;
  /** `ERROR` or `WARNING`, straight from ALL_ERRORS. */
  type: string;
}

export interface BlockConnection extends ReadOnlyCapableConnection {
  commit(): Promise<void>;
}

export interface RunBlockResult {
  /** Whether Oracle accepted the block. A block that compiles with errors still
   *  "succeeds" at the statement level — see below. */
  ok: boolean;
  /** Compile diagnostics, when the block created or replaced a stored object. */
  errors: CompileError[];
  /** The error Oracle raised, if the statement itself failed. */
  message?: string;
}

/**
 * Remove only the SQL*Plus block terminator, never the block's own semicolons.
 *
 * A `/` alone on the final line is how SQL*Plus is told to submit a block. The
 * driver takes the block directly and chokes on it. The semicolon after `END`
 * belongs to the PL/SQL and must survive.
 */
export function stripSqlPlusTerminator(sql: string): string {
  return sql.replace(/\n\s*\/\s*$/, '');
}

/**
 * Whether the text looks like PL/SQL rather than SQL.
 *
 * Used to route to this path instead of the read-only one, and deliberately
 * conservative: something ambiguous goes to the READ-ONLY path, where the guard
 * will refuse it if it is not safe. Getting this wrong in that direction costs a
 * user an error message. Getting it wrong the other way runs unguarded code.
 */
export function looksLikePlSql(sql: string): boolean {
  return /^\s*(declare|begin|create\s+(or\s+replace\s+)?(package|procedure|function|trigger|type)\b)/i
    .test(sql);
}

/**
 * Run an anonymous block or a CREATE … PL/SQL statement.
 *
 * Never called with input a language model produced. See the module note.
 */
export async function runAnonymousBlock(
  conn: BlockConnection,
  sql: string,
  options: { objectOwner?: string; objectName?: string } = {},
): Promise<RunBlockResult> {
  // Out of any read-only transaction the previous statement left behind, or this
  // fails with ORA-01456 for reasons that have nothing to do with the block.
  await conn.rollback();

  try {
    // The trailing semicolon is NOT stripped here, and that is the difference
    // between this path and the SQL one. `END;` needs its semicolon: removing it
    // turns a valid block into PLS-00103 ("Encountered the symbol ..."), which
    // reads like the user's code is wrong when it was ours.
    await conn.execute(stripSqlPlusTerminator(sql));
  } catch (e) {
    return { ok: false, errors: [], message: (e as Error).message.split('\n')[0] };
  }

  // A `CREATE OR REPLACE PROCEDURE` with a bad identifier does NOT throw: Oracle
  // creates the object in an invalid state and the statement succeeds. Measured
  // 2026-08-20 — the diagnostics are in ALL_ERRORS, not in the exception, and a
  // client that only watches for a thrown error reports success on code that
  // cannot run. That is the whole reason this function reads the view.
  if (options.objectOwner && options.objectName) {
    const q = errorsQuery(options.objectOwner, options.objectName.toUpperCase());
    const res = await conn.execute(q.sql, q.binds);
    const errors: CompileError[] = ((res.rows ?? []) as unknown[][]).map((r) => ({
      line: Number(r[0] ?? 0),
      position: Number(r[1] ?? 0),
      text: String(r[2] ?? ''),
      type: String(r[4] ?? 'ERROR'),
    }));
    return { ok: errors.length === 0, errors };
  }

  return { ok: true, errors: [] };
}
