// The bundle.
//
// `--production` is not a nice-to-have. RedLens gated BOTH minification and
// source maps on a flag that nothing passed, and every published Pro up to 1.0.8
// shipped 49,747 readable lines: the map was correctly absent, so every check
// passed while the thing the map would have exposed was in the bundle itself.
// scripts/package-extension.sh always passes it, and scripts/ci/audit-vsix.sh
// checks the built artifact rather than trusting this file.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

// Two bundles, and they are deliberately separate processes.
//
// The MCP server is launched as a child by whatever agent the user points at it.
// It must NOT carry the extension host's code, and it must not be able to open a
// database connection of its own: it talks back over the authenticated loopback
// bundle to the extension, which owns the connection and the guard.
const targets = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    // Provided by the extension host, never bundled.
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: ['src/mcp/server.ts'],
    outfile: 'dist/mcp-server.js',
    // No 'vscode': this process runs outside the extension host and importing it
    // would be a bug that only shows up at run time.
    external: [],
  },
];

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context(t);
    await ctx.watch();
  }
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
}
