# AuspexLens — a native, lightweight Oracle Database client for VS Code

Connects in **thin mode**: pure JavaScript, no JVM, no Oracle Instant Client to
install. Read-only by design, with PII masking in the engine and an MCP server
you can point a language model at without handing it your production database.

> *Auspex*: the Roman augur who read the signs before anyone acted on them.

**This is the free half, and it is MIT.** Source:
https://github.com/lensql/auspexlens-oss

## What is free

Everything you need to actually work with an Oracle database:

- **Connections** — user/password over verified TLS, and Autonomous Database with
  a wallet (mTLS). Automatic reconnection after an idle drop.
- **Explorer** — tables, views, sequences, packages, procedures, functions and
  triggers, with their source. Plus fuzzy **Find Database Object** across large
  schemas.
- **SQL editor**, results grid, and CSV/JSON export.
- **PL/SQL**: run blocks, and read compile errors straight from `ALL_ERRORS`.
- **Explain plan** (text).
- **Safety**: read-only enforcement, PII masking, and a warning when your
  connection has more privilege than the work needs.
- **A read-only MCP server** for language models.

The free/paid line is written in one public file —
[`src/licensing/tiers.ts`](https://github.com/lensql/auspexlens-oss/blob/main/src/licensing/tiers.ts)
— so you can read it rather than take our word for it.

**AuspexLens Pro** (`lensql.auspexlens-pro`) adds visual explain plans with plan
diff, a session/lock/blocking-tree monitor, query and table advisors, and
activity dashboards. Details: https://lensql.dev/auspexlens/pricing

## Read-only actually means read-only

Oracle's own `SET TRANSACTION READ ONLY` blocks `INSERT`, `UPDATE`, `DELETE` and
`SELECT … FOR UPDATE`. It does **not** block `CREATE`, `TRUNCATE`, `DROP`,
`GRANT`, or PL/SQL that opens an autonomous transaction — and it ends silently at
the implicit commit that every DDL performs. We measured this rather than assumed
it, and the measurement is re-run on every build.

So AuspexLens does three things instead of one:

1. Its own statement guard, an **allowlist**: only `SELECT`, `WITH … SELECT`,
   `EXPLAIN PLAN` and `DESCRIBE` are ever sent.
2. A **fresh read-only transaction per statement**, so the mode never has to
   survive anything.
3. It tells you when your connection is more privileged than it needs to be —
   because least privilege is the layer that actually held in testing.

## What it does not do, on purpose

- **No AWR or ASH.** Those views answer without an error while requiring your own
  Oracle **Diagnostics Pack** licence, so reading them could put you out of
  compliance without a single warning. Everything AuspexLens shows comes from the
  free `v$` views. Some Pro features additionally need
  `GRANT SELECT_CATALOG_ROLE`, and Pro tells you so instead of showing an error.
- **No PL/SQL debugger** — not competing there.
- **No thick mode.** That means **Oracle Native Network Encryption is not
  supported**: if your `sqlnet.ora` policy requires NNE, AuspexLens cannot connect
  yet. The 10G password verifier is likewise unsupported. Kerberos and OCI IAM are
  simply not in v1 — the driver supports them, we have not shipped them.

Supports Oracle Database 12.1 and later.

## Support

https://lensql.dev/auspexlens/ · support@lensql.dev ·
[Issues](https://github.com/lensql/auspexlens-oss/issues)

Licence: MIT for this extension. AuspexLens Pro is sold under a commercial EULA:
https://lensql.dev/auspexlens/eula
