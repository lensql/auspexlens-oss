import { describe, it, expect } from 'vitest';
import {
  childrenQuery, folderNodes, schemaNodes, objectNodes, columnNodes,
  formatType, hasSource, sourceQueryFor, SCHEMA_FOLDERS,
} from '../src/explorer/tree';

describe('what a node expands to', () => {
  it('the root asks for schemas', () => {
    expect(childrenQuery(undefined)!.sql).toMatch(/FROM all_objects/);
  });

  it('a schema synthesises folders rather than querying', () => {
    expect(childrenQuery({ kind: 'schema', label: 'HR', id: 'HR', owner: 'HR', expandable: true }))
      .toBeNull();
    expect(folderNodes('HR')).toHaveLength(SCHEMA_FOLDERS.length);
  });

  it('a folder asks for objects of its kind, bound not concatenated', () => {
    const q = childrenQuery({
      kind: 'folder', label: 'Tables', id: 'HR/TABLE', owner: 'HR',
      objectKind: 'TABLE', expandable: true,
    })!;
    expect(q.binds).toEqual({ owner: 'HR', kind: 'TABLE' });
    expect(q.sql).not.toContain('HR');
  });

  it('a table expands to columns; a package does not expand', () => {
    const table = { kind: 'object' as const, label: 'T', id: 'HR/TABLE/T', owner: 'HR',
                    objectKind: 'TABLE' as const, objectName: 'T', expandable: true };
    expect(childrenQuery(table)!.binds).toEqual({ owner: 'HR', tab: 'T' });

    const pkg = { ...table, objectKind: 'PACKAGE' as const, expandable: false };
    expect(childrenQuery(pkg)).toBeNull();
  });
});

describe('nodes', () => {
  it('shows a non-VALID status, because that is what you are looking for', () => {
    const [node] = objectNodes('HR', 'PACKAGE', [['PKG_X', 'INVALID', null]]);
    expect(node!.description).toBe('INVALID');
  });

  it('says nothing for a VALID object', () => {
    const [node] = objectNodes('HR', 'PACKAGE', [['PKG_Y', 'VALID', null]]);
    expect(node!.description).toBeUndefined();
  });

  it('builds schema nodes from rows', () => {
    expect(schemaNodes([['HR'], ['SCOTT']]).map((n) => n.label)).toEqual(['HR', 'SCOTT']);
  });

  it('describes columns the way a DBA writes them', () => {
    const [c] = columnNodes('HR', 'T', [['TOTAL', 'NUMBER', null, 12, 2, 'N', 1]]);
    expect(c!.description).toBe('NUMBER(12,2) NOT NULL');
  });

  it('marks nullable columns by omission, not by noise', () => {
    const [c] = columnNodes('HR', 'T', [['NOTE', 'VARCHAR2', 120, null, null, 'Y', 2]]);
    expect(c!.description).toBe('VARCHAR2(120)');
  });
});

describe('formatType', () => {
  it.each([
    ['NUMBER', undefined, 12, 2, 'NUMBER(12,2)'],
    ['NUMBER', undefined, 10, 0, 'NUMBER(10)'],
    ['VARCHAR2', 120, undefined, undefined, 'VARCHAR2(120)'],
    ['DATE', undefined, undefined, undefined, 'DATE'],
    ['CLOB', undefined, undefined, undefined, 'CLOB'],
  ])('%s -> %s', (t, l, p, s, expected) => {
    expect(formatType(t, l as number | undefined, p as number | undefined, s as number | undefined))
      .toBe(expected);
  });
});

describe('source', () => {
  it('offers source for PL/SQL objects only', () => {
    expect(hasSource('PACKAGE')).toBe(true);
    expect(hasSource('PROCEDURE')).toBe(true);
    expect(hasSource('TABLE')).toBe(false);
    expect(hasSource(undefined)).toBe(false);
  });

  it('builds a bound source query for a package', () => {
    const q = sourceQueryFor({
      kind: 'object', label: 'P', id: 'x', owner: 'HR',
      objectKind: 'PACKAGE', objectName: 'P', expandable: false,
    })!;
    expect(q.binds).toEqual({ owner: 'HR', name: 'P', type: 'PACKAGE' });
  });

  it('offers none for a table', () => {
    expect(sourceQueryFor({
      kind: 'object', label: 'T', id: 'x', owner: 'HR',
      objectKind: 'TABLE', objectName: 'T', expandable: true,
    })).toBeNull();
  });
});
