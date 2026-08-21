/**
 * What a statement will actually do to your session, said before you run it.
 *
 * The read-only guard (`sqlGuard`) answers one question: may this be sent at all?
 * This file answers a different one, for the path where the user has deliberately
 * left read-only mode: **what is about to happen that you might not expect?**
 *
 * The distinction matters because the surprises here are not exotic. They are
 * documented Oracle behaviour that experienced people still get caught by, and
 * every one of them was reproduced against a real database on 2026-08-20 and then
 * confirmed against Oracle's own documentation. Each warning below cites the
 * paragraph that makes it true, so nobody has to take our word for it — and so a
 * future reader can check whether it is still true.
 *
 * The rule this file follows: **never surprise, never nag.** A warning that fires
 * on a plain SELECT is a warning that gets clicked through, and then the one that
 * mattered gets clicked through too.
 */

import { stripNoise, stripComments } from './sqlGuard';

export type RiskLevel =
  /** Nothing worth interrupting for. */
  | 'none'
  /** Worth showing inline; does not block. */
  | 'notice'
  /** Worth a confirmation dialog. */
  | 'warning'
  /** Worth a confirmation the user has to type. */
  | 'destructive';

export interface StatementRisk {
  level: RiskLevel;
  /** Stable identifier, so the UI can let a user silence one kind and not all. */
  id: RiskId;
  /** One line, for a dialog title. */
  title: string;
  /** What will actually happen. Concrete, no hedging. */
  detail: string;
  /** The Oracle documentation that says so. */
  reference: string;
}

export type RiskId =
  | 'none'
  | 'implicit-commit'
  | 'irreversible-ddl'
  | 'privilege-change'
  | 'autonomous-transaction'
  | 'ends-transaction'
  | 'takes-locks'
  | 'writes-rows';

const REF_COMMIT =
  'Oracle Database SQL Language Reference 26 — COMMIT: “Oracle Database ' +
  'automatically issues an implicit COMMIT before any syntactically valid DDL ' +
  'statement, and after any DDL statement that completes without error.”';

const REF_SET_TRANSACTION =
  'Oracle Database SQL Language Reference 26 — SET TRANSACTION: it “must be the ' +
  'first statement in a transaction”, and only subqueries without FOR UPDATE, ' +
  'LOCK TABLE, SET ROLE, ALTER SESSION and ALTER SYSTEM are permitted inside a ' +
  'read-only transaction.';

const REF_AUTONOMOUS =
  'Oracle Database Concepts — Autonomous Transactions: the pragma “instructs the ' +
  'database to execute the procedure as a new autonomous transaction, independent ' +
  'of its parent transaction”; the calling routine suspends and resumes afterwards.';

/**
 * `ALTER SESSION` and `ALTER SYSTEM` lead with `alter` and are NOT object DDL.
 *
 * Oracle's own SET TRANSACTION documentation lists both among the statements
 * *permitted* inside a read-only transaction, alongside subqueries, LOCK TABLE
 * and SET ROLE — so warning that they will commit your pending work would be
 * both wrong and exactly the kind of false alarm that teaches people to click
 * through the real ones.
 */
const NOT_OBJECT_DDL = /^\s*alter\s+(session|system)\b/i;

/** Statement leaders that are DDL, and therefore commit implicitly. */
const DDL_LEADERS = new Set([
  'create', 'alter', 'drop', 'truncate', 'rename', 'comment',
  'grant', 'revoke', 'analyze', 'audit', 'noaudit', 'associate', 'disassociate',
  'flashback', 'purge',
]);

/** The subset of DDL whose effect cannot be undone afterwards. */
const IRREVERSIBLE_LEADERS = new Set(['truncate', 'drop', 'purge']);

const PRIVILEGE_LEADERS = new Set(['grant', 'revoke']);

const DML_LEADERS = new Set(['insert', 'update', 'delete', 'merge']);

function leader(stripped: string): string {
  const m = /^[\s(]*([a-zA-Z_]+)/.exec(stripped);
  return m ? m[1]!.toLowerCase() : '';
}

const NONE: StatementRisk = {
  level: 'none',
  id: 'none',
  title: '',
  detail: '',
  reference: '',
};

/**
 * Assess one statement.
 *
 * Ordered most-alarming-first so a `DROP` is described as irreversible rather
 * than as "this commits your pending work", which is true and beside the point.
 * When two warnings could fire, the specific one goes first or it never speaks.
 */
export function assessRisk(sql: string): StatementRisk {
  if (typeof sql !== 'string' || sql.trim() === '') return NONE;

  const stripped = stripNoise(sql);
  const head = leader(stripped);

  // --- PL/SQL that opens its own transaction ------------------------------
  //
  // First, because it is the one that catches people who believe the session's
  // read-only setting protects them. It does not: the pragma starts a NEW
  // transaction, and the read-only property belongs to the parent, which is
  // suspended while the autonomous one runs.
  if (/\bpragma\s+autonomous_transaction\b/i.test(stripped)) {
    return {
      level: 'warning',
      id: 'autonomous-transaction',
      title: 'This block runs in its own transaction and can commit on its own',
      detail:
        'It declares PRAGMA AUTONOMOUS_TRANSACTION. Oracle suspends the current ' +
        'transaction and runs the block as an independent one, so anything it ' +
        'writes and commits is permanent even if the surrounding transaction is ' +
        'read-only or is later rolled back. Read-only mode does not reach inside it.',
      reference: REF_AUTONOMOUS,
    };
  }

  // --- destructive DDL -----------------------------------------------------
  if (IRREVERSIBLE_LEADERS.has(head)) {
    const verb = head.toUpperCase();
    return {
      level: 'destructive',
      id: 'irreversible-ddl',
      title: `${verb} cannot be undone`,
      detail:
        `${verb} is DDL, so Oracle commits before it runs and again after it ` +
        'succeeds. There is no transaction left to roll back: once it completes, ' +
        'the data or the object is gone. Any other uncommitted work in this ' +
        'session is committed too, as a side effect.',
      reference: REF_COMMIT,
    };
  }

  // --- privilege changes ---------------------------------------------------
  if (PRIVILEGE_LEADERS.has(head)) {
    return {
      level: 'warning',
      id: 'privilege-change',
      title: `${head.toUpperCase()} changes who can do what, and commits immediately`,
      detail:
        'Privilege statements are DDL. Oracle commits before and after, so the ' +
        'change takes effect at once, cannot be rolled back, and commits any other ' +
        'uncommitted work in this session along with it.',
      reference: REF_COMMIT,
    };
  }

  // --- any other DDL -------------------------------------------------------
  if (DDL_LEADERS.has(head) && !NOT_OBJECT_DDL.test(stripped)) {
    return {
      level: 'warning',
      id: 'implicit-commit',
      title: 'This commits everything pending in your session',
      detail:
        `${head.toUpperCase()} is DDL. Oracle issues an implicit COMMIT before it ` +
        'and another after it, which makes any uncommitted work in this session ' +
        'permanent — and silently ends a read-only transaction, before the ' +
        'statement runs rather than after.',
      reference: REF_COMMIT,
    };
  }

  // --- plain DML -----------------------------------------------------------
  if (DML_LEADERS.has(head)) {
    return {
      level: 'warning',
      id: 'writes-rows',
      title: `${head.toUpperCase()} modifies data`,
      detail:
        'The change is part of the current transaction and is not permanent until ' +
        'you commit — but note that any DDL you run afterwards will commit it for ' +
        'you, whether or not you meant to.',
      reference: REF_COMMIT,
    };
  }

  // --- transaction control -------------------------------------------------
  if (head === 'commit' || head === 'rollback') {
    return {
      level: 'notice',
      id: 'ends-transaction',
      title: `${head.toUpperCase()} ends the current transaction`,
      detail:
        'If the session is in a read-only transaction, this ends it. AuspexLens ' +
        'starts a fresh read-only transaction for every statement it sends, so ' +
        'its own protection is unaffected — but anything you run by hand ' +
        'afterwards is no longer inside the transaction you set up.',
      reference: REF_SET_TRANSACTION,
    };
  }

  // --- locking -------------------------------------------------------------
  if (head === 'lock' || /\bfor\s+update\b/i.test(stripped)) {
    return {
      level: 'notice',
      id: 'takes-locks',
      title: 'This takes locks other sessions will wait on',
      detail:
        'The locks are held until you commit or roll back. Oracle permits both ' +
        'LOCK TABLE and this statement inside a read-only transaction; AuspexLens ' +
        'refuses them on its read-only path anyway, because a query that blocks ' +
        'other people is not what anyone means by “read-only”.',
      reference: REF_SET_TRANSACTION,
    };
  }

  return NONE;
}

/** Whether the UI should stop and ask before running this. */
export function needsConfirmation(risk: StatementRisk): boolean {
  return risk.level === 'warning' || risk.level === 'destructive';
}

/** Whether the confirmation should require typing, rather than one click. */
export function needsTypedConfirmation(risk: StatementRisk): boolean {
  return risk.level === 'destructive';
}

/**
 * The word the user must type to confirm a destructive statement.
 *
 * The object name, not "yes" or "DELETE". Typing the name is the check that
 * catches the real mistake — running the right statement against the wrong
 * object — which a yes/no dialog cannot catch at all, because the answer is yes
 * either way.
 */
export function confirmationPhrase(sql: string): string | undefined {
  // Comments only. `stripNoise` also erases quoted identifiers, and in Oracle
  // `"Quoted"` is an identifier rather than a literal — using it here would find
  // no name on `DROP TABLE "Quoted"` and silently downgrade a destructive
  // statement to one that needs no typed confirmation.
  const stripped = stripComments(sql);
  const m = /^\s*(?:truncate|drop)\s+(?:table|view|index|sequence|synonym|procedure|function|package|trigger|type|user|materialized\s+view)\s+([a-zA-Z0-9_$#."]+)/i
    .exec(stripped);
  return m ? m[1]!.replace(/"/g, '').toUpperCase() : undefined;
}
