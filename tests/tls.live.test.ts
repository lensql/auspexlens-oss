/**
 * The suite that talks to a real Oracle database over TLS, with a client
 * certificate — alternative C of PLAN.md §E.1.
 *
 * WHY IT EXISTS. `WalletCredentials` in src/engine/connection.ts — configDir,
 * walletContent, walletPassword — was written against Oracle's documentation and
 * had never met a server that asks for a client certificate. Code that has only
 * been read is code that has not been tested, and this is the part of the product
 * a buyer with an Autonomous Database reaches for first.
 *
 * THE SECOND CASE IS THE ONE THAT MATTERS. If the server does not refuse a
 * client that brings no certificate, then SSL_CLIENT_AUTHENTICATION never took
 * effect, mutual TLS is not what is being measured, and every other case here is
 * quietly testing ordinary one-way TLS while looking identical. It is not "one
 * more assertion": it is what licenses the other six to mean anything.
 *
 * It is also the case that has already been wrong twice — once measuring a
 * client-side decoding failure, once measuring a listener handshake that never
 * sees the check. Both dead ends are written out on the case itself, because a
 * test that licenses six others is the one test that cannot be taken on trust.
 *
 * The server is set up by scripts/mac/tls-test.sh; run this through that script.
 * Like oracle.live.test.ts it skips LOUDLY rather than silently — a suite that
 * reports "7 skipped" next to a healthy database is one careless glance away
 * from "7 passed".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildConnectConfig } from '../src/engine/connection';
import { executeReadOnly, beginReadOnly } from '../src/engine/readOnly';
import { SqlGuardError } from '../src/engine/sqlGuard';
import type OracleDB from 'oracledb';

const TLS_DIR = process.env['AUSPEX_TLS_DIR'];
const TCPS_PORT = process.env['AUSPEX_ORACLE_TCPS_PORT'] ?? '2484';
const USER = process.env['AUSPEX_ORACLE_USER'] ?? 'auspexlens';
const PASSWORD = process.env['AUSPEX_ORACLE_PASSWORD'] ?? 'auspexlens';

// Written by scripts/tls/make-pki.sh next to the wallets it describes. Read
// rather than hardcoded so the descriptor, the certificate and this file cannot
// drift apart — the DN especially, which nobody would notice going stale.
const readEnvFile = (path: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      // Values are quoted in the file because the server DN carries commas and a
      // space; strip the quotes here rather than making the file harder to source.
      .map((l) => [
        l.slice(0, l.indexOf('=')),
        l.slice(l.indexOf('=') + 1).replace(/^"(.*)"$/, '$1'),
      ]),
  );

let oracledb: typeof OracleDB;
let reachable = false;
let skipReason = '';
let walletPassword = '';
let wallets: Record<'good' | 'noCert' | 'badCa', string> = { good: '', noCert: '', badCa: '' };
let conn: OracleDB.Connection | undefined;

/** Every case builds its config through the product's own function. A test that
 *  assembled its own oracledb config would prove that oracledb can do mTLS, not
 *  that AuspexLens can. */
const walletConfig = (
  alias: string,
  content: string,
  overrides: { rejectUnauthorized?: boolean; walletPassword?: string } = {},
): Record<string, unknown> =>
  buildConnectConfig({
    credentials: {
      kind: 'wallet',
      user: USER,
      password: PASSWORD,
      connectString: alias,
      configDir: TLS_DIR!,
      walletContent: content,
      walletPassword: overrides.walletPassword ?? walletPassword,
    },
    ...(overrides.rejectUnauthorized === undefined
      ? {}
      : { rejectUnauthorized: overrides.rejectUnauthorized }),
  });

/** Returns the first line of the failure, or the sentinel when it connected —
 *  so a test that expects a refusal reports WHAT happened instead of `false`. */
const refusalFor = async (config: Record<string, unknown>): Promise<string> => {
  let c: OracleDB.Connection | undefined;
  try {
    c = await oracledb.getConnection(config);
    return 'CONNECTED';
  } catch (e) {
    return (e as Error).message.split('\n')[0] ?? String(e);
  } finally {
    if (c) await c.close();
  }
};

beforeAll(async () => {
  if (!TLS_DIR) {
    skipReason = 'AUSPEX_TLS_DIR is unset — run this through scripts/mac/tls-test.sh.';
  } else if (!existsSync(join(TLS_DIR, 'ewallet.pem'))) {
    skipReason = `${TLS_DIR} has no ewallet.pem — scripts/tls/make-pki.sh has not run.`;
  } else {
    try {
      walletPassword = readEnvFile(join(TLS_DIR, 'pki.env'))['AUSPEX_TLS_WALLET_PWD'] ?? '';
      wallets = {
        good: readFileSync(join(TLS_DIR, 'ewallet.pem'), 'utf8'),
        noCert: readFileSync(join(TLS_DIR, 'wallet-nocert.pem'), 'utf8'),
        badCa: readFileSync(join(TLS_DIR, 'wallet-badca.pem'), 'utf8'),
      };
      oracledb = (await import('oracledb')).default;
      conn = await oracledb.getConnection(walletConfig('AUSPEX_TCPS', wallets.good));
      reachable = true;
    } catch (e) {
      skipReason = (e as Error).message.split('\n')[0] ?? String(e);
    }
  }

  if (!reachable) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n  [tls] SKIPPED — no TCPS server with mutual TLS to talk to:` +
        `\n         ${skipReason}` +
        `\n         scripts/mac/tls-test.sh builds one from scratch.\n`,
    );
  }
}, 90_000);

afterAll(async () => {
  if (conn) await conn.close();
});

const live = (name: string, fn: () => void | Promise<void>) =>
  it(name, async (ctx) => {
    if (!reachable) ctx.skip();
    await fn();
  });

describe('TCPS with a client certificate, against a real listener', () => {
  live('1 · connects over TCPS with the right CA and certificate verification ON', async () => {
    const rows = await executeReadOnly(conn!, 'SELECT 1 AS one FROM dual');
    expect(rows.rows[0]?.[0]).toBe(1);

    // The config the product builds, checked for shape rather than for effect:
    // there is no verification switch to inspect (case 6 measures why), so what
    // this pins is that the wallet arrives as an encrypted PEM —
    // which is what makes walletPassword a real parameter rather than an ignored
    // one, and is the shape an Autonomous Database wallet has.
    const cfg = walletConfig('AUSPEX_TCPS', wallets.good);
    expect(cfg['walletContent']).toContain('ENCRYPTED PRIVATE KEY');

    // And the transport really is the encrypted one, said by the server rather
    // than by us: NETWORK_PROTOCOL comes from Oracle's own session context.
    const proto = await executeReadOnly(
      conn!,
      "SELECT SYS_CONTEXT('USERENV','NETWORK_PROTOCOL') AS p FROM dual",
    );
    expect(String(proto.rows[0]?.[0]).toLowerCase()).toBe('tcps');
  });

  live('2 · WITHOUT a client certificate the server REFUSES — the case that licenses the rest', async () => {
    // THIS CASE HAS BEEN WRONG TWICE, AND BOTH WAYS ARE WORTH KEEPING.
    //
    // First it asked the question through the driver: hand node-oracledb a wallet
    // holding only the CA and watch it fail. It failed with `NJS-505: unable to
    // initiate TLS connection. Please check if wallet credentials are valid`,
    // which reads exactly like a server refusing an anonymous client. It was not.
    // Alternative A produced the SAME error from AWS RDS, which demands nothing —
    // impossible if the message meant what it says. Thin mode passes
    // walletContent to tls.createSecureContext as `cert`, `key` AND `ca` at once,
    // so a PEM with no private key dies at `DECODER routines::unsupported` before
    // a packet is sent.
    //
    // Then it asked at the raw TLS layer — tls.connect with a CA and no client
    // identity — expecting the handshake to fail. IT SUCCEEDS. Oracle's LISTENER
    // completes the first handshake without demanding anything; the certificate is
    // demanded on the renegotiated handshake with the dedicated server process
    // after the handoff. A raw socket test never reaches that, so it cannot see
    // SSL_CLIENT_AUTHENTICATION at all.
    //
    // What is left is the only formulation that can distinguish the cases: a FULL
    // Oracle connection, trusting the CA through the ambient store so no wallet is
    // involved, and therefore presenting no client certificate.
    expect(
      process.env['NODE_EXTRA_CA_CERTS'],
      'NODE_EXTRA_CA_CERTS must carry the test CA, or the anonymous attempt below ' +
        'fails because it cannot verify the server and proves nothing.',
    ).toBeTruthy();

    const anonymous = await refusalFor({
      user: USER,
      password: PASSWORD,
      connectString: 'AUSPEX_TCPS',
      configDir: TLS_DIR!,
      connectTimeout: 15,
    });
    expect(anonymous).not.toBe('CONNECTED');

    // The REASON is the assertion, not the failure. "Terminated unexpectedly" is
    // the server hanging up on a session with no certificate; a certificate or
    // handshake error would mean the client could not verify the SERVER, which is
    // a different test that would pass for the wrong reason.
    expect(anonymous).toMatch(/NJS-50[01]/);
    expect(anonymous).not.toMatch(/self-signed|unable to (get|verify)/i);

    // The control, and it is not optional: same host, same alias, same CA, one
    // thing added — a client identity. Without it, the refusal above could be any
    // kind of broken.
    const identified = await oracledb.getConnection(walletConfig('AUSPEX_TCPS', wallets.good));
    await identified.close();

    // eslint-disable-next-line no-console
    console.log(`  [tls] no client certificate -> ${anonymous}`);

    // And the driver fact that caused the first wrong version, pinned so it
    // cannot quietly change. It is not cosmetic: it is why AWS's global-bundle.pem
    // cannot be used as walletContent, which is half the answer to
    // node-oracledb#1593 (docs/RESEARCH.md §17.10).
    const caOnly = await refusalFor(walletConfig('AUSPEX_TCPS', wallets.noCert));
    expect(caOnly).toMatch(/NJS-505/);
    // eslint-disable-next-line no-console
    console.log(`  [tls] CA-only wallet through the driver -> ${caOnly}`);
  });

  live('3 · walletContent as a STRING is the path SecretStorage uses', async () => {
    // The product never writes a wallet to disk: it keeps the PEM in VS Code's
    // SecretStorage and hands it over as a string. walletLocation would read the
    // same bytes off the filesystem and would not test the shipped path.
    const cfg = walletConfig('AUSPEX_TCPS', wallets.good);
    expect(typeof cfg['walletContent']).toBe('string');
    expect(cfg['walletLocation']).toBeUndefined();

    const c = await oracledb.getConnection(cfg);
    try {
      const rows = await executeReadOnly(c, 'SELECT COUNT(*) AS n FROM demo_customers');
      expect(Number(rows.rows[0]?.[0])).toBeGreaterThan(0);
    } finally {
      await c.close();
    }
  });

  live('4 · the WRONG CA is refused, with a valid client certificate held constant', async () => {
    // Same client identity as case 1, different trust anchor. Holding the client
    // half fixed is what makes this a test of server verification rather than a
    // second, blurrier version of case 2.
    const outcome = await refusalFor(walletConfig('AUSPEX_TCPS', wallets.badCa));
    expect(outcome).not.toBe('CONNECTED');
    // eslint-disable-next-line no-console
    console.log(`  [tls] wrong CA -> ${outcome}`);
  });

  live('5 · a DN that does not match is refused — and the SAME DN across lines is refused too, which is a driver defect', async () => {
    const bad = await refusalFor(walletConfig('AUSPEX_TCPS_BADDN', wallets.good));
    expect(bad).not.toBe('CONNECTED');
    // eslint-disable-next-line no-console
    console.log(`  [tls] wrong SSL_SERVER_CERT_DN -> ${bad}`);

    // The other half, without which the rejection above could be a broken
    // descriptor rather than a working check: the certificate's real DN connects.
    const good = await oracledb.getConnection(walletConfig('AUSPEX_TCPS_DN', wallets.good));
    await good.close();

    // And the finding this case exists to keep measuring, from 2026-08-22.
    //
    // AUSPEX_TCPS_DN_MULTILINE carries the SAME DN, quoted the same way, wrapped
    // across lines the way a person writes a tnsnames.ora. It does not connect.
    // node-oracledb 7.0.1 thin strips ALL whitespace from every continuation line
    // of an entry — lib/thin/sqlnet/paramParser.js:140, line.replace(/\s+/g, '') —
    // so `O=AuspexLens Test` reaches the matcher as `O=AuspexLensTest` and
    // NJS-507 blames the certificate for a parser's edit.
    //
    // It matters to this product specifically: every real Oracle DN has spaces
    // in it, and an Autonomous Database wallet is reached exactly this way,
    // through configDir and a TNS alias. ADB's own tnsnames.ora escapes the bug
    // by writing each alias on ONE line — which is luck, not design.
    //
    // THIS ASSERTION IS A CANARY AND IS MEANT TO FAIL ONE DAY. When a driver
    // release fixes the parser, this line goes red: that is the signal to update
    // docs/RESEARCH.md §17.9, the upstream issue, and then delete the case.
    const multiline = await refusalFor(walletConfig('AUSPEX_TCPS_DN_MULTILINE', wallets.good));
    expect(
      multiline,
      'the multi-line DN now CONNECTS — node-oracledb fixed paramParser.js. ' +
        'Update RESEARCH.md §17.9 and drop this assertion.',
    ).not.toBe('CONNECTED');
    // eslint-disable-next-line no-console
    console.log(`  [tls] same DN, written across lines -> ${multiline}`);
  });

  live('6 · certificate verification CANNOT be switched off — and the product now says so', async () => {
    // What the runbook expected: rejectUnauthorized:false connects to a server
    // whose CA is unknown, and that fact goes into residual risk.
    //
    // What was measured on 2026-08-22: it does not, because there is nothing to
    // switch off. `sslVerifyCertificate` — which buildConnectConfig sets from
    // rejectUnauthorized — is NOT a node-oracledb parameter. It appears nowhere
    // in the driver's lib/ and nowhere in @types/oracledb, and getConnection
    // silently accepts and ignores unknown properties (verified by handing it a
    // deliberately bogus one). Thin mode passes rejectUnauthorized:true to
    // Node's TLS as a literal, in both the initial handshake and the
    // renegotiation after the listener hands off — ntTcp.js tlsConnect().
    //
    // So the transport is SAFER than documented and the setting is a promise the
    // product cannot keep. Which of those two facts to act on is a decision for
    // Diego, not for this test: it is code inside a published .vsix. Recorded in
    // docs/SECURITY-ARCHITECTURE.md and docs/RESEARCH.md §17.9.
    // Since 0.1.2 the product refuses the setting instead of passing a parameter
    // the driver discards. The refusal names the route that DOES work.
    expect(() => walletConfig('AUSPEX_TCPS', wallets.badCa, { rejectUnauthorized: false }))
      .toThrow(/cannot be switched off/);
    expect(() => walletConfig('AUSPEX_TCPS', wallets.badCa, { rejectUnauthorized: false }))
      .toThrow(/NODE_EXTRA_CA_CERTS/);

    // THE CANARY. Verification is still on with the setting left alone, so an
    // unknown CA is still refused BY THE DRIVER. If this ever connects, thin mode
    // stopped verifying and the reasoning in SECURITY-ARCHITECTURE.md (T9) is
    // stale — re-read it before assuming that is an improvement.
    const outcome = await refusalFor(walletConfig('AUSPEX_TCPS', wallets.badCa));
    expect(outcome).not.toBe('CONNECTED');
    expect(outcome).toMatch(/self-signed certificate|NJS-506/);
    // eslint-disable-next-line no-console
    console.log(`  [tls] an unknown CA, verification unavoidable -> ${outcome}`);
  });

  live('7 · the guard, per-statement read-only and PII masking all still hold over TLS', async () => {
    // Changing transport must not loosen anything. Each of the three is checked
    // through the same entry point the editor, the grid, the exports and the MCP
    // server use — not through a private helper that only this test calls.
    await expect(executeReadOnly(conn!, 'DROP TABLE demo_orders')).rejects.toBeInstanceOf(
      SqlGuardError,
    );

    // A read-only transaction opened by hand, then a statement through the
    // executor — which rolls back and re-opens one of its own. That the second
    // call works at all is the per-statement discipline of CLAUDE.md §2 holding
    // over TCPS: SET TRANSACTION must be the first statement of a transaction,
    // and a plain SELECT leaves one open.
    await beginReadOnly(conn!, true);
    const after = await executeReadOnly(conn!, 'SELECT 1 AS one FROM dual');
    expect(after.rows[0]?.[0]).toBe(1);

    // Masking is the engine's default policy, not a flag this test turns on —
    // if it had to be asked for, every caller that forgot would leak.
    const masked = await executeReadOnly(conn!, 'SELECT email FROM demo_customers ORDER BY id');
    expect(String(masked.rows[0]?.[0])).not.toContain('ada@example.invalid');
    expect(String(masked.rows[0]?.[0])).toMatch(/•/);
    expect(masked.masked.columns).toEqual(['EMAIL']);
  });
});
