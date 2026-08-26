import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderGrid, transpose, TRANSPOSE_LIMIT, groupBy, barChartSvg } from '../src/grid/render';

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

describe('transposing a wide result', () => {
  const columns = ['ID', 'NAME', 'EMAIL'];
  const rows = [[1, 'Ada', 'ada@x.invalid'], [2, 'Grace', 'grace@x.invalid']];

  it('puts the column names down the left edge', () => {
    // Where a person scans them, when a SELECT * returns forty columns.
    const t = transpose(columns, rows);
    expect(t.columns).toEqual(['Column', 'Row 1', 'Row 2']);
    expect(t.rows.map((r) => r[0])).toEqual(['ID', 'NAME', 'EMAIL']);
  });

  it('keeps each record in its own column, in order', () => {
    const t = transpose(columns, rows);
    expect(t.rows[1]).toEqual(['NAME', 'Ada', 'Grace']);
  });

  it('caps the columns, because a transposed row becomes a column', () => {
    // A thousand-row answer would otherwise become a thousand-column table.
    const many = Array.from({ length: 80 }, (_, i) => [i, `n${i}`, `e${i}`]);
    const t = transpose(columns, many);
    expect(t.columns.length).toBe(TRANSPOSE_LIMIT + 1);
    expect(t.truncated).toBe(true);
  });

  it('says nothing was truncated when nothing was', () => {
    expect(transpose(columns, rows).truncated).toBe(false);
  });

  it('preserves null and undefined rather than turning them into text', () => {
    // The renderer is what decides how a NULL looks; a transform that decided
    // for it would make two places responsible for one appearance.
    const t = transpose(['A'], [[null], [undefined]]);
    expect(t.rows[0]).toEqual(['A', null, undefined]);
  });

  it('handles an empty result without inventing a shape', () => {
    expect(transpose(columns, [])).toEqual({
      columns: ['Column'], rows: [['ID'], ['NAME'], ['EMAIL']], truncated: false,
    });
  });

  it('runs entirely on rows already fetched', () => {
    // No second query: the point of doing this on our side is that nothing new
    // reaches the database, and the no-scripts webview keeps its CSP.
    const src = readFileSync(join(__dirname, '..', 'src', 'grid', 'render.ts'), 'utf8');
    expect(src).not.toMatch(/executeReadOnly|conn\./);
  });
});

describe('grouping, on rows already fetched', () => {
  const columns = ['STATUS', 'AMOUNT'];
  const rows = [['OPEN', 1], ['SHUT', 2], ['OPEN', 3], [null, 4], ['OPEN', 5]];

  it('counts the rows behind each distinct value', () => {
    const g = groupBy(columns, rows, 0);
    expect(g.columns).toEqual(['STATUS', 'Rows']);
    expect(g.rows).toEqual([['OPEN', 3], ['NULL', 1], ['SHUT', 1]]);
  });

  it('treats NULL as a value people group by, not as an empty string', () => {
    expect(groupBy(['A'], [[null], ['']], 0).rows).toEqual([['', 1], ['NULL', 1]]);
  });

  it('breaks ties alphabetically so the answer is stable between runs', () => {
    // A list that reshuffles under you is one you have to read twice.
    const g = groupBy(['A'], [['b'], ['a'], ['c']], 0);
    expect(g.rows.map((r) => r[0])).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty result without inventing a row', () => {
    expect(groupBy(columns, [], 0).rows).toEqual([]);
  });
});

describe('the bar chart is SVG, not a script', () => {
  const bars = [{ label: 'OPEN', value: 3 }, { label: 'SHUT', value: 1 }];

  it('draws rectangles and text, and runs nothing', () => {
    // The feature most likely to be used as the reason to enable scripts in the
    // results view. It does not have to be: a bar chart is rectangles and text.
    const svg = barChartSvg(bars);
    expect(svg).toContain('<rect');
    expect(svg).toContain('<text');
    expect(svg.toLowerCase()).not.toContain('<script');
    expect(svg.toLowerCase()).not.toContain('onload');
  });

  it('escapes labels, because SVG in an HTML document is markup too', () => {
    const svg = barChartSvg([{ label: '<img src=x onerror=1>', value: 1 }]);
    expect(svg).not.toContain('<img');
    expect(svg).toContain('&lt;img');
  });

  it('scales the longest bar to the full width and the rest against it', () => {
    const svg = barChartSvg([{ label: 'a', value: 10 }, { label: 'b', value: 5 }]);
    const widths = [...svg.matchAll(/<rect[^>]*width="(\d+)"/g)].map((m) => Number(m[1]));
    expect(widths[0]).toBeGreaterThan(0);
    expect(widths[1]).toBe(Math.round(widths[0]! / 2));
  });

  it('survives every value being zero rather than dividing by it', () => {
    const svg = barChartSvg([{ label: 'a', value: 0 }, { label: 'b', value: 0 }]);
    expect(svg).toContain('<rect');
    expect(svg).not.toContain('NaN');
  });

  it('truncates a long label instead of overrunning the labels column', () => {
    const svg = barChartSvg([{ label: 'x'.repeat(60), value: 1 }]);
    expect(svg).toContain('…');
  });

  it('carries an accessible name', () => {
    expect(barChartSvg(bars)).toContain('role="img"');
    expect(barChartSvg(bars)).toContain('aria-label');
  });
});
