import { describe, it, expect } from 'vitest';
import { buildConnectConfig, assertThin } from '../src/engine/connection';

/**
 * Unit coverage for the file that builds every connection.
 *
 * Until 0.1.2 this file was exercised ONLY by the live suites — and the TLS one
 * skips unless `scripts/mac/tls-test.sh` has stood a TCPS server up. So the
 * default gate had no opinion at all about the config the product sends, which
 * is how a parameter the driver does not have survived to a published release.
 */

const basic = {
  kind: 'basic' as const,
  user: 'auspex_test',
  password: 'pw',
  connectString: 'localhost:1521/FREEPDB1',
};

const wallet = {
  kind: 'wallet' as const,
  user: 'admin',
  password: 'pw',
  connectString: 'db_high',
  configDir: '/opt/wallet',
  walletContent: '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  walletPassword: 'wp',
};

describe('buildConnectConfig', () => {
  it('carries the basic credentials through unchanged', () => {
    const cfg = buildConnectConfig({ credentials: basic });
    expect(cfg).toEqual({
      user: 'auspex_test',
      password: 'pw',
      connectString: 'localhost:1521/FREEPDB1',
    });
  });

  it('adds the three wallet properties, and only for a wallet', () => {
    const cfg = buildConnectConfig({ credentials: wallet });
    expect(cfg['configDir']).toBe('/opt/wallet');
    expect(cfg['walletContent']).toBe('-----BEGIN ENCRYPTED PRIVATE KEY-----');
    expect(cfg['walletPassword']).toBe('wp');
  });

  it('sends NO sslVerifyCertificate — the driver has no such parameter', () => {
    // Measured against node-oracledb 7.0.1 (RESEARCH §17.9): getConnection
    // accepts and discards unknown properties, so sending this looked explicit
    // and did nothing. If it ever comes back, it should come back with evidence
    // that the driver grew it.
    expect(buildConnectConfig({ credentials: basic })).not.toHaveProperty('sslVerifyCertificate');
    expect(
      buildConnectConfig({ credentials: basic, rejectUnauthorized: true }),
    ).not.toHaveProperty('sslVerifyCertificate');
  });

  it('accepts rejectUnauthorized: true, which is the only value there is', () => {
    expect(() => buildConnectConfig({ credentials: basic, rejectUnauthorized: true })).not.toThrow();
    expect(() => buildConnectConfig({ credentials: basic })).not.toThrow();
  });

  it('refuses rejectUnauthorized: false instead of ignoring it', () => {
    expect(() => buildConnectConfig({ credentials: basic, rejectUnauthorized: false }))
      .toThrow(/cannot be switched off/);
  });

  it('the refusal names the route that actually works', () => {
    // A refusal that only says no leaves the user stuck on a self-signed server.
    // NODE_EXTRA_CA_CERTS is the variant measured to connect against RDS (§17.10).
    try {
      buildConnectConfig({ credentials: basic, rejectUnauthorized: false });
      throw new Error('it should have refused');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/NODE_EXTRA_CA_CERTS/);
      expect(msg).toMatch(/thin mode/);
    }
  });

  it('refuses a wallet connection just the same', () => {
    expect(() => buildConnectConfig({ credentials: wallet, rejectUnauthorized: false }))
      .toThrow(/cannot be switched off/);
  });
});

describe('assertThin', () => {
  it('passes in thin mode', () => {
    expect(() => assertThin({ thin: true })).not.toThrow();
  });

  it('refuses thick mode, because that is the promise the product makes', () => {
    expect(() => assertThin({ thin: false })).toThrow(/thick mode/);
  });
});
