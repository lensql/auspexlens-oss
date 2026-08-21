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
   * TLS verification. Default true, and the escape hatch is named for what it
   * actually does rather than something soothing. If it is ever set, that fact
   * belongs in the security document's residual-risk section, not in a tooltip.
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

  // Explicit rather than relying on the driver's default: a default that changes
  // in a minor release would silently downgrade every user's transport.
  base['sslVerifyCertificate'] = options.rejectUnauthorized !== false;
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
