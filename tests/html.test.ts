import { describe, it, expect } from 'vitest';
import { escapeHtml, contentSecurityPolicy, cspMetaTag, makeNonce } from '../src/ui/html';

describe('escapeHtml — the database is hostile input', () => {
  it('escapes a table name carrying a script tag', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>'))
      .toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes BOTH quote characters, not just angle brackets', () => {
    // The forgotten case: a value landing inside title="..." escapes the
    // attribute with a bare quote, and the obvious test only checks `<`.
    expect(escapeHtml('a"b')).toBe('a&quot;b');
    expect(escapeHtml("a'b")).toBe('a&#39;b');
  });

  it('escapes ampersands first, so nothing is double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('renders null and undefined as empty, not as the word', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('content security policy', () => {
  it('starts from default-src none', () => {
    expect(contentSecurityPolicy({ cspSource: 'vscode-resource:' })).toMatch(/^default-src 'none'/);
  });

  it('omits script-src entirely for a read-only view', () => {
    // Stricter than any nonce: there is nothing to guess.
    expect(contentSecurityPolicy({ cspSource: 'x' })).not.toMatch(/script-src/);
  });

  it('permits scripts only by nonce when one is given', () => {
    const csp = contentSecurityPolicy({ cspSource: 'x', nonce: 'abc123' });
    expect(csp).toMatch(/script-src 'nonce-abc123'/);
    expect(csp).not.toMatch(/unsafe-eval/);
  });

  it('never allows the webview to reach the network', () => {
    // No connect-src means an injected script cannot exfiltrate the rows it can
    // see, even if an escape were ever missed.
    const csp = contentSecurityPolicy({ cspSource: 'x', nonce: 'n' });
    expect(csp).not.toMatch(/connect-src/);
    expect(csp).toMatch(/default-src 'none'/);
  });

  it('produces a meta tag ready for the head', () => {
    expect(cspMetaTag({ cspSource: 'x' })).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
  });
});

describe('nonces', () => {
  it('are long and never repeat', () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});
