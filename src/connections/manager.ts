/**
 * Connection profiles, and the one place a connection is opened.
 *
 * The driver is imported **lazily**, on first connect, and never at activation.
 * That is the whole "starts in under a second" claim: `require('oracledb')` pulls
 * in the thin-mode protocol implementation, and doing it at activation would
 * spend that time for every user who opens a SQL file and never connects.
 */

import type { Credentials } from '../engine/connection';
import { buildConnectConfig, assertThin } from '../engine/connection';
import type { CredentialStore } from './secrets';
import type { ReadOnlyCapableConnection } from '../engine/readOnly';

/** What lives in settings: everything that is not a secret. */
export interface ProfileConfig {
  id: string;
  label: string;
  user: string;
  /** Easy Connect `host:port/service`, or a TNS alias when a wallet is used. */
  connectString: string;
  kind: 'basic' | 'wallet';
  /** Directory holding tnsnames.ora. Wallet profiles only. */
  configDir?: string;
  rejectUnauthorized?: boolean;
}

export interface OracleConnection extends ReadOnlyCapableConnection {
  close(): Promise<void>;
  commit(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OracleDbModule = any;

let cachedDriver: OracleDbModule | undefined;

/**
 * Load the driver once, and refuse thick mode.
 *
 * `oracledb.initOracleClient()` anywhere in the process flips the whole module to
 * thick permanently, and then the extension starts requiring Oracle Client
 * libraries on the user's machine — the exact thing this product exists to avoid.
 * Nothing here calls it; this check is what notices if a dependency ever does.
 */
export async function loadDriver(): Promise<OracleDbModule> {
  if (!cachedDriver) {
    cachedDriver = (await import('oracledb')).default;
    assertThin(cachedDriver as { thin: boolean });
  }
  return cachedDriver;
}

export class ConnectionManager {
  private open = new Map<string, OracleConnection>();

  constructor(private readonly credentials: CredentialStore) {}

  /** The profile currently used by the MCP bridge and the editor, if any. */
  activeProfileId: string | undefined;

  active(): OracleConnection | undefined {
    return this.activeProfileId ? this.open.get(this.activeProfileId) : undefined;
  }

  async connect(profile: ProfileConfig): Promise<OracleConnection> {
    const existing = this.open.get(profile.id);
    if (existing) {
      this.activeProfileId = profile.id;
      return existing;
    }

    const password = await this.credentials.get(profile.id, 'password');
    if (password === undefined) {
      throw new Error(
        `No stored password for “${profile.label}”. Run “AuspexLens: Connect” and enter it — ` +
          'it is stored in the OS keychain, never in settings.json.',
      );
    }

    let creds: Credentials;
    if (profile.kind === 'wallet') {
      const walletContent = await this.credentials.get(profile.id, 'walletContent');
      const walletPassword = await this.credentials.get(profile.id, 'walletPassword');
      if (!walletContent || walletPassword === undefined || !profile.configDir) {
        throw new Error(
          `“${profile.label}” is a wallet connection but its wallet is not fully stored. ` +
            'Re-import the wallet .zip.',
        );
      }
      creds = {
        kind: 'wallet',
        user: profile.user,
        password,
        connectString: profile.connectString,
        configDir: profile.configDir,
        walletContent,
        walletPassword,
      };
    } else {
      creds = {
        kind: 'basic',
        user: profile.user,
        password,
        connectString: profile.connectString,
      };
    }

    const driver = await loadDriver();
    const conn = (await driver.getConnection(
      buildConnectConfig({ credentials: creds, rejectUnauthorized: profile.rejectUnauthorized }),
    )) as OracleConnection;

    this.open.set(profile.id, conn);
    this.activeProfileId = profile.id;
    return conn;
  }

  async disconnect(profileId: string): Promise<void> {
    const conn = this.open.get(profileId);
    if (!conn) return;
    this.open.delete(profileId);
    if (this.activeProfileId === profileId) this.activeProfileId = undefined;
    await conn.close();
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.open.keys()]) {
      await this.disconnect(id).catch(() => undefined);
    }
  }
}
