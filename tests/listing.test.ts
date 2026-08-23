/**
 * The Marketplace listing metadata, checked against the company baseline.
 *
 * This exists because the listing is the only part of the product that most
 * people ever see, and it is the part with no compiler. AuspexLens shipped 1.0.0
 * with `displayName: "AuspexLens"` — a name that says nothing a person would
 * type — and the measurement (PLAN.md §F.4, 2026-08-23) was blunt: outside the
 * top 50 for "oracle", and 8th for "oracle client" only because the *description*
 * happened to contain that exact phrase. The text ranks; the bare name does not.
 *
 * So the pattern in `lensql-hq/docs/PRODUCT-BASELINE.md` §0.2b is asserted here
 * rather than remembered:
 *
 *     Free: <Brand> — <category> & MCP for <Engine>
 *     Pro:  <Brand> Pro — <pillar>, <pillar> & <pillar> for <Engine>
 *
 * The cost of getting it wrong is not a bad test run. Listing metadata travels
 * inside the .vsix, so fixing it burns a version number — which is exactly the
 * kind of mistake a test is cheap enough to prevent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read rather than import: this repo has no `resolveJsonModule`, and
// packaging.test.ts already reads its manifest from disk for the same reason.
const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as {
  displayName: string;
  description: string;
  keywords: string[];
  categories: string[];
  pricing: string;
};

const VALID_CATEGORIES = [
  'Programming Languages', 'Snippets', 'Linters', 'Themes', 'Debuggers',
  'Formatters', 'Keymaps', 'SCM Providers', 'Other', 'Extension Packs',
  'Language Packs', 'Data Science', 'Machine Learning', 'Visualization',
  'Notebooks', 'Education', 'Testing',
];

describe('the Marketplace listing follows the company baseline', () => {
  it('names the category and the engine in the displayName, not just the brand', () => {
    expect(manifest.displayName).toBe('AuspexLens — SQL IDE & MCP for Oracle Database');
  });

  it('keeps the engine descriptive, never inside the brand', () => {
    // Oracle's third-party trademark guidelines: "X for Oracle Database" is
    // permitted; a name containing "Oracle", or any "Ora-" prefix, is not. The
    // brand is the text before the em dash.
    const brand = (manifest.displayName.split('—')[0] ?? '').trim();
    expect(brand).toBe('AuspexLens');
    expect(brand.toLowerCase()).not.toContain('oracle');
    expect(brand.toLowerCase()).not.toMatch(/^ora/);
    expect(manifest.displayName).toContain('for Oracle Database');
  });

  it('opens the description with the phrase people actually type', () => {
    // Measured, not guessed: this is the phrasing that put the extension 8th for
    // "oracle client" while it was invisible everywhere else.
    expect(manifest.description.startsWith('Oracle Database client for VS Code')).toBe(true);
  });

  it('keeps the description short enough to survive the search listing', () => {
    // The Marketplace truncates in search results. RedLens's two listings sit at
    // 143 and 172 characters and read complete; 200+ does not.
    expect(manifest.description.length).toBeLessThanOrEqual(180);
  });

  it('carries around ten strong keywords, including multi-word phrases', () => {
    // Hard limit is 30. Microsoft switched on a limit of 10, reverted it after it
    // broke publishing, and said it would return (vscode-discussions#426) — so 10
    // is the number to live under, not 30.
    expect(manifest.keywords.length).toBeLessThanOrEqual(10);
    expect(manifest.keywords.some((k) => k.includes(' ')), 'no multi-word phrase').toBe(true);
    for (const required of ['oracle', 'oracle database', 'oracle client', 'plsql']) {
      expect(manifest.keywords, required).toContain(required);
    }
  });

  it('has no duplicate or empty keywords', () => {
    expect(new Set(manifest.keywords).size).toBe(manifest.keywords.length);
    for (const k of manifest.keywords) expect(k.trim()).not.toBe('');
  });

  it('declares only real categories, and never "Other"', () => {
    // "Other" is a category that describes nothing and filters for nobody.
    for (const c of manifest.categories) expect(VALID_CATEGORIES, c).toContain(c);
    expect(manifest.categories).not.toContain('Other');
  });

  it('declares its price, because the free half is free', () => {
    expect(manifest.pricing).toBe('Free');
  });
});
