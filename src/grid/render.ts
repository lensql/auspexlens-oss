/**
 * The results grid, as HTML.
 *
 * Pure function of a result set, so it is testable without a webview: give it
 * columns and rows, get a document. That is what lets the escaping be tested at
 * all — a renderer that needs a running editor is a renderer nobody tests.
 *
 * Everything from the database goes through `escapeHtml`, without exception. A
 * table name, a column name and a cell value all come from outside the trust
 * boundary: a schema whose column is called `<img src=x onerror=…>` is legal
 * Oracle and arrives here as data.
 */

import { escapeHtml, cspMetaTag } from '../ui/html';

export interface GridInput {
  columns: string[];
  rows: unknown[][];
  /** Columns the engine masked, so the grid can say so rather than leaving the
   *  user to wonder why an email column is full of bullets. */
  maskedColumns: string[];
  elapsedMs?: number;
  note?: string;
  cspSource: string;
}

/**
 * Turn a result on its side: one row per column, one column per record.
 *
 * The view you want when a query returns three rows of forty columns, which is
 * every `SELECT *` on a real table. It is a pure transform of what was already
 * fetched — no second query, and nothing new reaches the database.
 *
 * **Rendered on this side rather than in the webview, deliberately.** RedLens's
 * grid runs with `enableScripts: true`; this one does not, and that is a control
 * the threat model names: T15 pairs `escapeHtml` on every value with a CSP that
 * omits `script-src` entirely for read-only views. Copying RedLens's interactive
 * grid would mean giving that up in the product whose whole pitch is that you can
 * point a language model at it. Transposing before the HTML is written costs a
 * re-render and keeps the guarantee whole.
 *
 * Capped because a transposed result has one column per ROW: a thousand-row
 * answer would become a thousand-column table, which no window can show and no
 * person can read.
 */
export const TRANSPOSE_LIMIT = 50;

export function transpose(
  columns: readonly string[],
  rows: readonly unknown[][],
  limit = TRANSPOSE_LIMIT,
): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  const kept = rows.slice(0, limit);
  return {
    // The first column holds what used to be the header, so the names stay
    // readable down the left edge where a person scans them.
    columns: ['Column', ...kept.map((_, i) => `Row ${i + 1}`)],
    rows: columns.map((name, c) => [name, ...kept.map((r) => r[c])]),
    truncated: rows.length > kept.length,
  };
}

export function renderGrid(input: GridInput & { chartSvg?: string }): string {
  const { columns, rows, maskedColumns, cspSource } = input;

  const head = columns
    .map((c) => {
      const masked = maskedColumns.includes(c);
      return `<th${masked ? ' class="masked" title="Masked by AuspexLens before leaving the engine"' : ''}>${escapeHtml(c)}${masked ? ' <span aria-label="masked">●</span>' : ''}</th>`;
    })
    .join('');

  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell) => `<td${cell === null || cell === undefined ? ' class="null"' : ''}>${cell === null || cell === undefined ? 'NULL' : escapeHtml(cell)}</td>`)
          .join('')}</tr>`,
    )
    .join('');

  const summary = [
    `${rows.length} row${rows.length === 1 ? '' : 's'}`,
    input.elapsedMs !== undefined ? `${input.elapsedMs} ms` : undefined,
    maskedColumns.length
      ? `${maskedColumns.length} column${maskedColumns.length === 1 ? '' : 's'} masked`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  // No script-src at all: this view has no scripts, which is stricter than any
  // nonce because there is nothing to guess. And no connect-src, so even if an
  // escape were ever missed the injected markup has nowhere to send anything.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${cspMetaTag({ cspSource })}
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); padding: 0; margin: 0; }
  .summary { padding: 6px 10px; color: var(--vscode-descriptionForeground);
             border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0;
             background: var(--vscode-editor-background); }
  .chart { display: block; margin: 10px; max-width: calc(100% - 20px); }
  .chart .bar { fill: var(--vscode-charts-blue, #4a9eff); }
  .chart .lbl { fill: var(--vscode-foreground); font-size: 12px; }
  .chart .val { fill: var(--vscode-descriptionForeground); font-size: 12px; }
  .note { padding: 6px 10px; color: var(--vscode-inputValidation-warningForeground);
          background: var(--vscode-inputValidation-warningBackground); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 3px 10px; border-bottom: 1px solid var(--vscode-panel-border);
           white-space: pre; font-variant-numeric: tabular-nums; }
  th { position: sticky; top: 29px; background: var(--vscode-editor-background); font-weight: 600; }
  th.masked { color: var(--vscode-descriptionForeground); }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<div class="summary">${escapeHtml(summary)}</div>
${input.note ? `<div class="note">${escapeHtml(input.note)}</div>` : ''}
${input.chartSvg ?? ''}
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body>
</html>`;
}

/**
 * Count the rows behind each distinct value of one column.
 *
 * The cheapest useful question about a result — "how many of each?" — and one a
 * person otherwise re-runs the query to answer. Like `transpose`, it works on
 * rows already fetched: no second statement, and nothing new reaches the
 * database.
 *
 * Sorted by count and then by label, so the answer is stable between runs. Ties
 * broken alphabetically rather than left in whatever order the rows arrived,
 * because a list that reshuffles under you is one you have to read twice.
 */
export function groupBy(
  columns: readonly string[],
  rows: readonly unknown[][],
  columnIndex: number,
): { columns: string[]; rows: unknown[][] } {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = row[columnIndex];
    // NULL is a value people group by, and it is not the empty string.
    const key = raw === null || raw === undefined ? 'NULL' : String(raw);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const name = columns[columnIndex] ?? 'Value';
  return {
    columns: [name, 'Rows'],
    rows: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => [k, n]),
  };
}

/** One bar of a chart: a label and the number behind it. */
export interface Bar { label: string; value: number }

/**
 * A bar chart as static SVG, drawn here rather than in the webview.
 *
 * This is the case that decides whether the no-scripts results view survives.
 * RedLens charts with `enableScripts: true`; this view has **no `script-src` at
 * all**, which the threat model names as a control (T15), and a chart is the
 * feature most likely to be used as the reason to give that up. It does not have
 * to be: a bar chart is rectangles and text, and SVG draws both without running
 * anything.
 *
 * Everything user-derived — labels, and the numbers in the axis — goes through
 * `escapeHtml`, exactly as the table does. An SVG in an HTML document is parsed
 * as markup, so a label containing `<` is the same hazard here as in a `<td>`.
 */
export function barChartSvg(bars: readonly Bar[], opts: { width?: number } = {}): string {
  const width = opts.width ?? 720;
  const rowHeight = 26;
  const labelWidth = 180;
  const gutter = 12;
  const max = bars.reduce((m, b) => Math.max(m, b.value), 0);
  const height = Math.max(rowHeight, bars.length * rowHeight) + gutter;
  const barArea = Math.max(40, width - labelWidth - 90);

  const rows = bars.map((b, i) => {
    const y = i * rowHeight + gutter / 2;
    // A zero-length bar is still a row: dividing by a max of zero is not, so the
    // guard is on the divisor rather than on the value.
    const w = max > 0 ? Math.round((b.value / max) * barArea) : 0;
    const label = escapeHtml(b.label.length > 28 ? `${b.label.slice(0, 27)}…` : b.label);
    return (
      `<text x="0" y="${y + 16}" class="lbl">${label}</text>` +
      `<rect x="${labelWidth}" y="${y + 5}" width="${w}" height="14" rx="2" class="bar"/>` +
      `<text x="${labelWidth + w + 6}" y="${y + 16}" class="val">${escapeHtml(b.value)}</text>`
    );
  }).join('');

  return (
    `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" ` +
    `role="img" aria-label="Bar chart of ${escapeHtml(bars.length)} values">${rows}</svg>`
  );
}
