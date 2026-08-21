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

export function renderGrid(input: GridInput): string {
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
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body>
</html>`;
}
