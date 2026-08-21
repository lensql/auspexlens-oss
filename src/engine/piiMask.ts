/**
 * Masking personal data, in the engine, before anything sees the rows.
 *
 * The placement is the whole design. Every consumer — the results grid, the CSV
 * and JSON exports, and above all the MCP server that hands rows to a language
 * model — receives rows that have already been through here. There is no code
 * path that reads a row without passing this function, and moving the check
 * outward is how exactly one consumer ends up with the raw values. That rule is
 * inherited from RedLens and is not up for renegotiation per-feature.
 *
 * What it is NOT: a classifier that tries to detect personal data by looking at
 * it. Heuristics on values are wrong in both directions and expensive on every
 * cell. This masks by COLUMN NAME, which is a decision the user can see, audit
 * and override, and it errs toward masking.
 */

export type MaskMode = 'off' | 'named' | 'all';

export interface MaskPolicy {
  mode: MaskMode;
  /** Extra column names to treat as personal, lowercased on comparison. */
  extraColumns?: string[];
  /** Column names to exempt even when they match a pattern. */
  allowColumns?: string[];
}

export interface MaskReport {
  /** Column names that were masked, in the order they appear. */
  columns: string[];
  mode: MaskMode;
}

export const DEFAULT_POLICY: MaskPolicy = { mode: 'named' };

/**
 * Column-name fragments that mean "this holds personal data".
 *
 * Substring matching, not exact: real schemas name things `customer_email`,
 * `EMAIL_ADDR`, `billing_phone`. Deliberately broad — a false positive costs a
 * user one setting change, a false negative sends a real person's data to a
 * language model.
 *
 * `tax_id`/`rfc`/`curp` are here because this product's first market is Mexico
 * and those are national identifiers; `ssn` and `nif` cover the obvious
 * equivalents elsewhere.
 */
const PERSONAL_FRAGMENTS = [
  'email', 'mail',
  'phone', 'mobile', 'telefono', 'celular',
  'ssn', 'social_security',
  'passport', 'pasaporte',
  'tax_id', 'taxid', 'rfc', 'curp', 'nif', 'dni',
  'iban', 'card_number', 'cardnumber', 'credit_card', 'ccnum',
  'address', 'direccion', 'street', 'postcode', 'zipcode', 'zip_code',
  'birth', 'nacimiento', 'dob',
  'password', 'passwd', 'secret', 'token', 'api_key', 'apikey',
  'full_name', 'fullname', 'first_name', 'last_name', 'surname', 'apellido',
];

export function isPersonalColumn(name: string, policy: MaskPolicy = DEFAULT_POLICY): boolean {
  const lower = name.toLowerCase();
  if (policy.allowColumns?.some((a) => a.toLowerCase() === lower)) return false;
  if (policy.extraColumns?.some((e) => e.toLowerCase() === lower)) return true;
  return PERSONAL_FRAGMENTS.some((f) => lower.includes(f));
}

/**
 * Replace a value with something that keeps its shape and loses its content.
 *
 * Shape is kept on purpose: a grid full of identical blobs makes a result set
 * unreadable, and someone will turn masking off to get their work done. Length
 * and the last characters are enough to recognise a row without disclosing it.
 */
export function maskValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') return null;
  if (value instanceof Date) return null;
  const s = String(value);
  if (s.length === 0) return s;
  if (s.length <= 4) return '•'.repeat(s.length);
  return '•'.repeat(s.length - 2) + s.slice(-2);
}

export function maskRows(
  columns: string[],
  rows: unknown[][],
  policy: MaskPolicy = DEFAULT_POLICY,
): { rows: unknown[][]; report: MaskReport } {
  const mode = policy.mode ?? 'named';
  if (mode === 'off') {
    return { rows, report: { columns: [], mode } };
  }

  const maskIdx: number[] = [];
  const maskedNames: string[] = [];
  columns.forEach((name, i) => {
    if (mode === 'all' || isPersonalColumn(name, policy)) {
      maskIdx.push(i);
      maskedNames.push(name);
    }
  });

  if (maskIdx.length === 0) {
    return { rows, report: { columns: [], mode } };
  }

  const out = rows.map((row) => {
    const copy = row.slice();
    for (const i of maskIdx) copy[i] = maskValue(copy[i]);
    return copy;
  });

  return { rows: out, report: { columns: maskedNames, mode } };
}
