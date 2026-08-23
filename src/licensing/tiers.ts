/**
 * Where the free/paid line is written.
 *
 * This file is PUBLIC on purpose. It is mirrored to lensql/auspexlens-oss under
 * MIT, and the README points readers straight at it, because "what do I get for
 * free" should be answerable by reading source rather than by trusting a
 * marketing page. The same decision is why RedLens's equivalent is public.
 *
 * Changing a line from FREE to PRO is therefore a visible, reviewable act.
 */

export type Tier = 'free' | 'pro';

export interface Capability {
  id: string;
  tier: Tier;
  summary: string;
}

export const CAPABILITIES: readonly Capability[] = [
  // --- free: everything needed to actually work with an Oracle database -----
  { id: 'connect.basic',      tier: 'free', summary: 'Connect with user/password over verified TLS' },
  { id: 'connect.wallet',     tier: 'free', summary: 'Import an Oracle wallet (.zip or folder) and connect with mTLS' },
  { id: 'connect.reconnect',  tier: 'free', summary: 'Reopen the connection when the server drops the session' },
  { id: 'explorer.objects',   tier: 'free', summary: 'Browse tables, views, sequences, packages, procedures, functions and triggers' },
  { id: 'explorer.source',    tier: 'free', summary: 'Read the source of PL/SQL objects' },
  { id: 'explorer.find',      tier: 'free', summary: 'Fuzzy "find database object" across large schemas' },
  { id: 'editor.execute',     tier: 'free', summary: 'Run SQL and read the results grid' },
  { id: 'editor.export',      tier: 'free', summary: 'Export results as CSV or JSON' },
  { id: 'plsql.run',          tier: 'free', summary: 'Run PL/SQL blocks and read compile errors from ALL_ERRORS' },
  { id: 'explain.basic',      tier: 'free', summary: 'Text explain plan (EXPLAIN PLAN + DBMS_XPLAN.DISPLAY)' },
  { id: 'safety.readOnly',    tier: 'free', summary: 'Read-only enforcement: our own SQL guard plus SET TRANSACTION READ ONLY' },
  { id: 'safety.piiMask',     tier: 'free', summary: 'PII masking in the engine, before grid, export or MCP' },
  { id: 'safety.privileges',  tier: 'free', summary: 'Detects an over-privileged connection and says so' },
  { id: 'mcp.readOnly',       tier: 'free', summary: 'Read-only MCP server for language models' },

  // --- pro -----------------------------------------------------------------
  { id: 'explain.visual',     tier: 'pro',  summary: 'Visual explain plan with cost annotations, and plan diff' },
  { id: 'monitor.sessions',   tier: 'pro',  summary: 'Session, lock and blocking-tree monitor over the free v$ views' },
  { id: 'advisor.query',      tier: 'pro',  summary: 'Query advisors for the Oracle optimiser' },
  { id: 'advisor.table',      tier: 'pro',  summary: 'Table and index advisors' },
  { id: 'dashboard.activity', tier: 'pro',  summary: 'Activity dashboards over the free v$ views' },
];

/**
 * Capabilities that need MORE than the minimum privilege.
 *
 * Measured, not assumed (docs/RESEARCH.md §17.5): the v$ views are refused to a
 * CREATE SESSION + SELECT account, and SELECT_CATALOG_ROLE is what opens them.
 * Anything listed here must degrade with a message naming that grant, never with
 * an error.
 */
export const NEEDS_CATALOG_ROLE: readonly string[] = [
  'monitor.sessions',
  'dashboard.activity',
  'explain.visual',
];

/**
 * What v1 does NOT do, stated rather than implied.
 *
 * `awr.*` is absent by decision D7 and not by omission: AWR and ASH views answer
 * without any error while requiring the customer's own Oracle Diagnostics Pack
 * licence. Reading them can put a user out of compliance silently, so the product
 * does not read them at all — not even behind a toggle, in v1.
 *
 * `connect.wallet` spent 0.1.2 in this list and came back out in 0.2.0, which is
 * the shape this file is supposed to have: it was withdrawn the moment we learned
 * no user could reach it, and restored in the same change that shipped
 * `AuspexLens: Import wallet`. A capability is listed when it works, not when it
 * is intended.
 */
export const OUT_OF_SCOPE_V1: readonly string[] = [
  'plsql.debugger',
  'awr.snapshots',
  'ash.history',
  'auth.kerberos',
  'auth.ociIam',
  'driver.thick',
  'schema.compare',
];

export function tierOf(capabilityId: string): Tier | 'out-of-scope' {
  if (OUT_OF_SCOPE_V1.includes(capabilityId)) return 'out-of-scope';
  return CAPABILITIES.find((c) => c.id === capabilityId)?.tier ?? 'out-of-scope';
}
