/**
 * Connecting to Oracle, in thin mode only.
 *
 * `node-oracledb` 7.x thin is pure JavaScript with zero production dependencies
 * and no Instant Client, which is what lets the driver ship inside the .vsix and
 * is the whole basis of "starts in under a second, no JVM" (docs/RESEARCH.md
 * §17.1). Thick mode is not a fallback here: enabling it would mean asking every
 * user to install Oracle client libraries, which is the competitor's problem, not
 * ours.
 *
 * What thin genuinely cannot do, verified against the driver's own docs and
 * repeated in the README because users will hit it:
 *
 *   - **Oracle Native Network Encryption (NNE) and checksumming are thick-only.**
 *     A shop whose sqlnet policy mandates NNE cannot connect in v1. This is the
 *     limitation that will hurt, and it is not ours to fix.
 *   - `sqlnet.ora` is thick-only (a few values are reachable through Easy Connect).
 *   - The 10G password verifier is unsupported. Diagnose with:
 *       SELECT username FROM dba_users WHERE password_versions IN ('10G ','10G HTTP ')
 *
 * Kerberos and OCI IAM are NOT in this list. Thin supports both; leaving them out
 * of v1 is a scope decision (D4), and saying otherwise in the docs would be
 * telling users something false about the driver.
 */

export interface BasicCredentials {
  kind: 'basic';
  user: string;
  /** Never stored in settings.json. Comes from VS Code SecretStorage. */
  password: string;
  /** Easy Connect: host:port/service. */
  connectString: string;
}

export interface WalletCredentials {
  kind: 'wallet';
  user: string;
  password: string;
  /** The TNS alias out of tnsnames.ora, e.g. `mydb_high`. */
  connectString: string;
  /** Directory holding tnsnames.ora. */
  configDir: string;
  /**
   * The PEM itself, not a path.
   *
   * `walletContent` (node-oracledb 6.6+) takes the certificate as a string and
   * takes precedence over `walletLocation`. That is what lets the wallet live in
   * VS Code's SecretStorage — encrypted by the OS — instead of as a directory of
   * files on disk that the user has to keep somewhere and we have to keep
   * pointing at. Import the .zip once, keep the PEM in SecretStorage, never touch
   * the disk again.
   */
  walletContent: string;
  /** The wallet password, which in thin mode is a CONNECTION parameter (in thick
   *  it lives inside the wallet files). Also SecretStorage, never settings. */
  walletPassword: string;
}

export type Credentials = BasicCredentials | WalletCredentials;

export interface ConnectionOptions {
  credentials: Credentials;
  /**
   * TLS verification. It can only ever be true.
   *
   * This started life as an escape hatch and turned out not to be one: see
   * `buildConnectConfig`. Setting it to false is refused with an explanation
   * rather than silently ignored.
   */
  rejectUnauthorized?: boolean;
}

/** The subset of the oracledb module this file uses, so it can be substituted in
 *  tests without a database and cannot quietly reach for anything else. */
export interface OracleDbLike {
  thin: boolean;
  getConnection(config: Record<string, unknown>): Promise<unknown>;
}

export function buildConnectConfig(options: ConnectionOptions): Record<string, unknown> {
  const c = options.credentials;
  const base: Record<string, unknown> = {
    user: c.user,
    password: c.password,
    connectString: c.connectString,
  };

  if (c.kind === 'wallet') {
    base['configDir'] = c.configDir;
    base['walletContent'] = c.walletContent;
    base['walletPassword'] = c.walletPassword;
  }

  // WHY THERE IS NO `sslVerifyCertificate` HERE ANY MORE.
  //
  // Until 0.1.2 this line set `sslVerifyCertificate` from `rejectUnauthorized`,
  // on the reasonable-sounding grounds that being explicit beats relying on a
  // driver default. Measured against node-oracledb 7.0.1 on 2026-08-22
  // (docs/RESEARCH.md §17.9): **there is no such parameter.** It appears nowhere
  // in the driver's `lib/` and nowhere in `@types/oracledb`, and `getConnection`
  // accepts and discards any property it does not recognise — verified by handing
  // it a deliberately invented one. Thin mode passes `rejectUnauthorized: true`
  // to Node's TLS as a literal, in the initial handshake and again in the
  // renegotiation after the listener hands off (`thin/sqlnet/ntTcp.js`).
  //
  // So the transport is SAFER than the setting implied, and the setting was a
  // promise the product could not keep. Sending a parameter the driver throws
  // away is not "explicit"; it is a comment that looks like code.
  if (options.rejectUnauthorized === false) {
    throw new Error(
      'TLS certificate verification cannot be switched off. AuspexLens connects in ' +
        'thin mode, and node-oracledb always verifies the database server’s certificate ' +
        'there — the setting that used to promise otherwise never had any effect.\n\n' +
        'To connect to a server whose certificate is signed by a private or self-signed ' +
        'CA, make that CA trusted instead of turning verification off: point the ' +
        'NODE_EXTRA_CA_CERTS environment variable at its PEM file before starting VS Code. ' +
        'That is the route measured to work against Amazon RDS (docs/RESEARCH.md §17.10).',
    );
  }
  return base;
}

/**
 * Refuse to run in thick mode.
 *
 * `oracledb.initOracleClient()` anywhere in the process flips the whole module to
 * thick permanently. Nothing in this extension calls it — but a dependency could,
 * and the failure would be silent and total: the extension would start requiring
 * Oracle client libraries on the user's machine, which is exactly what this
 * product promises not to do.
 */
export function assertThin(oracledb: Pick<OracleDbLike, 'thin'>): void {
  if (!oracledb.thin) {
    throw new Error(
      'the Oracle driver is in thick mode. AuspexLens is thin-only: thick mode ' +
        'requires Oracle Client libraries on the user machine, which is the thing ' +
        'this extension exists to avoid. Something called initOracleClient().',
    );
  }
}
