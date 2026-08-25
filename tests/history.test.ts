/**
 * Query history and saved queries.
 *
 * The assertion that matters most is the one about what is NOT stored. This
 * product masks personal data in the engine, before anything sees it; a history
 * that cached rows would be a copy of production data in VS Code's global state,
 * outside every control the rest of the product is built on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pushHistory, summarise, redactLiterals, saveQuery, removeQuery, ago,
  HISTORY_LIMIT, type HistoryEntry,
} from '../src/editor/history';

const SRC = readFileSync(join(__dirname, '..', 'src', 'editor', 'history.ts'), 'utf8');
const e = (sql: string, at = 1000, profileId = 'p'): HistoryEntry => ({ sql, at, profileId });

describe('history remembers what was asked, never what came back', () => {
  it('has no field for rows or results anywhere in its shape', () => {
    // The commitment tiers.ts makes with `builtOn: 'local storage only'`. A row
    // cache here would sit outside the masking every other consumer goes
    // through.
    const iface = SRC.slice(SRC.indexOf('export interface HistoryEntry'), SRC.indexOf('export interface SavedQuery'));
    for (const word of ['rows', 'results', 'columns']) {
      expect(iface.toLowerCase(), `HistoryEntry mentions ${word}`).not.toContain(`${word}:`);
    }
  });

  it('keeps the statement, when it ran, and against which connection', () => {
    const [entry] = pushHistory([], e('SELECT 1 FROM dual'));
    expect(entry!.sql).toBe('SELECT 1 FROM dual');
    expect(entry!.at).toBe(1000);
    expect(entry!.profileId).toBe('p');
  });
});

describe('what goes into the list', () => {
  it('puts the newest first', () => {
    const h = pushHistory(pushHistory([], e('A', 1)), e('B', 2));
    expect(h.map((x) => x.sql)).toEqual(['B', 'A']);
  });

  it('collapses a statement repeated back to back, and moves its clock', () => {
    // Running the same query three times in a row is one thing you did.
    const h = pushHistory(pushHistory([], e('A', 1)), e('A', 5));
    expect(h.length).toBe(1);
    expect(h[0]!.at).toBe(5);
  });

  it('keeps the same statement twice when something ran between', () => {
    // …but running it now and again an hour later is two, and collapsing those
    // would erase the timeline that makes history worth having.
    let h = pushHistory([], e('A', 1));
    h = pushHistory(h, e('B', 2));
    h = pushHistory(h, e('A', 3));
    expect(h.map((x) => x.sql)).toEqual(['A', 'B', 'A']);
  });

  it('treats the same statement on another connection as another entry', () => {
    const h = pushHistory(pushHistory([], e('A', 1, 'prod')), e('A', 2, 'staging'));
    expect(h.length).toBe(2);
  });

  it('ignores an empty statement rather than storing a blank row', () => {
    expect(pushHistory([], e('   '))).toEqual([]);
  });

  it('caps the list by count, so neither extreme of usage is wrong', () => {
    // A time window would lose everything for someone who runs three queries a
    // week, and keep a week of production literals for someone who runs three
    // hundred a day.
    let h: HistoryEntry[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) h = pushHistory(h, e(`Q${i}`, i));
    expect(h.length).toBe(HISTORY_LIMIT);
    expect(h[0]!.sql).toBe(`Q${HISTORY_LIMIT + 24}`);
  });

  it('never mutates the list it was given', () => {
    const original = pushHistory([], e('A'));
    const copy = [...original];
    pushHistory(original, e('B'));
    expect(original).toEqual(copy);
  });
});

describe('reading a statement in a list', () => {
  it('flattens a query formatted across many lines', () => {
    expect(summarise('SELECT *\n  FROM t\n WHERE x = 1')).toBe('SELECT * FROM t WHERE x = 1');
  });

  it('truncates predictably, because a scannable list needs one width', () => {
    const long = `SELECT ${'col, '.repeat(60)}FROM t`;
    expect(summarise(long).length).toBe(90);
    expect(summarise(long).endsWith('…')).toBe(true);
  });
});

describe('redacting literals is a courtesy, not a control', () => {
  it('hides quoted strings, honouring the doubled-quote escape', () => {
    expect(redactLiterals("SELECT * FROM t WHERE name = 'Ada Lovelace'"))
      .toBe("SELECT * FROM t WHERE name = '…'");
    expect(redactLiterals("WHERE s = 'it''s here'")).toBe("WHERE s = '…'");
  });

  it('hides bare numbers', () => {
    expect(redactLiterals('WHERE id = 12345')).toBe('WHERE id = …');
    expect(redactLiterals('WHERE amount > 99.95')).toBe('WHERE amount > …');
  });

  it('leaves digits inside identifiers alone', () => {
    // T1 and COL_2 are names, not values, and mangling them makes the statement
    // unreadable for no gain.
    expect(redactLiterals('SELECT COL_2 FROM T1')).toBe('SELECT COL_2 FROM T1');
  });

  it('is described as a courtesy in its own documentation', () => {
    // The comment is the control here: someone will otherwise cite this function
    // as a reason a secret cannot leak, and it cannot find a table named after a
    // customer.
    expect(SRC).toMatch(/not\*\* a security control|is \*\*not\*\* a security control/);
  });
});

describe('saved queries are looked up by name', () => {
  it('stores and sorts by name, not by recency', () => {
    let s = saveQuery([], 'zebra', 'SELECT 1', 1);
    s = saveQuery(s, 'alpha', 'SELECT 2', 2);
    expect(s.map((q) => q.name)).toEqual(['alpha', 'zebra']);
  });

  it('replaces a query saved under a name already in use', () => {
    let s = saveQuery([], 'daily', 'SELECT 1', 1);
    s = saveQuery(s, 'daily', 'SELECT 2', 2);
    expect(s.length).toBe(1);
    expect(s[0]!.sql).toBe('SELECT 2');
  });

  it('trims the name and the statement', () => {
    expect(saveQuery([], '  daily  ', '  SELECT 1  ', 1)[0]).toMatchObject({
      name: 'daily', sql: 'SELECT 1',
    });
  });

  it('refuses a nameless query and an empty one', () => {
    expect(() => saveQuery([], '  ', 'SELECT 1', 1)).toThrow(/needs a name/);
    expect(() => saveQuery([], 'x', '   ', 1)).toThrow(/nothing to save/);
  });

  it('removes by name, and does nothing for a name that is not there', () => {
    const s = saveQuery([], 'daily', 'SELECT 1', 1);
    expect(removeQuery(s, 'daily')).toEqual([]);
    expect(removeQuery(s, 'weekly')).toEqual(s);
  });
});

describe('how long ago', () => {
  const now = Date.parse('2026-08-25T12:00:00Z');
  it('answers in the units a person asks in', () => {
    expect(ago(now - 5_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago');
  });

  it('gives a date once "ago" stops being a number anyone converts', () => {
    expect(ago(Date.parse('2026-08-14T09:00:00Z'), now)).toBe('2026-08-14');
  });

  it('never reports a negative age from a clock that moved', () => {
    expect(ago(now + 10_000, now)).toBe('just now');
  });
});
