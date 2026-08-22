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

/**
 * The error codes that mean "this connection is dead", taken from the driver's
 * own tables rather than from a list somebody remembered.
 *
 * Read `node_modules/oracledb/lib/errors.js` (7.0.1) before changing this:
 *
 *  - `adjustErrorXref` maps **28** ODPI/Oracle disconnect codes onto NJS-500
 *    (`ERR_CONNECTION_CLOSED`) — including `ORA-00028` (session killed, which is
 *    what `rdsadmin_util.kill` produces), `ORA-03113` (end-of-file on the
 *    communication channel) and `ORA-03114` (not connected). So matching NJS-500
 *    covers the whole family without this file having to know any of them.
 *  - NJS-501 is `terminated unexpectedly`; NJS-003 is `invalid or closed
 *    connection`, which is what a connection object that was already closed
 *    answers.
 *
 * **NJS-503 is deliberately absent.** It is "could not be established" — a
 * connect failure, not a broken established connection. Retrying it would just
 * double the wait in front of an unreachable server.
 */
const BROKEN_CONNECTION_CODES: ReadonlySet<string> = new Set([
  'NJS-500',
  'NJS-501',
  'NJS-003',
]);

/**
 * Is this error the database telling us the connection is gone?
 *
 * `isRecoverable` is checked because the driver sets it, but it is NOT enough on
 * its own, and the reason is worth keeping: `getErr` sets
 * `isRecoverable = true` only for errors it raises itself, while `transformErr`
 * — the path an `ORA-` disconnect arrives through — copies the rewritten `code`
 * and `message` onto the original error and **leaves `isRecoverable` undefined**.
 * A killed session, the exact case this whole mechanism exists for, therefore
 * arrives as `code: 'NJS-500'` with no `isRecoverable` at all. Measured against
 * 7.0.1 on 2026-08-22.
 */
export function isBrokenConnection(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; isRecoverable?: unknown };
  if (e.isRecoverable === true) return true;
  return typeof e.code === 'string' && BROKEN_CONNECTION_CODES.has(e.code);
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

/**
 * A connection that repairs itself at the start of an operation.
 *
 * **Why `rollback` and not `execute`.** Every path that reaches the database in
 * this product begins by ending the previous transaction — `beginReadOnly` does
 * it for queries and both explains, and `runAnonymousBlock` does it for PL/SQL.
 * That rollback is therefore the operation boundary, and it is the only safe
 * place to reconnect.
 *
 * Healing inside `execute` would be a security defect, not a nicety. The
 * sequence is rollback → `SET TRANSACTION READ ONLY` → the statement. If the
 * statement failed on a dead connection and this wrapper quietly reconnected and
 * re-sent it, the retry would land on a FRESH connection that is not in a
 * read-only transaction — the statement would run with the read-only floor
 * switched off, which is precisely the failure mode CLAUDE.md §2 exists to
 * prevent. So a connection that dies mid-statement reports that honestly, and
 * the NEXT operation is the one that heals.
 *
 * The wrapper's identity is stable across a reconnect. Consumers hold whatever
 * `active()` handed them, so the replacement has to happen underneath them
 * rather than by giving everyone a new object.
 */
class HealingConnection implements OracleConnection {
  constructor(
    private readonly manager: ConnectionManager,
    private readonly profileId: string,
  ) {}

  private raw(): OracleConnection {
    const raw = this.manager.rawFor(this.profileId);
    if (!raw) {
      throw new Error('this connection has been closed. Run “AuspexLens: Connect” again.');
    }
    return raw;
  }

  /** The operation boundary, and so the one place that reconnects. */
  async rollback(): Promise<void> {
    try {
      await this.raw().rollback();
      return;
    } catch (err) {
      if (!isBrokenConnection(err)) throw err;
      // One attempt, not a loop: if the reconnect itself fails, the user gets
      // the real reason instead of a wait that ends in the same error.
      await this.manager.reopen(this.profileId);
    }
    // A brand-new connection has no transaction to end, so this is cheap — and
    // it keeps the contract, which is "after this returns, no transaction is
    // open". If it fails now, that error is real and belongs to the caller.
    await this.raw().rollback();
  }

  // `async` on both of these is not decoration. `raw()` throws when the profile
  // has been disconnected, and a method whose type says `Promise` must REJECT
  // rather than throw synchronously — otherwise a caller written as
  // `conn.execute(...).catch(...)` crashes instead of catching. Caught by the
  // test that disconnects and then uses the stale handle.
  async execute(
    sql: string,
    binds?: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ rows?: unknown[][]; metaData?: { name: string }[] }> {
    // Deliberately not healed — see the class comment. This is load-bearing.
    //
    // The arity is forwarded rather than flattened: node-oracledb validates
    // `arguments.length`, so `execute(sql, undefined)` is NOT the same call as
    // `execute(sql)` and fails with `NJS-005: invalid value for parameter 2`.
    // A wrapper that always passed three arguments broke every call that binds
    // nothing — which is most of them. The unit tests could not see it, because
    // a fake connection does not care how many arguments it is handed; the live
    // suite found it immediately.
    const raw = this.raw();
    if (options !== undefined) return raw.execute(sql, binds, options);
    if (binds !== undefined) return raw.execute(sql, binds);
    return raw.execute(sql);
  }

  async commit(): Promise<void> {
    return this.raw().commit();
  }

  /** Closing a connection the server already dropped is not an error worth
   *  showing: the user asked for it to be gone and it is gone. */
  async close(): Promise<void> {
    try {
      await this.raw().close();
    } catch (err) {
      if (!isBrokenConnection(err)) throw err;
    }
  }
}

/** What the manager holds per profile: the live driver connection, the profile
 *  that opened it, and the stable wrapper handed to consumers. */
interface OpenConnection {
  raw: OracleConnection;
  profile: ProfileConfig;
  handle: HealingConnection;
}

/** How a driver connection is actually opened. Injectable so this class can be
 *  tested without a database — before 2026-08-22 it had no tests at all, and
 *  that is how the missing reconnection survived to a published release. */
export type OpenDriverConnection = (
  config: Record<string, unknown>,
) => Promise<OracleConnection>;

const openWithDriver: OpenDriverConnection = async (config) => {
  const driver = await loadDriver();
  return (await driver.getConnection(config)) as OracleConnection;
};

export class ConnectionManager {
  private open = new Map<string, OpenConnection>();

  constructor(
    private readonly credentials: CredentialStore,
    private readonly openConnection: OpenDriverConnection = openWithDriver,
  ) {}

  /** The profile currently used by the MCP bridge and the editor, if any. */
  activeProfileId: string | undefined;

  active(): OracleConnection | undefined {
    return this.activeProfileId ? this.open.get(this.activeProfileId)?.handle : undefined;
  }

  /** The live driver connection behind a handle. Internal to the healing
   *  wrapper; nothing else should reach past the handle. */
  rawFor(profileId: string): OracleConnection | undefined {
    return this.open.get(profileId)?.raw;
  }

  /**
   * Replace the driver connection behind an existing handle.
   *
   * The old one is not closed politely first: it is already broken, and asking a
   * dead socket to shut down cleanly is how a reconnect turns into a hang. It is
   * asked, but its failure is ignored.
   */
  async reopen(profileId: string): Promise<void> {
    const entry = this.open.get(profileId);
    if (!entry) {
      throw new Error('this connection has been closed. Run “AuspexLens: Connect” again.');
    }
    await entry.raw.close().catch(() => undefined);
    entry.raw = await this.openRaw(entry.profile);
  }

  private async openRaw(profile: ProfileConfig): Promise<OracleConnection> {
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
            'Wallet connections are configured outside the extension for now — see the README.',
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

    return this.openConnection(
      buildConnectConfig({ credentials: creds, rejectUnauthorized: profile.rejectUnauthorized }),
    );
  }

  async connect(profile: ProfileConfig): Promise<OracleConnection> {
    const existing = this.open.get(profile.id);
    if (existing) {
      this.activeProfileId = profile.id;
      return existing.handle;
    }

    const raw = await this.openRaw(profile);
    const handle = new HealingConnection(this, profile.id);
    this.open.set(profile.id, { raw, profile, handle });
    this.activeProfileId = profile.id;
    return handle;
  }

  async disconnect(profileId: string): Promise<void> {
    const entry = this.open.get(profileId);
    if (!entry) return;
    this.open.delete(profileId);
    if (this.activeProfileId === profileId) this.activeProfileId = undefined;
    // Same reasoning as HealingConnection.close: a connection the server already
    // dropped must not turn “Disconnect” into an error message.
    await entry.raw.close().catch((err) => {
      if (!isBrokenConnection(err)) throw err;
    });
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.open.keys()]) {
      await this.disconnect(id).catch(() => undefined);
    }
  }
}
