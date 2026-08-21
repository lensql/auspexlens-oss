import { describe, it, expect } from 'vitest';
import { inspect, stripNoise, stripComments, assertReadOnly, SqlGuardError } from '../src/engine/sqlGuard';

const allowed = (sql: string) => {
  const v = inspect(sql);
  expect(v.allowed, `expected ALLOWED but got: ${v.allowed ? '' : v.reason}`).toBe(true);
  return v as Extract<typeof v, { allowed: true }>;
};

const refused = (sql: string) => {
  const v = inspect(sql);
  expect(v.allowed, `expected REFUSED but the guard allowed: ${sql}`).toBe(false);
  return v as Extract<typeof v, { allowed: false }>;
};

describe('what Oracle lets through and this guard must not', () => {
  // Each of these was measured ALLOWED inside SET TRANSACTION READ ONLY against
  // a real Oracle database on 2026-08-20 (docs/RESEARCH.md §17.2). They are the
  // reason this file exists: the database is not going to stop them.
  it.each([
    ['CREATE TABLE evil (id NUMBER)'],
    ['create table evil (id number)'],
    ['TRUNCATE TABLE ventas'],
    ['DROP TABLE ventas'],
    ['DROP TABLE ventas PURGE'],
    ['GRANT SELECT ANY TABLE TO attacker'],
    ['REVOKE SELECT ON ventas FROM app'],
    ['ALTER TABLE ventas ADD (x NUMBER)'],
    ['RENAME ventas TO ventas_old'],
    ['COMMENT ON TABLE ventas IS \'x\''],
    ['FLASHBACK TABLE ventas TO BEFORE DROP'],
    ['PURGE RECYCLEBIN'],
  ])('refuses %s — Oracle would allow it', (sql) => {
    const v = refused(sql);
    expect(v.reason).toMatch(/DDL|privileges|recycle|table state/i);
  });

  it('refuses a PL/SQL block, which can write through an autonomous transaction', () => {
    const v = refused(
      "DECLARE PRAGMA AUTONOMOUS_TRANSACTION; BEGIN INSERT INTO ventas VALUES (1); COMMIT; END;",
    );
    expect(v.offendingKeyword).toBe('declare');
  });

  it('refuses a bare BEGIN block too', () => {
    expect(refused('BEGIN NULL; END;').offendingKeyword).toBe('begin');
  });

  it('refuses COMMIT and ROLLBACK, which END the read-only transaction', () => {
    expect(refused('COMMIT').reason).toMatch(/ends the read-only transaction/);
    expect(refused('ROLLBACK').reason).toMatch(/ends the read-only transaction/);
  });

  it('refuses SET TRANSACTION — the engine issues its own', () => {
    expect(refused('SET TRANSACTION READ WRITE').allowed).toBe(false);
  });
});

describe('plain DML', () => {
  it.each([
    ['INSERT INTO ventas VALUES (1)'],
    ['UPDATE ventas SET total = 0'],
    ['DELETE FROM ventas'],
    ['MERGE INTO ventas t USING dual s ON (1=1) WHEN NOT MATCHED THEN INSERT VALUES (1)'],
  ])('refuses %s', (sql) => {
    expect(refused(sql).allowed).toBe(false);
  });
});

describe('what is allowed', () => {
  it('allows a plain SELECT, in a read-only transaction', () => {
    const v = allowed('SELECT * FROM ventas');
    expect(v.kind).toBe('query');
    expect(v.needsReadOnlyTransaction).toBe(true);
  });

  it('allows a WITH ... SELECT', () => {
    expect(allowed('WITH t AS (SELECT 1 AS n FROM dual) SELECT n FROM t').kind).toBe('query');
  });

  it('allows a leading parenthesis', () => {
    expect(allowed('(SELECT 1 FROM dual)').kind).toBe('query');
  });

  it('allows DESCRIBE', () => {
    expect(allowed('DESCRIBE ventas').kind).toBe('describe');
  });

  it('allows EXPLAIN PLAN — and marks it as NOT needing the read-only transaction', () => {
    // The measured trap: EXPLAIN PLAN writes into the GTT PLAN_TABLE$ and fails
    // with ORA-00604 inside a read-only transaction. Basic explain is a FREE
    // feature, so wrapping everything in read-only would have broken it.
    const v = allowed('EXPLAIN PLAN FOR SELECT * FROM ventas');
    expect(v.kind).toBe('explain');
    expect(v.needsReadOnlyTransaction).toBe(false);
  });

  it('refuses EXPLAIN that is not EXPLAIN PLAN', () => {
    expect(refused('EXPLAIN SELECT 1').allowed).toBe(false);
  });
});

describe('the ways round a naive guard', () => {
  it('refuses SELECT ... FOR UPDATE, which takes row locks', () => {
    expect(refused('SELECT * FROM ventas FOR UPDATE').offendingKeyword).toBe('for update');
  });

  it('refuses a second statement riding along', () => {
    expect(refused('SELECT 1 FROM dual; DROP TABLE ventas').reason).toMatch(/more than one statement/);
  });

  it('allows a single trailing semicolon', () => {
    expect(allowed('SELECT 1 FROM dual;').kind).toBe('query');
  });

  it('is not fooled by a semicolon inside a string literal', () => {
    expect(allowed("SELECT ';' FROM dual").kind).toBe('query');
  });

  it('is not fooled by a DROP hidden in a string literal', () => {
    expect(allowed("SELECT 'DROP TABLE ventas' FROM dual").kind).toBe('query');
  });

  it('is not fooled by a leading comment', () => {
    expect(allowed('-- harmless\nSELECT 1 FROM dual').kind).toBe('query');
    expect(allowed('/* harmless */ SELECT 1 FROM dual').kind).toBe('query');
  });

  it('refuses a statement whose real verb hides behind a comment', () => {
    expect(refused('/* SELECT */ DROP TABLE ventas').offendingKeyword).toBe('drop');
  });

  it('refuses a WITH clause that feeds an INSERT', () => {
    expect(refused('WITH t AS (SELECT 1 AS n FROM dual) INSERT INTO ventas SELECT n FROM t').allowed).toBe(false);
  });

  it('refuses WITH FUNCTION, which compiles PL/SQL', () => {
    const sql = 'WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM dual';
    expect(refused(sql).offendingKeyword).toBe('with function');
  });

  it('refuses an unknown verb rather than guessing', () => {
    const v = refused('ANALYZE TABLE ventas COMPUTE STATISTICS');
    expect(v.reason).toMatch(/allowlist/);
  });

  it('refuses empty and whitespace-only input', () => {
    expect(refused('').allowed).toBe(false);
    expect(refused('   \n  ').allowed).toBe(false);
  });

  it('refuses a comment with no statement at all', () => {
    expect(refused('-- nothing here').allowed).toBe(false);
  });
});

describe('stripNoise', () => {
  it('removes line and block comments', () => {
    expect(stripNoise('SELECT 1 -- x\nFROM dual').includes('x')).toBe(false);
    expect(stripNoise('SELECT /* x */ 1').includes('x')).toBe(false);
  });

  it('handles a doubled quote inside a literal', () => {
    // 'it''s' is one literal, so what follows is still structure.
    expect(stripNoise("SELECT 'it''s' FROM dual")).toMatch(/SELECT\s+\s*FROM dual/);
  });

  it('leaves a literal as whitespace so words cannot fuse', () => {
    expect(stripNoise("a'x'b")).toBe('a b');
  });
});

describe('assertReadOnly', () => {
  it('returns the verdict when allowed', () => {
    expect(assertReadOnly('SELECT 1 FROM dual').kind).toBe('query');
  });

  it('throws SqlGuardError when refused', () => {
    expect(() => assertReadOnly('DROP TABLE ventas')).toThrow(SqlGuardError);
  });
});

describe('stripComments vs stripNoise — why there are two', () => {
  it('stripComments keeps a quoted identifier, which in Oracle is a NAME', () => {
    expect(stripComments('DROP TABLE "Quoted"')).toBe('DROP TABLE "Quoted"');
  });

  it('stripNoise erases it, which is right for the guard and wrong for reading names', () => {
    expect(stripNoise('DROP TABLE "Quoted"')).not.toContain('Quoted');
  });

  it('stripComments still removes both comment styles', () => {
    expect(stripComments('SELECT 1 -- x\nFROM dual')).not.toContain('x');
    expect(stripComments('SELECT /* x */ 1')).not.toContain('x');
  });

  it('a comment marker inside a literal does not start a comment', () => {
    expect(stripComments("SELECT '--not a comment' FROM dual")).toContain('not a comment');
  });
});
