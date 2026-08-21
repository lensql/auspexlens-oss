/**
 * Every hostname that can appear in anything a customer receives.
 *
 * This is an ALLOWLIST and never a denylist, and the reason is one-directional:
 * **a URL inside a published .vsix cannot be recalled.** Installations that
 * already have it keep calling it, forever, whatever we do afterwards. So the
 * question is not "is this host bad?" but "have we decided, deliberately, that
 * this host may be printed into software we cannot take back?".
 *
 * `scripts/ci/export-guards.sh` reads ALLOWED out of THIS FILE rather than
 * keeping its own copy. Two lists of what is permitted drift apart, and the one
 * that drifts is always the copy nobody is looking at.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set([
  // The product's own site: docs, pricing, the buy funnel, the EULA.
  'lensql.dev',
  // The licence service. Every install calls it; the URL is burned.
  'api.lensql.dev',
  // The public mirror, the issue tracker, the security advisory form.
  'github.com',
  // The store pages the README links to.
  'marketplace.visualstudio.com',
  // Open VSX, once base is published there (decision D8).
  'open-vsx.org',
  // Oracle's own documentation, linked from error messages such as ORA-01456.
  'docs.oracle.com',
  // The two licence texts NOTICES.md points at, for node-oracledb's dual
  // Apache-2.0 / UPL-1.0 licence. Added deliberately rather than by exception:
  // a third-party notices file that names licences without linking them is
  // worse, these two URLs are as canonical as URLs get, and the file ships
  // inside the .vsix precisely so it can be read without network access — the
  // links are a courtesy, not a dependency.
  'www.apache.org',
  'oss.oracle.com',
  // Loopback, for the MCP bridge between the extension host and the MCP child
  // process. Deliberately allowed rather than excepted: it is not an external
  // host at all, it never leaves the user's machine, and the alternative — a
  // hostname — would be worse. The bridge is bound to this address ON PURPOSE
  // (never 0.0.0.0), so seeing it here is the design working.
  '127.0.0.1',
]);

/** The roots that end up inside the .vsix. Pro's are absent because Pro is a
 *  separate package with a separate manifest. */
const SHIPPED_ROOTS = ['src', 'README.md', 'LICENSE.md', 'NOTICES.md'];

function filesUnder(root: string): string[] {
  const full = join(__dirname, '..', root);
  let st;
  try {
    st = statSync(full);
  } catch {
    return [];
  }
  if (st.isFile()) return [full];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|json|md)$/.test(entry.name)) out.push(p);
    }
  };
  walk(full);
  return out;
}

describe('hosts that ship to customers', () => {
  it('every root that ships actually exists', () => {
    // A root silently missing would make the sweep below pass by reading
    // nothing, which is the failure mode this repo keeps meeting.
    for (const root of SHIPPED_ROOTS) {
      expect(filesUnder(root).length, `${root} produced no files to sweep`).toBeGreaterThan(0);
    }
  });

  it('names no host outside the allowlist', () => {
    const strays: Record<string, string[]> = {};
    for (const root of SHIPPED_ROOTS) {
      for (const path of filesUnder(root)) {
        const text = readFileSync(path, 'utf8');
        for (const m of text.matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)) {
          const host = m[1]!;
          const ok = [...ALLOWED].some((a) => host === a || host.endsWith('.' + a));
          if (!ok) (strays[host] ??= []).push(path);
        }
      }
    }
    expect(strays, `hosts outside the allowlist: ${JSON.stringify(strays, null, 2)}`).toEqual({});
  });

  it('the allowlist is not empty', () => {
    // An empty allowlist would make the sweep above vacuously pass. The export
    // guard refuses to run against one for the same reason.
    expect(ALLOWED.size).toBeGreaterThan(0);
  });
});
