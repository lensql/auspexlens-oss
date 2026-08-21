import { describe, it, expect } from 'vitest';
import { renderGrid } from '../src/grid/render';

const base = { maskedColumns: [], cspSource: 'vscode-resource:' };

describe('the grid escapes everything from the database', () => {
  it('escapes a hostile column name', () => {
    const html = renderGrid({ ...base, columns: ['<script>alert(1)</script>'], rows: [] });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes a hostile cell value', () => {
    const html = renderGrid({
      ...base, columns: ['C'], rows: [['<img src=x onerror=alert(1)>']],
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('escapes a quote that would break out of an attribute', () => {
    const html = renderGrid({
      ...base, columns: ['a"b'], rows: [], maskedColumns: ['a"b'],
    });
    expect(html).toContain('&quot;');
  });
});

describe('what the grid tells the user', () => {
  it('carries a CSP with default-src none and no script-src', () => {
    const html = renderGrid({ ...base, columns: ['C'], rows: [] });
    expect(html).toMatch(/default-src 'none'/);
    expect(html).not.toMatch(/script-src/);
    expect(html).not.toMatch(/connect-src/);
  });

  it('says how many columns were masked, rather than leaving bullets unexplained', () => {
    const html = renderGrid({
      columns: ['ID', 'EMAIL'], rows: [[1, '•••••']], maskedColumns: ['EMAIL'],
      cspSource: 'x',
    });
    expect(html).toContain('1 column masked');
  });

  it('renders NULL distinctly from an empty string', () => {
    const html = renderGrid({ ...base, columns: ['C'], rows: [[null], ['']] });
    expect(html).toContain('class="null"');
    expect(html).toContain('NULL');
  });

  it('counts rows in the singular when there is one', () => {
    // Anchored to the element, not to a trailing space: the summary joins its
    // parts with a separator, so with no timing and no masking there is nothing
    // after "1 row" and the looser assertion was checking whitespace rather than
    // the plural rule it is named for.
    expect(renderGrid({ ...base, columns: ['C'], rows: [[1]] })).toContain('>1 row<');
    expect(renderGrid({ ...base, columns: ['C'], rows: [[1], [2]] })).toContain('>2 rows<');
  });

  it('shows a truncation note when given one', () => {
    const html = renderGrid({ ...base, columns: ['C'], rows: [], note: 'Truncated at 5000 rows.' });
    expect(html).toContain('Truncated at 5000 rows.');
  });
});
