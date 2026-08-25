# Changelog — AuspexLens

All notable changes to this package. The Marketplace renders this file as the
extension's Changelog tab, so the newest entry always goes on top.

## [1.8.0] - 2026-08-25

- **The safety state is now visible.** Read-only enforcement and PII masking are
  what AuspexLens is for, and until now both lived only in `settings.json` — a
  protection you cannot see is one you cannot trust. The status bar shows both
  while you are connected, and clicking it changes either.
  - Read-only **off**, or masking **off**, turns the indicator amber. Those are
    the two states where the product is doing less than you would assume.
  - Turning read-only off warns you, because Oracle's own read-only transaction
    never stopped DDL: with ours off, the account's privileges are the only thing
    left. The MCP server keeps refusing everything but reads regardless.
  - The indicator follows the settings wherever they change from — the JSON file,
    another window, or Settings Sync.

## [1.7.0] - 2026-08-25

- **You can add a connection without editing a settings file.** Until now the
  only way to configure AuspexLens was to hand-write JSON under
  `auspexlens.connections.profiles`, and pressing **Connect** with nothing
  configured told you to go and do that. It now opens a wizard.
  - It asks what you are connecting to — host/port/service, an Autonomous
    Database wallet, or a TNS alias you already have — and proposes Oracle's
    default port rather than starting every field blank.
  - Every field carries an example, including the one people get wrong: the
    service name is not the SID.
  - **It tests the connection before saving anything.** A profile that does not
    connect is worse than no profile, because it fails later somewhere else. If
    the test fails you get the real error and the choice to save anyway.
  - If you paste a whole connect string into the host field — which is what
    everyone does — it tells you so instead of saving something that cannot work.
- **Manage connections**: see what is configured, connect to one, or remove one
  along with its stored password.
- **The activity bar icon carries the lens again.** The one shipped in 1.3.0 was
  a database cylinder with no lens, in a product called AuspexLens. The
  Marketplace tile is also lighter: same image, 5.5 KB instead of 19.8 KB, and
  without the alpha channel that could make it sit oddly on some backgrounds.

## [1.6.0] - 2026-08-25

- **The explorer header says which container you are in.** A tree of schemas
  looks identical in every container, and `SALES` in the CDB root is not `SALES`
  in a pluggable database. The name now sits beside the panel's title — nothing
  to expand, nothing to click — and clears when you disconnect, because a stale
  container name over an empty tree says you are somewhere you are not.

## [1.5.0] - 2026-08-25

- **Add a connection to a pluggable database**, derived from the one you are on
  — the mirror of the CDB-root connection added in 1.2.0. Looking at the estate
  from the root and then having to type each PDB's connection by hand was half a
  feature. Free, like every connection in AuspexLens.

## [1.4.0] - 2026-08-25

The explorer becomes usable. 1.3.0 fixed the palette, the icon and the empty
view; this fixes the panel you actually work in.

- **Right-click now does something.** Tables, views, packages and procedures get
  a context menu: **Select the first 100 rows**, **Open source**, and **Copy
  qualified name**. The preview is also a single click on the row itself. Before
  this release the explorer had no context menu at all.
- **Refresh.** There was no way to ask the explorer to re-read the catalog, so an
  object created in another session never appeared until you reconnected. It is
  now a button in the panel's toolbar, and on a schema's context menu.
- **Copy qualified name** copies `SCHEMA.OBJECT`, not the bare label — an
  unqualified name resolves against your own schema and can silently point at a
  different object.
- **The toolbar is grouped**: refresh and find as buttons, connections and
  container actions in their own sections, instead of everything in one row.
- Selecting the first 100 rows **opens the statement in an editor rather than
  running it**. You see exactly what will be sent, you can change it first, and
  you run it the same way you run anything else — there is one path to the
  database, not a private one for the explorer.

## [1.3.0] - 2026-08-25

The interface, brought up to the standard the rest of the product was already
held to. Nothing about what AuspexLens *does* changed; a lot about what you see
did.

- **Commands are grouped properly in the Command Palette.** They now declare a
  category, which VS Code renders itself — so typing `>AuspexLens` filters to
  exactly this extension, and the free and paid halves appear as **one product**
  instead of two. Previously the prefix was typed into each title by hand, which
  VS Code showed as part of the label and could not group.
- **The activity bar icon is an SVG.** It was the Marketplace's full-colour PNG,
  which cannot follow your theme — it was the one icon in the bar that did not
  match the others. The new one is a 24×24 single-colour vector.
- **The empty view now tells you where to start.** Before your first connection
  the panel was blank; it now offers *Connect* and *Import an Oracle wallet* —
  the two things that work before you have a connection.
- **Commands that need a connection are hidden until you have one**, instead of
  being offered and then refusing. `Open source` no longer appears in the palette
  at all, since it needs an object picked in the explorer.
- **`Ctrl`/`Cmd`+`Enter` runs the query** in a SQL or PL/SQL editor.

## [1.2.0] - 2026-08-23

- **“Add a connection to the CDB root”** — a new command that derives a root
  connection from the pluggable database you are already on, swapping the
  service name and leaving both the service and the user editable before
  anything is saved.
  - Why it is free: Oracle's own documentation is explicit that *a user whose
    current container is a PDB can view data for that PDB only*. Seeing the whole
    container database is therefore gated by **which container you connected
    to**, not by a privilege anyone can grant you — and a limitation whose only
    way out is another connection must not have that way out behind a paywall.
    AuspexLens has never counted or capped connections and never will.
  - It refuses rather than guesses: a wallet profile's connect string is a TNS
    alias with no service to swap, and it says so instead of producing a profile
    that cannot resolve. It never overwrites an existing profile either.
  - The service name it proposes is what the database reports as its own name,
    which is the usual convention rather than a fact about your installation —
    the prompt says so, and warns that a PDB-local account normally cannot log in
    to the root.

## [1.1.0] - 2026-08-23

- **AuspexLens now tells you which container you are connected to**, and it is
  free — because knowing where you are is part of running a statement safely,
  not a premium feature. Connecting reports it beside the privilege advice, and
  there is a new command, **“AuspexLens: Which container am I in?”**.
  - **Connecting to the CDB root now warns you.** A statement run in `CDB$ROOT`
    is not scoped to one application's data, and the read-only guard — which
    stops it being destructive — has nothing to say about it reaching further
    than you meant. Two safety layers working correctly can still leave that
    surprise; naming the container removes it.
  - It asks the database rather than the driver. node-oracledb's connection
    property documents itself as equivalent to
    `SYS_CONTEXT('USERENV','CON_NAME')` and, measured against a real container
    database, is not: in the root it returns the *database* name, which would
    have told you that you were inside a pluggable database when you were not.
  - Works on a connection holding nothing but `CREATE SESSION`, like everything
    else in the free tier.
- A non-CDB database is reported as having no containers, which is an answer
  rather than a gap — nothing pretends an estate exists where it cannot.

## [1.0.1] - 2026-08-23

Nothing about the extension's behaviour changed. This release is about being
findable, and about saying more clearly what you get for nothing.

- **The Marketplace listing now says what this is.** The extension was published
  as plain "AuspexLens", which tells you nothing unless you already know the
  name; it is now *AuspexLens — SQL IDE & MCP for Oracle Database*, and the
  summary names the things people actually search for: thin mode with no Instant
  Client, Autonomous Database wallets, the schema explorer, PL/SQL and explain
  plans.
- **The free/paid line now starts with a sentence, not a list.**
  `src/licensing/tiers.ts` — the public file this README points at — opens with
  the principle it follows: **free is working with the database safely; Pro is
  performance, incidents and governance.** Two consequences are written down and
  held by tests rather than by good intentions: every safety capability is free
  and can never become paid, and **connections are never counted, capped or
  metered**.
- **The same file now records what has been decided but not built**, in a
  separate list that the extension deliberately does not advertise. Nothing moves
  into the capability list until it works — that rule cost this product a release
  in 0.1.2 and it now has a test of its own.

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
