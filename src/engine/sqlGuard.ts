/**
 * What may be sent to the database in read-only mode, and what may not.
 *
 * This file carries more weight on Oracle than the equivalent does on other
 * engines, and the reason is measured rather than assumed. On 2026-08-20, against
 * a real Oracle database (docs/RESEARCH.md §17.2), `SET TRANSACTION READ ONLY`
 * was found to stop DML and `SELECT ... FOR UPDATE` — and nothing else that
 * matters:
 *
 *   CREATE TABLE   ALLOWED        PL/SQL with PRAGMA AUTONOMOUS_TRANSACTION  ALLOWED
 *   TRUNCATE       ALLOWED        GRANT                                      ALLOWED
 *   DROP           ALLOWED
 *
 * Worse, every DDL performs an implicit commit, and the read-only transaction
 * ENDS on any commit. So a `CREATE TABLE` does not merely execute: it switches
 * the mode off for everything that follows on that connection.
 *
 * Oracle's native mechanism is anti-DML, not anti-destruction. A `TRUNCATE TABLE`
 * arriving from a language model through the MCP server is not stopped by the
 * database. It is stopped here, and by connecting with a least-privilege user
 * (the only layer that refused every destructive attempt in the measurement).
 *
 * Design rules this file follows:
 *
 *  - **Allowlist, never denylist.** Anything not positively recognised as a
 *    read-only statement is refused. A denylist is a promise to have thought of
 *    every verb Oracle has, including the ones added in the next release.
 *  - **No `catch {}` anywhere.** A classifier that fails open is worse than none.
 *  - **One statement per call.** Multiple statements are refused rather than
 *    split, because splitting SQL correctly requires a parser and getting it
 *    subtly wrong is how a second, hostile statement rides along.
 */

export type Verdict =
  | { allowed: true; kind: AllowedKind; needsReadOnlyTransaction: boolean }
  | { allowed: false; reason: string; offendingKeyword?: string };

/** The only shapes that reach the database. */
export type AllowedKind = 'query' | 'explain' | 'describe';

/**
 * Statement leaders that are unambiguously destructive or state-changing.
 * Only used to produce a *better message* than "not recognised" — never as the
 * decision itself. The decision is the allowlist below.
 */
const NAMED_DANGERS = new Map<string, string>([
  ['insert', 'writes rows'],
  ['update', 'writes rows'],
  ['delete', 'deletes rows'],
  ['merge', 'writes rows'],
  ['create', 'is DDL, which Oracle allows inside a read-only transaction'],
  ['alter', 'is DDL, which Oracle allows inside a read-only transaction'],
  ['drop', 'is DDL, which Oracle allows inside a read-only transaction'],
  ['truncate', 'is DDL, which Oracle allows inside a read-only transaction'],
  ['rename', 'is DDL, which Oracle allows inside a read-only transaction'],
  ['comment', 'is DDL, which Oracle allows inside a read-only transaction'],
  ['grant', 'changes privileges, which Oracle allows inside a read-only transaction'],
  ['revoke', 'changes privileges, which Oracle allows inside a read-only transaction'],
  ['flashback', 'rewrites table state'],
  ['purge', 'destroys recycle-bin objects'],
  ['commit', 'ends the read-only transaction'],
  ['rollback', 'ends the read-only transaction'],
  ['savepoint', 'is transaction control'],
  ['set', 'is transaction control; this engine issues its own SET TRANSACTION'],
  ['lock', 'takes locks'],
  ['call', 'executes procedural code that may write'],
  ['execute', 'executes procedural code that may write'],
  ['exec', 'executes procedural code that may write'],
  ['begin', 'opens a PL/SQL block, which can write via an autonomous transaction'],
  ['declare', 'opens a PL/SQL block, which can write via an autonomous transaction'],
]);

/**
 * Strip comments and string literals before looking at the text.
 *
 * Both matter. A semicolon hidden inside a block comment, and a semicolon inside
 * a string literal such as `SELECT ';' FROM dual`, are both characters that would
 * otherwise be read as structure. Removing comments and literals first means the
 * statement-splitting and keyword checks below look only at SQL.
 */
/**
 * Remove comments only, leaving string literals and quoted identifiers intact.
 *
 * `stripNoise` removes both, and for the GUARD that is right: neither a literal
 * nor a quoted identifier can change which verb leads the statement, and treating
 * them alike is the simplest thing that cannot be fooled.
 *
 * For anything that needs to READ a name out of the statement it is wrong, and
 * quietly so. In Oracle `'x'` is a string literal but `"x"` is an *identifier* —
 * `DROP TABLE "Quoted"` names a real table. `stripNoise` erases it, so a caller
 * looking for the object name finds nothing and silently falls back to "no
 * confirmation needed" on a DROP. That is the wrong direction to fail in, which
 * is why this second function exists rather than a flag on the first.
 */
export function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && sql.slice(i, i + 2) !== '*/') i++;
      i += 2;
      out += ' ';
      continue;
    }
    // Step over a literal or a quoted identifier WITHOUT removing it, so that a
    // comment marker inside one cannot start a fake comment.
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { out += sql[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function stripNoise(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && sql.slice(i, i + 2) !== '*/') i++;
      i += 2;
      continue;
    }
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          // Doubled quote is an escaped quote, not the end of the literal.
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      // A literal becomes a space so `a'x'b` cannot fuse into one word.
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Whether a leading keyword can possibly begin a read-only statement.
 *
 * This is the allowlist itself, factored out so the decision happens once and
 * early — see the ordering note in `inspect`.
 */
function isAllowlistedLeader(head: string): boolean {
  return head === 'select' || head === 'with' || head === 'explain'
    || head === 'describe' || head === 'desc';
}

/** The leading keyword, lowercased, of a statement with noise already stripped. */
function leadingKeyword(stripped: string): string {
  const m = /^[\s(]*([a-zA-Z_]+)/.exec(stripped);
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * True when the text contains more than one statement.
 *
 * A trailing semicolon is normal and ignored; anything after it is not. This is
 * deliberately strict: the alternative is splitting the text and judging each
 * part, and a splitter that is subtly wrong is exactly how a second statement
 * gets executed unexamined.
 */
function hasTrailingStatement(stripped: string): boolean {
  const trimmed = stripped.trim();
  const idx = trimmed.indexOf(';');
  if (idx === -1) return false;
  return trimmed.slice(idx + 1).trim().length > 0;
}

export function inspect(sql: string): Verdict {
  if (typeof sql !== 'string' || sql.trim() === '') {
    return { allowed: false, reason: 'the statement is empty.' };
  }

  const stripped = stripNoise(sql);

  const head = leadingKeyword(stripped);
  if (head === '') {
    return { allowed: false, reason: 'no SQL statement was found.' };
  }

  // The verb is judged BEFORE the one-statement rule, and the order is the whole
  // point. A PL/SQL block contains semicolons of its own — `BEGIN NULL; END;` is
  // ONE statement with two of them — so asking "is there more than one statement"
  // first refuses it as multi-statement. Safe, but for the wrong reason, and the
  // user is told something untrue about their code. Refusing it as PL/SQL, which
  // is why it is actually unsafe, is both accurate and actionable.
  //
  // Nothing is weakened by the reorder: the one-statement rule still runs for
  // every verb that survives the allowlist, which is the only place a second
  // statement could ride along.
  if (!isAllowlistedLeader(head)) {
    const why = NAMED_DANGERS.get(head);
    return {
      allowed: false,
      reason: why
        ? `${head.toUpperCase()} ${why}. Oracle would not stop it: SET TRANSACTION ` +
          `READ ONLY blocks DML but allows DDL, GRANT and autonomous-transaction ` +
          `PL/SQL, and ends on the implicit commit DDL performs.`
        : `'${head.toUpperCase()}' is not a recognised read-only statement. This is ` +
          `an allowlist: anything not positively recognised is refused.`,
      offendingKeyword: head,
    };
  }

  // Same reason as above, one level down: `WITH FUNCTION f ... IS BEGIN ... END;
  // SELECT f FROM dual` is a single statement whose declared body carries
  // semicolons. `with` is allowlisted, so without this it would reach the
  // one-statement rule and be refused as "more than one statement" — true-ish,
  // safe, and not what is actually wrong with it.
  if (head === 'with' && /\bwith\s+(function|procedure)\b/i.test(stripped)) {
    return {
      allowed: false,
      reason:
        'a WITH clause that declares a FUNCTION or PROCEDURE compiles PL/SQL, ' +
        'which can write through an autonomous transaction.',
      offendingKeyword: 'with function',
    };
  }

  if (hasTrailingStatement(stripped)) {
    return {
      allowed: false,
      reason:
        'more than one statement was submitted. Send one at a time — splitting ' +
        'SQL correctly needs a parser, and a splitter that is subtly wrong is how ' +
        'a second statement rides along unexamined.',
    };
  }

  // --- the allowlist. Everything else is refused. ---------------------------
  if (head === 'select') {
    return forUpdateCheck(stripped) ?? { allowed: true, kind: 'query', needsReadOnlyTransaction: true };
  }

  if (head === 'with') {
    // A WITH clause may lead to SELECT (fine) or to INSERT/UPDATE/DELETE (not).
    // `WITH FUNCTION` is already refused above, before the one-statement rule —
    // one check, one place.
    if (!/\bselect\b/i.test(stripped)) {
      return { allowed: false, reason: 'a WITH clause that does not lead to SELECT is not read-only.' };
    }
    // The body after the last closing paren decides. Cheap and conservative: if
    // any DML verb appears at statement level, refuse.
    const dml = /\b(insert|update|delete|merge)\s+(into|from|\w)/i.exec(stripped);
    if (dml) {
      return {
        allowed: false,
        reason: 'a WITH clause feeding a write statement is not read-only.',
        offendingKeyword: dml[1]!.toLowerCase(),
      };
    }
    return forUpdateCheck(stripped) ?? { allowed: true, kind: 'query', needsReadOnlyTransaction: true };
  }

  if (head === 'explain') {
    if (!/^\s*explain\s+plan\b/i.test(stripped)) {
      return { allowed: false, reason: 'only EXPLAIN PLAN is recognised.' };
    }
    // The measured trap: EXPLAIN PLAN writes into the global temporary table
    // PLAN_TABLE$, so it fails with ORA-00604 inside a read-only transaction.
    // Basic explain is a FREE feature, so wrapping everything in read-only would
    // have broken a free feature. It runs outside the transaction instead — safe
    // because the only thing it writes is the caller's own plan rows in a GTT.
    return { allowed: true, kind: 'explain', needsReadOnlyTransaction: false };
  }

  if (head === 'describe' || head === 'desc') {
    return { allowed: true, kind: 'describe', needsReadOnlyTransaction: true };
  }

  // Unreachable: isAllowlistedLeader has already refused everything else. Kept
  // as a hard stop rather than a cast, so that adding a leader to the allowlist
  // without handling it here fails closed instead of falling through to `allowed`.
  return {
    allowed: false,
    reason: `'${head.toUpperCase()}' passed the allowlist but has no handler. ` +
      `Refusing, because failing closed is the only safe direction here.`,
    offendingKeyword: head,
  };
}

/** `SELECT ... FOR UPDATE` takes row locks and is refused. */
function forUpdateCheck(stripped: string): Verdict | null {
  if (/\bfor\s+update\b/i.test(stripped)) {
    return {
      allowed: false,
      reason: 'SELECT ... FOR UPDATE takes row locks and is not read-only.',
      offendingKeyword: 'for update',
    };
  }
  return null;
}

/** Throwing wrapper, for call sites where a refusal is an error rather than data. */
export function assertReadOnly(sql: string): Extract<Verdict, { allowed: true }> {
  const verdict = inspect(sql);
  if (!verdict.allowed) {
    throw new SqlGuardError(verdict.reason, verdict.offendingKeyword);
  }
  return verdict;
}

export class SqlGuardError extends Error {
  readonly offendingKeyword: string | undefined;
  constructor(reason: string, offendingKeyword?: string) {
    super(`refused by the read-only guard: ${reason}`);
    this.name = 'SqlGuardError';
    this.offendingKeyword = offendingKeyword;
  }
}
