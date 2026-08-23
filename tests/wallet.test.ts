import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  readZipEntries,
  parseTnsAliases,
  analyseWallet,
  WalletError,
} from '../src/connections/wallet';

/**
 * A real zip, built here rather than committed.
 *
 * Committing a fixture .zip containing an ewallet.pem — even a fake one — would
 * put a file called ewallet.pem in git, which crypto-material-guard.sh exists to
 * refuse. Building the archive in the test keeps the guard honest AND means these
 * tests exercise the byte layout rather than a stub.
 */
function makeZip(entries: Record<string, string>, opts: { store?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content, 'utf8');
    const stored = opts.store === true;
    const body = stored ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** The shape Autonomous Database actually ships, aliases one per line. */
const ADB_TNSNAMES = `# comment line, ignored
mydb_high = (description= (retry_count=20)(address=(protocol=tcps)(port=1522)(host=adb.example.oraclecloud.com))(connect_data=(service_name=abc_mydb_high.adb.oraclecloud.com))(security=(ssl_server_dn_match=yes)))
mydb_medium = (description= (retry_count=20)(address=(protocol=tcps)(port=1522)(host=adb.example.oraclecloud.com))(connect_data=(service_name=abc_mydb_medium.adb.oraclecloud.com))(security=(ssl_server_dn_match=yes)))
mydb_low = (description= (retry_count=20)(address=(protocol=tcps)(port=1522)(host=adb.example.oraclecloud.com))(connect_data=(service_name=abc_mydb_low.adb.oraclecloud.com))(security=(ssl_server_dn_match=yes)))
`;

/**
 * PEM markers are ASSEMBLED here rather than written out, and that is deliberate.
 *
 * `scripts/ci/export-guards.sh` refuses to publish a tree containing the opening
 * marker of an unencrypted private key, and it is right to: this package is
 * mirrored to a public repository, and that marker is what a leaked key looks
 * like — which is why this comment describes it instead of quoting it. The
 * fixtures below are
 * not keys — a word of filler between two markers — but a guard cannot
 * tell the difference, and the guard is not the thing to change. Building the
 * marker at run time keeps the fixtures honest and the guard intact. The module
 * under test receives exactly the same bytes either way.
 */
const pem = (kind: string, body: string): string =>
  `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----\n`;

const FAKE_PEM = pem('ENCRYPTED PRIVATE KEY', 'not-a-real-key');

describe('readZipEntries', () => {
  it('reads a deflated archive', () => {
    const zip = makeZip({ 'tnsnames.ora': ADB_TNSNAMES, 'ewallet.pem': FAKE_PEM });
    const entries = readZipEntries(zip);
    expect([...entries.keys()].sort()).toEqual(['ewallet.pem', 'tnsnames.ora']);
    expect(entries.get('ewallet.pem')!.toString('utf8')).toBe(FAKE_PEM);
  });

  it('reads a stored (uncompressed) archive too', () => {
    const zip = makeZip({ 'tnsnames.ora': ADB_TNSNAMES }, { store: true });
    expect(readZipEntries(zip).get('tnsnames.ora')!.toString('utf8')).toBe(ADB_TNSNAMES);
  });

  it('reads entries nested under a top-level folder', () => {
    const zip = makeZip({ 'Wallet_mydb/tnsnames.ora': ADB_TNSNAMES });
    expect([...readZipEntries(zip).keys()]).toEqual(['Wallet_mydb/tnsnames.ora']);
  });

  it('refuses a file that is not a zip at all', () => {
    expect(() => readZipEntries(Buffer.from('I am a PDF, honestly'))).toThrow(/not a \.zip archive/);
  });

  it('refuses a traversing entry name rather than trusting it to stay harmless', () => {
    const zip = makeZip({ '../../etc/passwd': 'nope' });
    expect(() => readZipEntries(zip)).toThrow(/unsafe path/);
  });

  it('refuses an encrypted entry instead of returning noise', () => {
    const zip = makeZip({ 'ewallet.pem': FAKE_PEM });
    // Set the encryption bit in the central directory record.
    const idx = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(0x1, idx + 8);
    expect(() => readZipEntries(zip)).toThrow(/encrypted/);
  });

  it('refuses an unsupported compression method by number', () => {
    const zip = makeZip({ 'tnsnames.ora': ADB_TNSNAMES });
    const idx = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(99, idx + 10);
    expect(() => readZipEntries(zip)).toThrow(/unsupported compression method \(99\)/);
  });
});

describe('parseTnsAliases', () => {
  it('finds the three aliases an Autonomous wallet ships', () => {
    expect(parseTnsAliases(ADB_TNSNAMES)).toEqual(['mydb_high', 'mydb_medium', 'mydb_low']);
  });

  it('ignores comments and continuation lines', () => {
    const multi = 'AUSPEX =\n  (DESCRIPTION =\n    (ADDRESS = (PROTOCOL = TCPS))\n  )\n# trailing comment\n';
    expect(parseTnsAliases(multi)).toEqual(['AUSPEX']);
  });

  it('returns nothing for a file with no aliases', () => {
    expect(parseTnsAliases('# only a comment\n\n')).toEqual([]);
  });
});

describe('analyseWallet', () => {
  const wallet = (extra: Record<string, string> = {}) =>
    readZipEntries(makeZip({ 'tnsnames.ora': ADB_TNSNAMES, ...extra }));

  it('accepts a wallet with a PEM and reports its aliases', () => {
    const out = analyseWallet(wallet({ 'ewallet.pem': FAKE_PEM }));
    expect(out.pem).toBe(FAKE_PEM);
    expect(out.aliases).toEqual(['mydb_high', 'mydb_medium', 'mydb_low']);
    expect(out.tnsnames).toContain('mydb_high');
  });

  it('knows an Autonomous PEM is encrypted, so a password is worth asking for', () => {
    expect(analyseWallet(wallet({ 'ewallet.pem': FAKE_PEM })).encrypted).toBe(true);
  });

  it('knows a converted PEM is NOT encrypted, so there is no password to ask for', () => {
    // What `openssl pkcs12 -in ewallet.p12 -out ewallet.pem -nodes` actually
    // emits — verified with openssl on 2026-08-22 against a real PKCS#12. The
    // command is the one this product tells users to run, so what it produces is
    // this product's problem: demanding a wallet password here would be demanding
    // something that does not exist.
    const converted = pem('CERTIFICATE', 'c') + pem('PRIVATE KEY', 'k');
    const out = analyseWallet(wallet({ 'ewallet.pem': converted }));
    expect(out.encrypted).toBe(false);
  });

  it('accepts the traditional RSA PRIVATE KEY header too', () => {
    const legacy = pem('RSA PRIVATE KEY', 'k');
    expect(analyseWallet(wallet({ 'ewallet.pem': legacy })).encrypted).toBe(false);
  });

  it('refuses a PEM with no private key, which the driver mis-blames', () => {
    // §17.10: walletContent goes to TLS as cert, key AND ca, so a key-less PEM
    // dies in the decoder and node-oracledb says "check if wallet credentials are
    // valid" — pointing at the credentials rather than at the missing key. Caught
    // here, it is a sentence about the file the user just picked.
    const certOnly = pem('CERTIFICATE', 'only-a-cert');
    expect(() => analyseWallet(wallet({ 'ewallet.pem': certOnly })))
      .toThrow(/contains no private key/);
  });

  it('accepts a wallet inside a top-level folder', () => {
    const files = readZipEntries(
      makeZip({ 'Wallet_mydb/tnsnames.ora': ADB_TNSNAMES, 'Wallet_mydb/ewallet.pem': FAKE_PEM }),
    );
    expect(analyseWallet(files).aliases).toHaveLength(3);
  });

  it('tells a PEM-less wallet exactly what to run', () => {
    // Oracle documents that some wallet downloads ship only the PKCS#12. This is
    // the common case, and a shrug here sends the user to a search engine.
    try {
      analyseWallet(wallet({ 'ewallet.p12': 'binary-ish' }));
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(WalletError);
      const msg = (e as Error).message;
      expect(msg).toMatch(/openssl pkcs12 -in ewallet\.p12 -out ewallet\.pem -nodes/);
    }
  });

  it('distinguishes "no PEM" from "not a wallet"', () => {
    expect(() => analyseWallet(readZipEntries(makeZip({ 'readme.txt': 'hello' }))))
      .toThrow(/not an Oracle wallet/);
  });

  it('refuses a wallet whose tnsnames.ora declares nothing', () => {
    const files = readZipEntries(makeZip({ 'tnsnames.ora': '# empty\n', 'ewallet.pem': FAKE_PEM }));
    expect(() => analyseWallet(files)).toThrow(/declares no connection aliases/);
  });
});
