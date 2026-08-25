/**
 * Is the other half of the product here?
 *
 * This suite runs in two places that are not the same tree. In the private
 * monorepo `packages/pro` sits beside this package, and a handful of tests can
 * and should reach into it — the free/paid boundary is a property of the PAIR,
 * and only a test that can see both can assert it. In the **public mirror** the
 * paid half does not exist and must never exist: `export-public.sh` copies
 * `packages/base` and nothing else, and `export-guards.sh` aborts if a `pro/`
 * path appears.
 *
 * So a test that reads Pro's manifest is correct in one tree and a crash in the
 * other. It crashed for three releases — 1.5.0, 1.6.0 and 1.7.0 all shipped with
 * the mirror's CI red — because the local gate passes: here, Pro is always there.
 * The mirror's CI is the only thing that runs this suite without it, which is the
 * entire reason that CI exists.
 *
 * The answer is not to delete the assertion. It is to ask first, and skip loudly
 * when the answer is no — the same shape RedLens uses, and for the same reason.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `packages/pro`, whether or not it is there. */
export const PRO_ROOT = join(__dirname, '..', '..', 'pro');

/**
 * True in the private monorepo, false in the public mirror.
 *
 * Checked by looking for Pro's manifest rather than by an environment variable:
 * a variable has to be set correctly in two CIs and a laptop, and the file
 * either exists or it does not.
 */
export function hasPro(): boolean {
  return existsSync(join(PRO_ROOT, 'package.json'));
}

/** Pro's manifest. Only call it behind `hasPro()`. */
export function proManifest(): {
  version: string;
  contributes: { commands: { command: string; title: string; category?: string }[] };
} {
  return JSON.parse(readFileSync(join(PRO_ROOT, 'package.json'), 'utf8'));
}
