// The screenshot harness runs OUTSIDE the bundle: @vscode/test-electron spawns
// VS Code, so this compiles to plain CommonJS files rather than one bundle.
// Mirrors packages/pro/esbuild.integration.mjs, which the bridge smoke uses.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['integration/runShots.ts', 'integration/shots.ts'],
  bundle: true,
  outdir: 'out-integration',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode', '@vscode/test-electron', 'electron'],
  logLevel: 'info',
});
