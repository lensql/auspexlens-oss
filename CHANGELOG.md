# Changelog — AuspexLens

All notable changes to this package. The Marketplace renders this file as the
extension's Changelog tab, so the newest entry always goes on top.

## [0.1.1] - 2026-08-22

- The Marketplace listing now has its icon. 0.1.0 shipped a 1×1-pixel
  placeholder and no `icon` field in the manifest, so the store showed the
  default tile — permanently, not "while verifying". Nothing else changed.

## [0.1.0] - 2026-08-21

First release. AuspexLens for Oracle Database, free tier:

- **Connections** with Easy Connect or wallet (TNS alias), thin driver only —
  no Oracle Client install. Passwords live in the OS keychain via VS Code
  SecretStorage, never in `settings.json`.
- **Read-only by default, enforced by the engine**: every statement runs in its
  own `SET TRANSACTION READ ONLY`, and a guard refuses DDL, DML, PL/SQL and
  autonomous transactions before they are sent — because Oracle's read-only
  transaction does not stop `DROP`, `TRUNCATE` or `GRANT` (each DDL implicitly
  commits first, ending the read-only transaction). The refusal explains this.
- **Execution warnings on the explicit path**: with read-only off, risky
  statements get a dialog quoting the Oracle behaviour that makes them risky,
  and `DROP`/`TRUNCATE` ask you to type the object's name.
- **Catalog explorer** over `ALL_*` views — works with `CREATE SESSION` plus
  `SELECT` and nothing else, and says exactly which grant is missing otherwise.
- **Results grid** with PII masking applied in the engine, before results reach
  the grid, exports or the MCP server.
- **Basic `EXPLAIN PLAN`** (`DBMS_XPLAN` text output).
- **PL/SQL editing** with compile errors read from `ALL_ERRORS`, squiggles at
  the right line.
- **Embedded MCP server** (8 read-only tools) so an AI agent can inspect the
  database through the same guard, the same read-only transaction and the same
  masking as every human query.

## [0.0.0] - 2026-08-20

- Package scaffolded. Nothing is implemented yet; see `../../PLAN.md`.
