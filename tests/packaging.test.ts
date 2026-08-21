/**
 * The packaging allowlist, verified rather than trusted.
 *
 * Threat T7 in the other direction: whoever installs the .vsix can read every
 * byte of it. A denylist forgets; this test is what stops `.vscodeignore` from
 * quietly becoming one again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IGNORE = readFileSync(join(__dirname, '..', '.vscodeignore'), 'utf8');
const lines = IGNORE.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

describe('.vscodeignore is an allowlist', () => {
  it('excludes everything first', () => {
    // Without a leading `**`, every `!` line below is decoration and the package
    // ships whatever happens to be in the folder.
    expect(lines[0]).toBe('**');
  });

  it('re-includes only named files, never a folder wildcard', () => {
    for (const line of lines.filter((l) => l.startsWith('!'))) {
      // In vsce a `!` rule beats every exclusion regardless of order, so
      // `!dist/**` would re-include source maps permanently and nothing later
      // could take them back out.
      expect(line, `${line} uses a wildcard that cannot be taken back`).not.toMatch(/\*\*/);
    }
  });

  it('ships the files the Marketplace and the runtime require', () => {
    for (const required of ['!package.json', '!README.md', '!LICENSE.md', '!CHANGELOG.md',
                            '!NOTICES.md', '!dist/extension.js']) {
      expect(lines, `${required} is missing from .vscodeignore`).toContain(required);
    }
  });

  it('never re-includes a source map', () => {
    expect(IGNORE).not.toMatch(/!.*\.map/);
  });
});
