# Changelog — AuspexLens

All notable changes to this package. The Marketplace renders this file as the
extension's Changelog tab, so the newest entry always goes on top.

## [1.0.0] - 2026-08-22

**Same software as 0.2.0. The number is the news.** Nothing was added, removed
or changed in this release — it is 0.2.0's code, republished under a version
that says the surface is settled and will not move under you.

Why now: everything the README promises has been executed against a real
server, not only against a container. The 37 live cases pass unchanged on a
managed **Oracle 19c** (AWS RDS SE2) over TCPS, on **Oracle AI Database 26ai
Free 23.26** locally, and wallet import was proven end to end against a real
**Autonomous Database** over mTLS. What that validation exposed on our side was
fixed in 0.1.2, and the last gap it left — a wallet the engine could use but no
command could reach — closed in 0.2.0.

From this release the extension is also published on **Open VSX**, so editors
that do not use the Microsoft Marketplace can install it.

Commands, settings, the MCP tool names and the read-only contract are stable
from here: they change by addition, or with a major version and a migration
note.

## [0.2.0] - 2026-08-22

- **Wallet connections work, and are listed again.** `AuspexLens: Import wallet`
  takes the `.zip` you download from Autonomous Database — or the folder you
  unzipped it into — reads `tnsnames.ora` and `ewallet.pem`, and creates a
  connection profile you can use straight away. The private key goes to your OS
  keychain through SecretStorage and is never written to disk; only
  `tnsnames.ora` is, because the driver reads that file itself.
  - If your wallet shipped `ewallet.p12` and no `ewallet.pem`, which Oracle
    documents as a real possibility, the import tells you the exact `openssl`
    command to convert it rather than failing with something unhelpful.
  - The archive is read with Node's own `zlib`, so this adds no dependency to
    the extension. It refuses what it cannot fully understand — encryption,
    zip64, unknown compression, traversing paths — instead of guessing.
- `connect.wallet` is back in `tiers.ts` as a free capability. It was withdrawn
  in 0.1.2 because nothing could reach it; it returns in the release that makes
  it reachable, which is the rule that file is supposed to follow.

## [0.1.2] - 2026-08-22

Validating against a real Oracle — a managed 19c on AWS RDS, and a container
converted into a TCPS server that demands a client certificate — turned up four
defects. Three were the driver's; this release is what changed on our side.

- **Reconnection now exists.** The README has promised it since 0.1.0 and the
  connection manager did not do it: it cached the connection and handed back the
  same dead one for ever. Measured by killing a real session. Now the start of
  every operation notices a dropped connection and reopens it, and the statement
  you ran goes through. A connection that dies *mid-statement* still reports the
  failure rather than silently re-running it — retrying there would send the
  statement on a fresh connection that is not inside the read-only transaction,
  which is the one thing this product must never do.
- **The over-privilege warning was firing on everybody.** `probePrivileges` asked
  "did the query run?" for a question whose query runs for every user and simply
  returns no rows, so every connection was reported as able to create objects —
  including the least-privileged account there is. A warning that fires always is
  a warning nobody reads. It now asks whether a row came back, and ignores
  `CREATE SESSION`, which everyone has by definition.
- **`auspexlens.tls.rejectUnauthorized` no longer pretends.** In thin mode the
  Oracle driver always verifies the server's certificate and offers no way to
  stop it — the parameter this setting used to send does not exist and was
  silently discarded. Setting it to `false` is now refused with an explanation,
  and the explanation names what actually works: point `NODE_EXTRA_CA_CERTS` at
  your CA's PEM file to trust a private or self-signed authority. The transport
  was always safer than the setting implied; only the promise was wrong.
- **Wallet connections are no longer listed as a feature.** The engine speaks
  wallet mTLS and it is now proven against a server that demands a client
  certificate — but no command in the extension ever stored a wallet, so no user
  could reach it, and the error you got pointed at an import that was never
  built. It is out of scope in `tiers.ts` until the import command ships, rather
  than advertised and unreachable.

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
