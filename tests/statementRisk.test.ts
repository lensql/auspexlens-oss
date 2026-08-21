import { describe, it, expect } from 'vitest';
import {
  assessRisk, needsConfirmation, needsTypedConfirmation, confirmationPhrase,
} from '../src/engine/statementRisk';

describe('the three surprises Oracle documents and people still hit', () => {
  it('DDL: says the implicit COMMIT will make pending work permanent', () => {
    const r = assessRisk('CREATE TABLE t (id NUMBER)');
    expect(r.level).toBe('warning');
    expect(r.id).toBe('implicit-commit');
    expect(r.detail).toMatch(/implicit COMMIT before it/);
    // The warning cites the paragraph that makes it true, so nobody has to take
    // our word for it and a future reader can check it is still true.
    expect(r.reference).toMatch(/SQL Language Reference/);
  });

  it('autonomous transactions: says read-only does not reach inside', () => {
    const r = assessRisk(
      'DECLARE PRAGMA AUTONOMOUS_TRANSACTION; BEGIN INSERT INTO t VALUES (1); COMMIT; END;',
    );
    expect(r.id).toBe('autonomous-transaction');
    expect(r.detail).toMatch(/independent one/);
    expect(r.detail).toMatch(/does not reach inside/);
  });

  it('COMMIT/ROLLBACK: says the read-only transaction ends', () => {
    expect(assessRisk('COMMIT').id).toBe('ends-transaction');
    expect(assessRisk('ROLLBACK').id).toBe('ends-transaction');
  });
});

describe('the specific warning wins over the general one', () => {
  it('DROP is described as irreversible, not as "this commits pending work"', () => {
    // Both are true. Only one is the point, and when two can fire the specific
    // one goes first or it never speaks.
    const r = assessRisk('DROP TABLE ventas');
    expect(r.id).toBe('irreversible-ddl');
    expect(r.level).toBe('destructive');
    expect(r.title).toMatch(/cannot be undone/);
  });

  it.each(['TRUNCATE TABLE ventas', 'DROP TABLE ventas', 'PURGE RECYCLEBIN'])(
    '%s is destructive', (sql) => {
      expect(assessRisk(sql).level).toBe('destructive');
    },
  );

  it('an autonomous block that also drops is described by the pragma first', () => {
    const r = assessRisk('DECLARE PRAGMA AUTONOMOUS_TRANSACTION; BEGIN NULL; END;');
    expect(r.id).toBe('autonomous-transaction');
  });

  it('GRANT is a privilege change, not just "some DDL"', () => {
    expect(assessRisk('GRANT SELECT ON t TO hr').id).toBe('privilege-change');
  });
});

describe('never nag', () => {
  it.each([
    'SELECT * FROM ventas',
    'WITH t AS (SELECT 1 FROM dual) SELECT * FROM t',
    'EXPLAIN PLAN FOR SELECT 1 FROM dual',
    'DESCRIBE ventas',
    'ALTER SESSION SET NLS_DATE_FORMAT = \'YYYY-MM-DD\'',
  ])('says nothing about %s', (sql) => {
    // A warning that fires on a plain SELECT is a warning that gets clicked
    // through — and then the one that mattered gets clicked through too.
    expect(assessRisk(sql).level).toBe('none');
  });

  it('is not fooled by the word DROP inside a string literal', () => {
    expect(assessRisk("SELECT 'DROP TABLE ventas' FROM dual").level).toBe('none');
  });

  it('is not fooled by a comment', () => {
    expect(assessRisk('/* DROP TABLE x */ SELECT 1 FROM dual').level).toBe('none');
  });

  it('says nothing about empty input', () => {
    expect(assessRisk('').level).toBe('none');
    expect(assessRisk('   ').level).toBe('none');
  });
});

describe('locks', () => {
  it('flags SELECT ... FOR UPDATE as taking locks others wait on', () => {
    const r = assessRisk('SELECT * FROM ventas FOR UPDATE');
    expect(r.id).toBe('takes-locks');
  });

  it('records that Oracle permits these inside a read-only transaction and we do not', () => {
    // A deliberate divergence, written down: Oracle's SET TRANSACTION doc lists
    // LOCK TABLE among the statements permitted in a read-only transaction.
    expect(assessRisk('LOCK TABLE ventas IN EXCLUSIVE MODE').detail)
      .toMatch(/Oracle permits both LOCK TABLE/);
  });
});

describe('confirmation', () => {
  it('asks for confirmation on warnings and destructive statements only', () => {
    expect(needsConfirmation(assessRisk('SELECT 1 FROM dual'))).toBe(false);
    expect(needsConfirmation(assessRisk('COMMIT'))).toBe(false);
    expect(needsConfirmation(assessRisk('CREATE TABLE t (id NUMBER)'))).toBe(true);
    expect(needsConfirmation(assessRisk('DROP TABLE t'))).toBe(true);
  });

  it('requires TYPING only for the irreversible ones', () => {
    expect(needsTypedConfirmation(assessRisk('CREATE TABLE t (id NUMBER)'))).toBe(false);
    expect(needsTypedConfirmation(assessRisk('DROP TABLE t'))).toBe(true);
  });

  it('asks for the OBJECT NAME, not for the word "yes"', () => {
    // The real mistake is the right statement against the wrong object, and a
    // yes/no dialog cannot catch it: the answer is yes either way.
    expect(confirmationPhrase('DROP TABLE ventas')).toBe('VENTAS');
    expect(confirmationPhrase('TRUNCATE TABLE hr.employees')).toBe('HR.EMPLOYEES');
    expect(confirmationPhrase('drop  materialized view  mv_sales')).toBe('MV_SALES');
    expect(confirmationPhrase('DROP TABLE "Quoted"')).toBe('QUOTED');
  });

  it('has no phrase for statements that are not object-destroying', () => {
    expect(confirmationPhrase('SELECT 1 FROM dual')).toBeUndefined();
    expect(confirmationPhrase('CREATE TABLE t (id NUMBER)')).toBeUndefined();
  });
});

describe('ALTER SESSION and ALTER SYSTEM are not object DDL', () => {
  it.each([
    "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD'",
    'ALTER SESSION SET CURRENT_SCHEMA = HR',
    'alter system set open_cursors = 400',
  ])('says nothing about %s', (sql) => {
    // Oracle's SET TRANSACTION documentation lists both among the statements
    // permitted inside a read-only transaction. Warning about them would be both
    // wrong and the kind of false alarm that teaches people to click through the
    // warnings that matter.
    expect(assessRisk(sql).level).toBe('none');
  });

  it('still warns about ALTER TABLE, which is object DDL', () => {
    expect(assessRisk('ALTER TABLE ventas ADD (x NUMBER)').id).toBe('implicit-commit');
  });
});
