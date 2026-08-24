/**
 * Where the free/paid line is written.
 *
 * This file is PUBLIC on purpose. It is mirrored to lensql/auspexlens-oss under
 * MIT, and the README points readers straight at it, because "what do I get for
 * free" should be answerable by reading source rather than by trusting a
 * marketing page. The same decision is why RedLens's equivalent is public.
 *
 * Changing a line from FREE to PRO is therefore a visible, reviewable act.
 *
 * ---------------------------------------------------------------------------
 * THE PRINCIPLE (Diego, 2026-08-23 — PLAN.md §F, decision PD-3)
 *
 *   **Free is working with the database safely.
 *    Pro is performance, incidents and governance.**
 *
 * It exists because the previous split was a list without a sentence: fourteen
 * free capabilities and five paid ones, and nothing a buyer could read in one
 * line to know which side a new feature would land on. RedLens has had its own
 * version of this sentence since day one, and that is why nobody asks what its
 * Pro is for.
 *
 * So the daily loop — connect, browse, read, run, export, and every safety
 * control that makes those safe — is free and complete. What you pay for is the
 * work that starts when something is slow, something is stuck, or somebody has
 * to answer for who can see what.
 *
 * Two rules that follow from it and are enforced by tests, not by memory:
 *
 *  - **Every safety capability is Free.** Charging for not leaking PII, or for
 *    the guard that refuses a DROP, is a position nobody wants to defend to an
 *    enterprise buyer. See ALWAYS_FREE.
 *  - **Connections are never counted, capped or metered.** The one freemium
 *    competitor in this space caps them at three, and it is the loudest
 *    complaint in its reviews. We do not compete by taking something away.
 * ---------------------------------------------------------------------------
 */

export type Tier = 'free' | 'pro';

export interface Capability {
  id: string;
  tier: Tier;
  summary: string;
}

/**
 * What the product does TODAY.
 *
 * The rule this list lives by, learned the expensive way in 0.1.2: **a
 * capability is listed when it works, not when it is intended.** `connect.wallet`
 * shipped here in 0.1.0 while no command could reach it, which meant the README
 * promised something a user could not do. It was withdrawn the moment that was
 * discovered and came back in 0.2.0, in the same change that made it reachable.
 *
 * Anything decided but not built goes to PLANNED, below, and stays out of here.
 */
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
  { id: 'connect.container',  tier: 'free', summary: 'Says which container the connection is in, and warns in the CDB root' },
  { id: 'connect.cdbRoot',    tier: 'free', summary: 'Derives a CDB-root connection profile from the PDB one you are on' },
  { id: 'mcp.readOnly',       tier: 'free', summary: 'Read-only MCP server for language models' },

  // --- pro: performance, incidents and governance ---------------------------
  { id: 'explain.visual',     tier: 'pro',  summary: 'Visual explain plan with cost annotations, and plan diff' },
  { id: 'monitor.sessions',   tier: 'pro',  summary: 'Session, lock and blocking-tree monitor over the free v$ views' },
  { id: 'advisor.query',      tier: 'pro',  summary: 'Query advisors for the Oracle optimiser' },
  { id: 'advisor.table',      tier: 'pro',  summary: 'Table and index advisors' },
  { id: 'dashboard.activity', tier: 'pro',  summary: 'Activity dashboards over the free v$ views' },

  // --- pro: multitenant, the estate rather than one database ---------------
  { id: 'multitenant.explorer',    tier: 'pro', summary: 'PDB inventory from the CDB root: name, open mode, restricted, size and its limit' },
  { id: 'multitenant.monitor',     tier: 'pro', summary: 'Per-PDB metrics and Resource Manager limits, from views no pack licenses' },
  { id: 'multitenant.crossQuery',  tier: 'pro', summary: 'One catalog question asked of every open container at once' },
  { id: 'multitenant.scriptAdmin', tier: 'pro', summary: 'Generates PDB administration DDL for a DBA to run; never executes it' },

  // --- pro: incidents — reading the past ------------------------------------
  // A plain SELECT (`AS OF TIMESTAMP`), so it passes the read-only guard
  // unchanged and needs no grant — measured on the least-privileged account.
  // Paid because it is incident tooling, not because the SQL is restricted:
  // anyone may type AS OF into the free editor and this product will run it.
  { id: 'governance.posture', tier: 'pro', summary: 'Security posture report: VPD, redaction, encryption and audit policies, each with its licence footing' },
  { id: 'flashback.asOf', tier: 'pro', summary: 'Read a table as it was, and what changed since — with Oracle\'s undo errors explained' },
];

/**
 * Capabilities whose tier can never change, whatever a future price experiment
 * says.
 *
 * Two groups, and both come straight from the principle above: the safety
 * controls, because a product that charges for the guard is a product whose
 * guard is optional; and connecting, because metering connections is the one
 * thing the freemium competitor in this space does and the one thing its users
 * complain about.
 */
export const ALWAYS_FREE: readonly string[] = [
  'safety.readOnly',
  'safety.piiMask',
  'safety.privileges',
  'connect.basic',
  'connect.wallet',
  'connect.reconnect',
  'connect.container',
  'connect.cdbRoot',
];

/**
 * Capabilities that need MORE than the minimum privilege.
 *
 * Measured, not assumed (docs/RESEARCH.md §17.5): the v$ views are refused to a
 * CREATE SESSION + SELECT account, and SELECT_CATALOG_ROLE is what opens them.
 * Anything listed here must degrade with a message naming that grant, never with
 * an error — "works with the minimum privilege, and tells you exactly what to ask
 * your DBA for" is a selling point, and an unexplained failure is the opposite.
 */
export const NEEDS_CATALOG_ROLE: readonly string[] = [
  'monitor.sessions',
  'dashboard.activity',
  'explain.visual',
  'multitenant.explorer',
  'multitenant.monitor',
  'governance.posture',
  // `multitenant.crossQuery` is deliberately ABSENT: measured 2026-08-23, the
  // CONTAINERS() clause parses for an account with no grant at all, because it
  // is part of SQL rather than a catalog view. Listing it here would make the
  // product refuse a query that works.
  // `multitenant.scriptAdmin` is absent too — it generates text and reads nothing.
];

/**
 * Which side of the line a capability lands on, decided BEFORE it is built.
 *
 * Nothing here exists yet, and that is the point: these are commitments made
 * while the argument is about product shape rather than about a branch that is
 * already written. RedLens carries the same construct for its unbuilt MCP tools,
 * for the same reason — a tier decided after the code exists is a tier decided
 * by whoever wrote the code.
 *
 * `tierOf` deliberately reports these as out-of-scope, because they are: a user
 * cannot reach them, so the answer to "do I get this?" is neither yes nor pay.
 * When one ships it MOVES to CAPABILITIES, with the tier it was given here.
 *
 * Order of work (PLAN.md §F, decision PD-4): **governance first**. It builds on
 * the catalog views the explorer already reads, and it deepens the security
 * identity that separates this product from the official extension — rather than
 * adding a second thing that looks like the explain plan.
 *
 * Every one of these is built on views Oracle licenses for free. Decision D7 —
 * never read AWR or ASH, because they answer without error while requiring the
 * customer's own Diagnostics Pack — extends to the Tuning Pack for the same
 * reason: a paid feature of ours must never silently spend a licence of theirs.
 */
export interface PlannedCapability extends Capability {
  /** Which Pro pillar it belongs to, or 'free-depth' for the free half. */
  pillar: 'governance' | 'performance' | 'ai' | 'multitenant' | 'free-depth';
  /** What it is built on, so the licence question is answered up front. */
  builtOn: string;
}

export const PLANNED: readonly PlannedCapability[] = [
  // --- governance: who can see what, and proving it (PD-4, first) -----------
  { id: 'governance.privileges', tier: 'pro', pillar: 'governance',
    summary: 'Privilege explorer: who can do what, with the role graph',
    builtOn: 'ALL_/DBA_ catalog views' },
  { id: 'governance.overPrivilege', tier: 'pro', pillar: 'governance',
    summary: 'Schema-wide over-privilege report, beyond the per-connection warning',
    builtOn: 'ALL_/DBA_ catalog views' },
  { id: 'governance.piiDiscovery', tier: 'pro', pillar: 'governance',
    summary: 'Scan columns for personal data and propose the masking configuration',
    builtOn: 'catalog views + column sampling through the read-only path' },
  { id: 'governance.auditTrail', tier: 'pro', pillar: 'governance',
    summary: 'Unified Audit viewer',
    builtOn: 'UNIFIED_AUDIT_TRAIL' },

  // --- performance: when it is slow or stuck --------------------------------
  { id: 'performance.plsqlProfiler', tier: 'pro', pillar: 'performance',
    summary: 'Hierarchical PL/SQL profiler with a flame view',
    builtOn: 'DBMS_HPROF — a free feature of the database' },
  { id: 'performance.longOps', tier: 'pro', pillar: 'performance',
    summary: 'Live progress of long-running operations',
    builtOn: 'v$session_longops' },
  { id: 'performance.planRegression', tier: 'pro', pillar: 'performance',
    summary: 'Pin a plan baseline and diff it automatically when the plan changes',
    builtOn: 'EXPLAIN PLAN + v$sql_plan' },

  // --- AI: all of it is Pro (PD-5, ratifying the RedLens split) -------------
  // Recorded before a single line exists precisely so it cannot ship free by
  // accident. RedLens made the same call in 2026-07 and it has not been
  // revisited since.
  { id: 'ai.nlToSql', tier: 'pro', pillar: 'ai',
    summary: 'Natural language to SQL, grounded in the real catalog',
    builtOn: 'the catalog reader, through the read-only guard' },
  { id: 'ai.explainPlan', tier: 'pro', pillar: 'ai',
    summary: 'Read an execution plan back in prose, with what to try',
    builtOn: 'the existing explain path' },
  { id: 'ai.fixLastError', tier: 'pro', pillar: 'ai',
    summary: 'Explain the last Oracle error and propose the fix',
    builtOn: 'the error surface already shown in the editor' },
  { id: 'mcp.advisors', tier: 'pro', pillar: 'ai',
    summary: 'The advisor and health MCP tools, beyond the free read-only set',
    builtOn: 'the embedded MCP server and the same guard' },

  // --- free depth: where the daily loop is fought (PD-7) --------------------
  // Free on purpose and not as a concession: the grid and the history are what a
  // user compares against the official extension on day one.
  { id: 'editor.history', tier: 'free', pillar: 'free-depth',
    summary: 'Query history and saved queries',
    builtOn: 'local storage only' },
  { id: 'editor.gridChart', tier: 'free', pillar: 'free-depth',
    summary: 'Chart, transpose and group results in the grid',
    builtOn: 'the results already fetched' },
];

/**
 * What v1 does NOT do, stated rather than implied.
 *
 * `awr.*` is absent by decision D7 and not by omission: AWR and ASH views answer
 * without any error while requiring the customer's own Oracle Diagnostics Pack
 * licence. Reading them can put a user out of compliance silently, so the product
 * does not read them at all — not even behind a toggle.
 *
 * `schema.compare` and `data.compare` are the classic paid features of the
 * desktop Oracle IDEs, and they are the obvious Pro candidates — but they are a
 * quarter of work, so PLAN.md §F leaves them as decision **PD-6, open**. They
 * stay here, out of scope, until that is decided: an unbuilt capability with an
 * undecided tier belongs in neither of the two lists above.
 */
export const OUT_OF_SCOPE_V1: readonly string[] = [
  'plsql.debugger',
  'awr.snapshots',
  'ash.history',
  'auth.kerberos',
  'auth.ociIam',
  'driver.thick',
  'schema.compare',
  'data.compare',
];

export function tierOf(capabilityId: string): Tier | 'out-of-scope' {
  if (OUT_OF_SCOPE_V1.includes(capabilityId)) return 'out-of-scope';
  return CAPABILITIES.find((c) => c.id === capabilityId)?.tier ?? 'out-of-scope';
}

/**
 * The tier a planned capability WILL have, for the change that ships it.
 *
 * Separate from `tierOf` on purpose: that function answers "what does a user get
 * right now", and the honest answer for something unbuilt is out-of-scope. This
 * one answers "what did we decide", which is a question only the implementer
 * asks.
 */
export function plannedTierOf(capabilityId: string): Tier | undefined {
  return PLANNED.find((c) => c.id === capabilityId)?.tier;
}
