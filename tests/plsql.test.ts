import { describe, it, expect } from 'vitest';
import { looksLikePlSql, stripSqlPlusTerminator } from '../src/plsql/run';

describe('routing', () => {
  it.each([
    'BEGIN NULL; END;',
    'DECLARE x NUMBER; BEGIN NULL; END;',
    'CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;',
    'CREATE PACKAGE pkg AS END;',
    'create or replace function f return number is begin return 1; end;',
  ])('routes %s to the explicit PL/SQL path', (sql) => {
    expect(looksLikePlSql(sql)).toBe(true);
  });

  it.each([
    'SELECT 1 FROM dual',
    'WITH t AS (SELECT 1 FROM dual) SELECT * FROM t',
    'EXPLAIN PLAN FOR SELECT 1 FROM dual',
    'CREATE TABLE t (id NUMBER)',
  ])('leaves %s on the read-only path', (sql) => {
    // Ambiguous goes to the READ-ONLY path deliberately: the guard refuses it if
    // it is unsafe, which costs a message. The other direction runs unguarded.
    expect(looksLikePlSql(sql)).toBe(false);
  });
});

describe('the terminator, and only the terminator', () => {
  it("keeps END's own semicolon", () => {
    // Stripping it turns a valid block into PLS-00103, which reads like the
    // user's code is wrong when it was ours.
    expect(stripSqlPlusTerminator('BEGIN NULL; END;')).toBe('BEGIN NULL; END;');
  });

  it('removes a trailing SQL*Plus slash', () => {
    expect(stripSqlPlusTerminator('BEGIN NULL; END;\n/')).toBe('BEGIN NULL; END;');
    expect(stripSqlPlusTerminator('BEGIN NULL; END;\n  /  ')).toBe('BEGIN NULL; END;');
  });

  it('leaves a slash that is part of the code alone', () => {
    expect(stripSqlPlusTerminator('BEGIN x := 6 / 2; END;')).toBe('BEGIN x := 6 / 2; END;');
  });
});
