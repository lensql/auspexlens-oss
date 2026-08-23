# AuspexLens — SQL IDE & MCP for Oracle Database

**A native, lightweight Oracle Database client for VS Code, with a read-only MCP
server built in.**

Connects in **thin mode**: pure JavaScript, no JVM, no Oracle Instant Client to
install. Read-only by design, with PII masking in the engine and an MCP server
you can point a language model at without handing it your production database.

> *Auspex*: the Roman augur who read the signs before anyone acted on them.

![AuspexLens in use: the schema in the explorer, a real query in the results grid, the same grid masking personal data, the text execution plan, and the Pro visual plan with cost hotspots](https://lensql.dev/img/listing/auspexlens/hero.gif)

**This is the free half, and it is MIT.** Source:
https://github.com/lensql/auspexlens-oss

## What is free

Everything you need to actually work with an Oracle database:

- **Connections** — user/password over verified TLS, which in thin mode is not
  optional and cannot be switched off. **Import an Oracle wallet** (the `.zip`
  from Autonomous Database, or the folder you unzipped it into) and connect with
  mTLS; the private key goes to your OS keychain, and only `tnsnames.ora` is
  written to disk. If the server drops the session, the next thing you run
  reopens it.
- **Explorer** — tables, views, sequences, packages, procedures, functions and
  triggers, with their source. Plus fuzzy **Find Database Object** across large
  schemas.
- **SQL editor**, results grid, and CSV/JSON export.
- **PL/SQL**: run blocks, and read compile errors straight from `ALL_ERRORS`.
- **Explain plan** (text).
- **Safety**: read-only enforcement, PII masking, and a warning when your
  connection has more privilege than the work needs.
- **A read-only MCP server** for language models.

![The AuspexLens explorer: the schema expanded to its tables, with views, packages, procedures and triggers below](https://lensql.dev/img/listing/auspexlens/explorer.png)

![A join running against a real database: twelve invoices with customer names in the results grid, with the name column masked](https://lensql.dev/img/listing/auspexlens/results-grid.png)

**Free is working with the database safely. Pro is performance, incidents and
governance.** That sentence is the whole rule, and the line it draws is written
in one public file —
[`src/licensing/tiers.ts`](https://github.com/lensql/auspexlens-oss/blob/main/src/licensing/tiers.ts)
— so you can read it rather than take our word for it. Two things it fixes in
place, and tests hold them there: **every safety feature is free** and can never
become paid, and **connections are never counted, capped or metered**.

**AuspexLens Pro** (`lensql.auspexlens-pro`) adds visual explain plans with
cost-hotspot analysis and advisors, a session monitor, a blocking tree and Top
SQL. Details: https://lensql.dev/auspexlens/pricing

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

![The guard refusing DROP TABLE in read-only mode, naming the reason: DROP is DDL, which Oracle's read-only transaction does not block](https://lensql.dev/img/listing/auspexlens/readonly-guard.png)

With read-only off, risky statements explain themselves before they run — and
`DROP`/`TRUNCATE` ask you to **type the object's name**, because the mistake
that actually happens is the right statement against the wrong object:

![The typed-name confirmation for DROP: the dialog quotes Oracle's implicit-commit behaviour and asks you to type DEMO_INVOICES to proceed](https://lensql.dev/img/listing/auspexlens/risk-typed-confirm.png)

![The over-privilege warning in the notification center: this account can create objects, so the guard is the only thing preventing a destructive statement](https://lensql.dev/img/listing/auspexlens/overprivilege-warning.png)

PII masking happens in the engine, before results reach the grid, exports or
the MCP server:

![A query over customers with email, phone and tax id masked in the grid, marked "4 columns masked"](https://lensql.dev/img/listing/auspexlens/pii-masking.png)

![The free text explain plan: DBMS_XPLAN output for a hash join, with predicate information](https://lensql.dev/img/listing/auspexlens/explain-text.png)

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
