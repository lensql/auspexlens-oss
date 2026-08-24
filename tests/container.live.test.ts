/**
 * Container identity against a real container database.
 *
 * Two claims here cannot be made from unit tests, and both are load-bearing:
 *
 *   1. The statement works for an account holding nothing but `CREATE SESSION`
 *      and its SELECT grants. That is what lets the capability be free without
 *      qualification — there is no connection this product opens where it fails.
 *
 *   2. node-oracledb's connection property is **not** equivalent to
 *      `SYS_CONTEXT('USERENV','CON_NAME')` in the CDB root, whatever its
 *      documentation says. This file is where that is asserted against the
 *      driver rather than remembered from a session. If a future release fixes
 *      it, the test that pins the *database's* answer keeps passing and the one
 *      pinning the discrepancy fails loudly — which is the right way round: a
 *      fixed driver should make us re-read this decision, not silently inherit it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type OracleDB from 'oracledb';
import { CONTAINER_SQL, ROOT_CONTAINER, parseContainer, describeContainer } from '../src/engine/container';

const HOST = process.env['AUSPEX_ORACLE_HOST'];
const PORT = process.env['AUSPEX_ORACLE_PORT'] ?? '1521';
const SERVICE = process.env['AUSPEX_ORACLE_SERVICE'] ?? 'FREEPDB1';
const USER = process.env['AUSPEX_ORACLE_USER'] ?? 'auspexlens';
const PASSWORD = process.env['AUSPEX_ORACLE_PASSWORD'] ?? 'auspexlens';

/** The root is reached by its own service, never by switching container. */
const ROOT_SERVICE = process.env['AUSPEX_ORACLE_ROOT_SERVICE'] ?? 'FREE';
const SYS_USER = process.env['AUSPEX_ORACLE_SYS_USER'] ?? 'system';
const SYS_PASSWORD = process.env['AUSPEX_ORACLE_SYS_PASSWORD'] ?? PASSWORD;

let oracledb: typeof OracleDB;
let app: OracleDB.Connection | undefined;
let root: OracleDB.Connection | undefined;
let reachable = false;
let rootReachable = false;
let skipReason = '';

beforeAll(async () => {
  if (!HOST) {
    skipReason = 'AUSPEX_ORACLE_HOST is unset — run this through scripts/mac/test.sh.';
  } else {
    try {
      oracledb = (await import('oracledb')).default;
      app = await oracledb.getConnection({
        user: USER, password: PASSWORD, connectString: `${HOST}:${PORT}/${SERVICE}`,
      });
      reachable = true;
      try {
        root = await oracledb.getConnection({
          user: SYS_USER, password: SYS_PASSWORD, connectString: `${HOST}:${PORT}/${ROOT_SERVICE}`,
        });
        rootReachable = true;
      } catch {
        rootReachable = false;   // non-CDB, or a differently named root service
      }
    } catch (e) {
      skipReason = (e as Error).message.split('\n')[0] ?? String(e);
    }
  }
  if (!reachable) {
    // eslint-disable-next-line no-console
    console.warn(`\n  [live] SKIPPED — ${skipReason}\n`);
  }
}, 60_000);

afterAll(async () => { for (const c of [app, root]) if (c) await c.close(); });

const live = (name: string, fn: () => void | Promise<void>) =>
  it(name, async (ctx) => { if (!reachable) ctx.skip(); await fn(); });

const atRoot = (name: string, fn: () => void | Promise<void>) =>
  it(name, async (ctx) => { if (!reachable || !rootReachable) ctx.skip(); await fn(); });

async function containerOf(conn: OracleDB.Connection) {
  const out = await conn.execute(CONTAINER_SQL);
  return parseContainer((out.rows ?? [])[0] as unknown[]);
}

describe('the least-privileged account can always answer "where am I"', () => {
  live('reads its PDB with no grant beyond CREATE SESSION and SELECT', async () => {
    const info = await containerOf(app!);
    expect(info!.name).toBe(SERVICE.toUpperCase());
    expect(info!.isRoot).toBe(false);
    expect(info!.isContainerDatabase).toBe(true);
    expect(info!.id).toBeGreaterThan(1);
  });

  live('describes it plainly, with no warning to become noise', async () => {
    expect(describeContainer(await containerOf(app!))).toContain(SERVICE.toUpperCase());
  });
});

describe('the CDB root, which is the case worth warning about', () => {
  atRoot('is reported as CDB$ROOT by the database', async () => {
    const info = await containerOf(root!);
    expect(info!.name).toBe(ROOT_CONTAINER);
    expect(info!.id).toBe(1);
    expect(info!.isRoot).toBe(true);
  });

  atRoot('produces a warning that says statements are not scoped to one application', async () => {
    const msg = describeContainer(await containerOf(root!));
    expect(msg).toMatch(/ROOT/);
    expect(msg).toMatch(/not scoped to one application/);
  });

  atRoot("does NOT match the driver's own container property — the measured trap", async () => {
    // The whole reason CONTAINER_SQL exists instead of a property read. Asserted
    // against the driver in front of us, so the claim in the source comment is
    // evidence rather than folklore.
    const info = await containerOf(root!);
    expect(info!.name).toBe(ROOT_CONTAINER);
    expect(root!.pdbName).not.toBe(ROOT_CONTAINER);
    // And it agrees inside a PDB, which is why the discrepancy is easy to miss.
    expect(app!.pdbName).toBe(SERVICE.toUpperCase());
  });
});
