import { describe, it, expect } from 'vitest';
import { maskRows, maskValue, isPersonalColumn, DEFAULT_POLICY } from '../src/engine/piiMask';

describe('column classification', () => {
  it.each([
    'EMAIL', 'customer_email', 'billing_phone', 'TAX_ID', 'rfc', 'curp',
    'card_number', 'home_address', 'date_of_birth', 'api_key', 'full_name',
  ])('treats %s as personal', (name) => {
    expect(isPersonalColumn(name)).toBe(true);
  });

  it.each(['ID', 'TOTAL_CENTS', 'created_at', 'status', 'quantity'])(
    'leaves %s alone', (name) => { expect(isPersonalColumn(name)).toBe(false); },
  );

  it('honours an explicit allow, even when the name matches', () => {
    expect(isPersonalColumn('email', { mode: 'named', allowColumns: ['EMAIL'] })).toBe(false);
  });

  it('honours an explicit extra column', () => {
    expect(isPersonalColumn('nickname', { mode: 'named', extraColumns: ['nickname'] })).toBe(true);
  });
});

describe('value masking keeps shape and loses content', () => {
  it('keeps the last two characters of a long string', () => {
    expect(maskValue('ada@example.invalid')).toBe('•'.repeat(17) + 'id');
  });

  it('fully masks short strings', () => {
    expect(maskValue('abc')).toBe('•••');
  });

  it('nulls numbers and dates rather than making up digits', () => {
    expect(maskValue(12345)).toBeNull();
    expect(maskValue(new Date())).toBeNull();
  });

  it('passes null and undefined through untouched', () => {
    expect(maskValue(null)).toBeNull();
    expect(maskValue(undefined)).toBeUndefined();
  });
});

describe('maskRows', () => {
  const columns = ['ID', 'FULL_NAME', 'EMAIL', 'TOTAL_CENTS'];
  const rows = [[1, 'Ada Demo', 'ada@example.invalid', 129900]];

  it('masks only the personal columns and reports which', () => {
    const { rows: out, report } = maskRows(columns, rows);
    expect(out[0]![0]).toBe(1);
    expect(out[0]![3]).toBe(129900);
    expect(String(out[0]![1])).toMatch(/•/);
    expect(String(out[0]![2])).toMatch(/•/);
    expect(report.columns).toEqual(['FULL_NAME', 'EMAIL']);
  });

  it('does not mutate the caller rows', () => {
    const original = JSON.parse(JSON.stringify(rows));
    maskRows(columns, rows);
    expect(rows).toEqual(original);
  });

  it('mode "all" masks every column', () => {
    const { report } = maskRows(columns, rows, { mode: 'all' });
    expect(report.columns).toEqual(columns);
  });

  it('mode "off" returns the rows untouched and reports nothing', () => {
    const { rows: out, report } = maskRows(columns, rows, { mode: 'off' });
    expect(out).toBe(rows);
    expect(report.columns).toEqual([]);
  });

  it('the default policy is "named", not "off"', () => {
    // A default that masks nothing is a default nobody notices is wrong.
    expect(DEFAULT_POLICY.mode).toBe('named');
  });
});
