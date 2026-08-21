import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS, FORBIDDEN_TOOL_NAMES, toolByName } from '../src/mcp/tools';
import { handleTool, MCP_MAX_ROWS } from '../src/mcp/handlers';
import { tokenMatches, newSessionSecret } from '../src/mcp/bridge';
import { SqlGuardError } from '../src/engine/sqlGuard';

function fakeConn(result: { rows?: unknown[][]; metaData?: { name: string }[] } = {}) {
  const sent: string[] = [];
  return {
    sent,
    conn: {
      async execute(sql: string) { sent.push(sql); return sql.startsWith('SET') ? {} : result; },
      async rollback() { sent.push('ROLLBACK'); },
    },
  };
}

describe('the tool surface', () => {
  it('exposes no tool that could write', () => {
    const names = TOOLS.map((t) => t.name);
    for (const forbidden of FORBIDDEN_TOOL_NAMES) {
      expect(names, `${forbidden} must never be a tool`).not.toContain(forbidden);
    }
  });

  it('has exactly one free-text entry point, and it is named for what it does', () => {
    const freeText = TOOLS.filter((t) => 'sql' in t.inputSchema.properties);
    expect(freeText.map((t) => t.name).sort()).toEqual(['explain_query', 'run_query']);
  });

  it('tells the model what will be refused, so it does not spend turns rephrasing', () => {
    const run = toolByName('run_query')!;
    for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'GRANT']) {
      expect(run.description).toContain(verb);
    }
    expect(run.description).toMatch(/masked/);
  });

  it('is designed against Oracle rather than copied from the Redshift product', () => {
    const names = TOOLS.map((t) => t.name);
    // ALL_SOURCE and ALL_ERRORS have no Redshift equivalent; their absence would
    // be the tell that the contract was copied.
    expect(names).toContain('read_source');
    expect(names).toContain('read_compile_errors');
  });

  it('every declared tool is implemented', async () => {
    const { conn } = fakeConn({ rows: [], metaData: [] });
    for (const tool of TOOLS) {
      const args: Record<string, unknown> = {};
      for (const key of tool.inputSchema.required ?? []) {
        args[key] = key === 'kind' ? 'TABLE' : 'X';
      }
      if ('sql' in tool.inputSchema.properties) args['sql'] = 'SELECT 1 FROM dual';
      await expect(handleTool({ conn }, tool.name, args), tool.name).resolves.toBeDefined();
    }
  });
});

describe('the guard is not bypassable from a tool', () => {
  it.each([
    'DROP TABLE ventas',
    'TRUNCATE TABLE ventas',
    'DELETE FROM ventas',
    'BEGIN NULL; END;',
    'DECLARE PRAGMA AUTONOMOUS_TRANSACTION; BEGIN NULL; COMMIT; END;',
    'SELECT 1 FROM dual; DROP TABLE ventas',
    'GRANT DBA TO attacker',
  ])('run_query refuses %s and sends nothing', async (sql) => {
    const { conn, sent } = fakeConn();
    await expect(handleTool({ conn }, 'run_query', { sql })).rejects.toThrow(SqlGuardError);
    expect(sent).toEqual([]);
  });

  it('explain_query is refused the same statements', async () => {
    const { conn } = fakeConn();
    await expect(handleTool({ conn }, 'explain_query', { sql: 'DROP TABLE x' }))
      .rejects.toThrow(SqlGuardError);
  });

  it('an unknown tool is refused, not ignored', async () => {
    const { conn } = fakeConn();
    await expect(handleTool({ conn }, 'execute_sql', { sql: 'DROP TABLE x' }))
      .rejects.toThrow(/unknown tool/);
  });

  it('an unknown object kind is refused rather than returning zero rows', async () => {
    const { conn } = fakeConn({ rows: [], metaData: [] });
    await expect(handleTool({ conn }, 'list_objects', { owner: 'HR', kind: 'ROOTKIT' }))
      .rejects.toThrow(/unknown object kind/);
  });
});

describe('limits belong to the server, not the caller', () => {
  it('caps rows even when the caller asks for more', async () => {
    let opts: Record<string, unknown> | undefined;
    const conn = {
      async execute(sql: string, _b?: unknown, o?: Record<string, unknown>) {
        if (!sql.startsWith('SET')) opts = o;
        return { rows: [], metaData: [] };
      },
      async rollback() {},
    };
    await handleTool({ conn }, 'run_query', { sql: 'SELECT 1 FROM dual', maxRows: '999999' });
    expect(opts?.['maxRows']).toBe(MCP_MAX_ROWS);
  });

  it('masking reaches the model, and is reported', async () => {
    const { conn } = fakeConn({
      rows: [[1, 'ada@example.invalid']],
      metaData: [{ name: 'ID' }, { name: 'EMAIL' }],
    });
    const res = await handleTool({ conn }, 'run_query', { sql: 'SELECT id, email FROM c' });
    expect(String(res.rows[0]![1])).toMatch(/•/);
    expect(res.maskedColumns).toEqual(['EMAIL']);
  });
});

describe('the bridge authenticates', () => {
  it('accepts the right secret and rejects everything else', () => {
    const s = newSessionSecret();
    expect(tokenMatches(s, s)).toBe(true);
    // Flip the last character to something it is NOT. The first version always
    // appended '0', and a hex secret ends in '0' one time in sixteen — the
    // mutation was then a no-op, the "wrong" secret was the right one, and the
    // test failed at random. A flaky guard test is worse than none: the failure
    // that cried wolf here is the one nobody reads on the day it means it.
    const flipped = s.slice(0, -1) + (s.endsWith('0') ? '1' : '0');
    expect(tokenMatches(s, flipped)).toBe(false);
    expect(tokenMatches(s, '')).toBe(false);
    expect(tokenMatches(s, undefined)).toBe(false);
    expect(tokenMatches(s, 123)).toBe(false);
  });

  it('secrets are long and never repeat', () => {
    expect(newSessionSecret()).toHaveLength(64);
    expect(newSessionSecret()).not.toBe(newSessionSecret());
  });
});

describe('the MCP server cannot reach the PL/SQL path', () => {
  it('no file under src/mcp imports src/plsql', () => {
    // The boundary that keeps 'two paths, one floor' true. Maintained by this
    // test rather than by discipline: a boundary nothing checks is a convention.
    //
    // It matches an IMPORT and not the word, because the tool descriptions have
    // to talk about PL/SQL — read_source and read_compile_errors exist precisely
    // to read it. This is the third time on this product that a check confused a
    // mention with a use; each time the answer is to make the check precise, not
    // to soften what it protects.
    const IMPORTS_PLSQL = /(?:from|require\()\s*['"][^'"]*\/plsql\//;
    for (const file of ['tools.ts', 'handlers.ts', 'bridge.ts']) {
      const text = readFileSync(join(__dirname, '..', 'src', 'mcp', file), 'utf8');
      expect(text, `src/mcp/${file} must not import the PL/SQL path`).not.toMatch(IMPORTS_PLSQL);
    }
  });

  it('…and the check would catch it if one did', () => {
    // A negative assertion that has never been seen to fail is a negative
    // assertion nobody has tested. This is its positive case.
    const IMPORTS_PLSQL = /(?:from|require\()\s*['"][^'"]*\/plsql\//;
    expect("import { runAnonymousBlock } from '../plsql/run';").toMatch(IMPORTS_PLSQL);
    expect("const x = require('../plsql/run');").toMatch(IMPORTS_PLSQL);
    expect("// read_source returns PL/SQL source").not.toMatch(IMPORTS_PLSQL);
  });
});

describe('catalog tools actually bind their parameters', () => {
  it('passes the bind values with the statement', async () => {
    let seen: unknown;
    const conn = {
      async execute(sql: string, binds?: unknown) {
        if (!sql.startsWith('SET')) seen = binds;
        return { rows: [], metaData: [] };
      },
      async rollback() {},
    };
    await handleTool({ conn }, 'describe_table', { owner: 'hr', table: 'employees' });
    expect(seen).toEqual({ owner: 'HR', tab: 'EMPLOYEES' });
  });
});
