import { describe, it, expect } from 'vitest';
import {
  ConnectionManager,
  isBrokenConnection,
  type OpenDriverConnection,
  type OracleConnection,
  type ProfileConfig,
} from '../src/connections/manager';
import { CredentialStore, type SecretStorageLike } from '../src/connections/secrets';

/** An in-memory SecretStorage, so these tests exercise the REAL CredentialStore
 *  rather than a stand-in that could agree with a mistake. */
const storage = (seed: Record<string, string> = {}): SecretStorageLike => {
  const map = new Map(Object.entries(seed));
  return {
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => { map.set(k, v); return Promise.resolve(); },
    delete: (k) => { map.delete(k); return Promise.resolve(); },
  };
};

const PROFILE: ProfileConfig = {
  id: 'p1',
  label: 'Test',
  user: 'auspex_test',
  connectString: 'localhost:1521/FREEPDB1',
  kind: 'basic',
};

/** Shapes the error exactly as node-oracledb 7.0.1 produces it. */
const njs = (code: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(`${code}: something`), { code, ...extra });

/** A fake driver connection whose every method can be told to fail. */
class FakeConn implements OracleConnection {
  rollbacks = 0;
  executes: string[] = [];
  closed = false;
  rollbackError: Error | undefined;
  executeError: Error | undefined;
  closeError: Error | undefined;

  constructor(readonly tag: string) {}

  async rollback(): Promise<void> {
    this.rollbacks += 1;
    if (this.rollbackError) throw this.rollbackError;
  }
  async execute(sql: string): Promise<{ rows?: unknown[][]; metaData?: { name: string }[] }> {
    this.executes.push(sql);
    if (this.executeError) throw this.executeError;
    return { rows: [[this.tag]], metaData: [{ name: 'TAG' }] };
  }
  async commit(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
    if (this.closeError) throw this.closeError;
  }
}

/** A manager wired to a driver that hands out FakeConns in order. */
const managerWith = (conns: FakeConn[]) => {
  let i = 0;
  const opened: Record<string, unknown>[] = [];
  const open: OpenDriverConnection = async (config) => {
    opened.push(config);
    const c = conns[i];
    i += 1;
    if (!c) throw new Error('the test ran out of fake connections');
    return c;
  };
  const creds = new CredentialStore(storage({ 'auspexlens:p1:password': 'pw' }));
  return { manager: new ConnectionManager(creds, open), opened, count: () => i };
};

describe('isBrokenConnection', () => {
  it('recognises NJS-500, which the driver folds 28 ORA disconnects into', () => {
    expect(isBrokenConnection(njs('NJS-500'))).toBe(true);
  });

  it('recognises a killed session, which arrives WITHOUT isRecoverable', () => {
    // The case this whole mechanism exists for. `transformErr` rewrites the code
    // of an ORA-00028 to NJS-500 but does not carry `isRecoverable` across, so a
    // detector that trusted that flag alone would miss exactly this.
    const killed = njs('NJS-500');
    expect((killed as { isRecoverable?: unknown }).isRecoverable).toBeUndefined();
    expect(isBrokenConnection(killed)).toBe(true);
  });

  it('honours the driver’s own isRecoverable when it is set', () => {
    expect(isBrokenConnection(Object.assign(new Error('x'), { isRecoverable: true }))).toBe(true);
  });

  it('recognises NJS-501 and NJS-003', () => {
    expect(isBrokenConnection(njs('NJS-501'))).toBe(true);
    expect(isBrokenConnection(njs('NJS-003'))).toBe(true);
  });

  it('does NOT treat "could not be established" (NJS-503) as broken', () => {
    // A connect failure, not a dropped connection. Retrying it only doubles the
    // wait in front of a server that is not there.
    expect(isBrokenConnection(njs('NJS-503'))).toBe(false);
  });

  it('does not treat an ordinary SQL error as a dead connection', () => {
    expect(isBrokenConnection(njs('ORA-00942'))).toBe(false);
    expect(isBrokenConnection(new Error('table or view does not exist'))).toBe(false);
  });

  it('is not fooled by non-objects', () => {
    for (const v of [null, undefined, 'NJS-500', 500]) expect(isBrokenConnection(v)).toBe(false);
  });
});

describe('ConnectionManager', () => {
  it('opens once and reuses the connection for the same profile', async () => {
    const { manager, count } = managerWith([new FakeConn('a')]);
    const first = await manager.connect(PROFILE);
    const second = await manager.connect(PROFILE);
    expect(second).toBe(first);
    expect(count()).toBe(1);
  });

  it('reconnects when the operation boundary finds the connection dead', async () => {
    // This is the defect measured against RDS on 2026-08-22: kill the session,
    // and the manager kept handing back the same corpse.
    const dead = new FakeConn('dead');
    const fresh = new FakeConn('fresh');
    dead.rollbackError = njs('NJS-500');
    const { manager, count } = managerWith([dead, fresh]);

    const conn = await manager.connect(PROFILE);
    await conn.rollback();

    expect(count()).toBe(2);
    expect(dead.closed).toBe(true);
    expect(fresh.rollbacks).toBe(1);

    // And the statement after it lands on the NEW connection.
    const res = await conn.execute('SELECT 1 FROM dual');
    expect(res.rows).toEqual([['fresh']]);
  });

  it('keeps the handle’s identity across a reconnect', async () => {
    // Consumers hold whatever active() gave them; the swap has to happen
    // underneath them or the healing is invisible to everyone already running.
    const dead = new FakeConn('dead');
    dead.rollbackError = njs('NJS-500');
    const { manager } = managerWith([dead, new FakeConn('fresh')]);

    const conn = await manager.connect(PROFILE);
    await conn.rollback();
    expect(manager.active()).toBe(conn);
  });

  it('does NOT reconnect on a statement failure', async () => {
    // Load-bearing, and the reason the healing lives in rollback(). A retry here
    // would land on a fresh connection that is NOT inside the read-only
    // transaction the previous statement had opened.
    const conn0 = new FakeConn('a');
    conn0.executeError = njs('NJS-500');
    const { manager, count } = managerWith([conn0, new FakeConn('b')]);

    const conn = await manager.connect(PROFILE);
    await expect(conn.execute('SELECT 1 FROM dual')).rejects.toThrow('NJS-500');
    expect(count()).toBe(1);
  });

  it('does not reconnect on an error that is not a dead connection', async () => {
    const conn0 = new FakeConn('a');
    conn0.rollbackError = njs('ORA-01031');
    const { manager, count } = managerWith([conn0, new FakeConn('b')]);

    const conn = await manager.connect(PROFILE);
    await expect(conn.rollback()).rejects.toThrow('ORA-01031');
    expect(count()).toBe(1);
  });

  it('surfaces the real reason when the reconnect itself fails', async () => {
    const dead = new FakeConn('dead');
    dead.rollbackError = njs('NJS-500');
    let i = 0;
    const open: OpenDriverConnection = async () => {
      i += 1;
      if (i === 1) return dead;
      throw new Error('ORA-12541: TNS:no listener');
    };
    const creds = new CredentialStore(storage({ 'auspexlens:p1:password': 'pw' }));
    const manager = new ConnectionManager(creds, open);

    const conn = await manager.connect(PROFILE);
    await expect(conn.rollback()).rejects.toThrow('no listener');
  });

  it('disconnecting a connection the server already dropped is not an error', async () => {
    const conn0 = new FakeConn('a');
    conn0.closeError = njs('NJS-500');
    const { manager } = managerWith([conn0]);

    await manager.connect(PROFILE);
    await expect(manager.disconnect(PROFILE.id)).resolves.toBeUndefined();
    expect(manager.active()).toBeUndefined();
  });

  it('still reports a genuine failure to close', async () => {
    const conn0 = new FakeConn('a');
    conn0.closeError = new Error('disk on fire');
    const { manager } = managerWith([conn0]);

    await manager.connect(PROFILE);
    await expect(manager.disconnect(PROFILE.id)).rejects.toThrow('disk on fire');
  });

  it('refuses to use a handle whose profile has been disconnected', async () => {
    const { manager } = managerWith([new FakeConn('a')]);
    const conn = await manager.connect(PROFILE);
    await manager.disconnect(PROFILE.id);
    await expect(conn.execute('SELECT 1 FROM dual')).rejects.toThrow('has been closed');
  });

  it('names the profile when no password is stored', async () => {
    const creds = new CredentialStore(storage());
    const manager = new ConnectionManager(creds, async () => new FakeConn('a'));
    await expect(manager.connect(PROFILE)).rejects.toThrow('No stored password for “Test”');
  });

  it('sends a half-stored wallet profile to the command that fixes it', async () => {
    // Through 0.1.1 this message named an import that did not exist. It names one
    // that does now, and this test is what keeps the two in step.
    const creds = new CredentialStore(storage({ 'auspexlens:p1:password': 'pw' }));
    const manager = new ConnectionManager(creds, async () => new FakeConn('a'));
    const wallet: ProfileConfig = { ...PROFILE, kind: 'wallet', configDir: '/tmp/w' };
    await expect(manager.connect(wallet)).rejects.toThrow('AuspexLens: Import wallet');
  });
});
