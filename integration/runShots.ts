import * as fs from 'fs';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * The screenshot suite, with AuspexLens Pro loaded alongside the free extension
 * when it is built.
 *
 * `extensionDevelopmentPath` takes an array — the same mechanism the bridge
 * smoke uses to load the pair. Pro stays optional on purpose: a mirror checkout
 * has no packages/pro at all, and the harness must degrade to the free captures
 * and SAY which ones it skipped, not fail. RedLens's manual carried stale paid
 * screenshots for a while because its early harness could only ever load base,
 * and nothing reported which images were rotting.
 */
async function main(): Promise<void> {
  const basePath = path.resolve(__dirname, '..');
  const proPath = path.resolve(basePath, '../pro');
  const withPro = fs.existsSync(path.join(proPath, 'dist', 'extension.js'));
  if (!withPro) {
    console.error('shots: AuspexLens Pro is not built — the paid captures will be skipped.');
  }

  await runTests({
    extensionDevelopmentPath: withPro ? [basePath, proPath] : basePath,
    extensionTestsPath: path.resolve(__dirname, 'shots.js'),
    launchArgs: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-workspace-trust', '--disable-extensions'],
  });
}

main().catch((err) => {
  console.error('Screenshot run failed:', err);
  process.exit(1);
});
