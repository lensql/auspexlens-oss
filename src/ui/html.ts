/**
 * Building HTML for webviews without handing the database a script tag.
 *
 * The threat is T6, and it is not hypothetical: a table name, a column name, a
 * cell value and an error message all come from outside the trust boundary. A
 * schema whose table is called `<img src=x onerror=...>` is legal Oracle and
 * arrives here as data.
 *
 * Two controls, and neither is sufficient alone:
 *
 *   escapeHtml   every value that came from the database, without exception.
 *   CSP          so that if one escape is ever missed, the injected script has
 *                no way to execute or to phone home.
 */

/**
 * Escape text for insertion into HTML.
 *
 * All five characters, including the quotes: a value that lands inside an
 * attribute (`title="..."`) escapes the attribute with a bare quote, and that is
 * the case people forget because the obvious test only checks `<`.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A fresh nonce per webview render. Never reused, never derived from content. */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  // globalThis.crypto exists in the extension host (Node 20+).
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface CspOptions {
  /** The webview's cspSource, from `webview.cspSource`. */
  cspSource: string;
  /** Omit for a read-only view: without a nonce, no script can run at all. */
  nonce?: string;
}

/**
 * The Content-Security-Policy for a webview.
 *
 * `default-src 'none'` first, then only what is genuinely needed. There is no
 * `connect-src`: a webview in this extension never talks to the network, and
 * leaving it out means an injected script cannot exfiltrate the rows it can see.
 */
export function contentSecurityPolicy(options: CspOptions): string {
  const parts = [
    "default-src 'none'",
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `img-src ${options.cspSource} data:`,
    `font-src ${options.cspSource}`,
  ];
  // A view with no scripts gets no script-src at all, which is stricter than any
  // nonce: there is nothing to guess.
  if (options.nonce) {
    parts.push(`script-src 'nonce-${options.nonce}'`);
  }
  return parts.join('; ') + ';';
}

/** The `<meta>` tag form, ready to drop into a webview's `<head>`. */
export function cspMetaTag(options: CspOptions): string {
  return `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(options)}">`;
}
