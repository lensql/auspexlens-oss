/**
 * Reading an Oracle wallet, so a user can actually use one.
 *
 * Until 0.1.2 the product advertised wallet connections and shipped no way to
 * supply a wallet: the engine spoke mTLS, `CredentialStore` had a slot for
 * `walletContent`, and nothing ever filled it (docs/RESEARCH.md §17, "el quinto
 * hallazgo"). This module is the missing half, and it is deliberately pure —
 * bytes in, a verdict out — so every branch can be tested without a database, a
 * file picker or an extension host.
 *
 * WHAT ORACLE HANDS THE USER. A wallet downloaded from Autonomous Database is a
 * .zip containing `tnsnames.ora`, `sqlnet.ora`, `cwallet.sso`, `ewallet.p12`,
 * the two JKS stores, `ojdbc.properties` and — in recent downloads —
 * `ewallet.pem`. Thin mode needs exactly two of those: `tnsnames.ora` for the
 * aliases and `ewallet.pem` for the client identity. Oracle's own guide says so,
 * and also warns that a wallet zip may LACK the PEM, in which case it has to be
 * converted from `ewallet.p12` with OpenSSL (Context7, /oracle/node-oracledb,
 * 2026-08-22). Both cases are handled here, and the second one says what to run
 * instead of failing obscurely.
 *
 * WHY THERE IS A ZIP READER IN THIS REPO. The shipped extension has two runtime
 * dependencies and its package is audited for an exact file count. A zip library
 * would be a third dependency for the sake of two files out of nine, so this
 * reads the archive with `node:zlib`, which is built in. The reader is
 * deliberately narrow: it refuses anything it does not fully understand rather
 * than guessing, because the alternative to "unsupported" is a silent wrong
 * answer about a security-relevant file.
 */

import { inflateRawSync } from 'node:zlib';

/** What thin mode actually needs out of a wallet. */
export interface WalletContents {
  /** The PEM, as a string — this is what `walletContent` takes. */
  pem: string;
  /** The text of tnsnames.ora, to be written next to the profile. */
  tnsnames: string;
  /** Aliases offered to the user, in file order. */
  aliases: string[];
  /**
   * Is the private key encrypted, i.e. is there a wallet password to ask for?
   *
   * Measured 2026-08-22, and it is not a detail. A wallet downloaded from
   * Autonomous Database carries an ENCRYPTED PRIVATE KEY and its password is the
   * one set at download time. But the conversion this module recommends for a
   * PEM-less wallet —`openssl pkcs12 … -nodes`, which is Oracle's own
   * instruction— emits a PLAIN `PRIVATE KEY`, so that user has no password at
   * all. Demanding one from them would be asking for something that does not
   * exist. `walletPassword` is documented as needed only "if it is encrypted".
   */
  encrypted: boolean;
}

/** Does this PEM carry a private key, and is it encrypted? */
const hasPrivateKey = (pem: string): boolean => /-----BEGIN (ENCRYPTED |RSA )?PRIVATE KEY-----/.test(pem);
const isEncrypted = (pem: string): boolean => pem.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----');

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

// ---------------------------------------------------------------------------
// The zip reader
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Guards against a wallet that is not a wallet. An Autonomous wallet is ~20 kB;
 *  anything past this is either not a wallet or not something to load into
 *  memory in an editor process. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

/**
 * Read the entries of a zip archive.
 *
 * Only what a wallet needs: no zip64, no encryption, no data descriptors that
 * would require streaming. Each of those is REFUSED by name rather than skipped,
 * so an archive this cannot read produces a sentence a person can act on.
 */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  if (offset === 0xffffffff || entryCount === 0xffff) {
    throw new WalletError('this archive uses the zip64 format, which AuspexLens cannot read. Unzip it and import the folder instead.');
  }

  const out = new Map<string, Buffer>();
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new WalletError('this file is not a readable .zip archive (its directory is damaged).');
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // Bit 0 is the encryption flag. A wallet zip is never encrypted; if this one
    // is, saying so beats handing back bytes that decompress into noise.
    if ((flags & 0x1) !== 0) {
      throw new WalletError(`“${name}” inside this archive is encrypted, which AuspexLens cannot read.`);
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new WalletError(`“${name}” is far larger than any wallet file; this does not look like a wallet.`);
    }

    // Zip slip. Nothing here writes an entry to a path taken from the archive,
    // but the name IS shown to the user and matched against, so a traversing
    // name is refused at the door rather than trusted to stay harmless.
    if (name.includes('..') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
      throw new WalletError(`this archive contains an unsafe path (“${name}”) and was not read.`);
    }

    if (!name.endsWith('/')) {
      out.set(name, extractEntry(buf, localOffset, method, compressedSize, uncompressedSize, name));
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // The EOCD is at the end, after a comment of unknown length, so it is found by
  // scanning backwards. 22 bytes is its minimum size; 0xffff is the largest
  // comment it can declare.
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new WalletError('this file is not a .zip archive.');
}

function extractEntry(
  buf: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
  name: string,
): Buffer {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new WalletError(`“${name}” could not be located inside the archive.`);
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + compressedSize);

  if (method === 0) return Buffer.from(raw);
  if (method === 8) {
    const inflated = inflateRawSync(raw);
    if (uncompressedSize !== 0 && inflated.length !== uncompressedSize) {
      throw new WalletError(`“${name}” did not decompress to its declared size; the archive looks damaged.`);
    }
    return inflated;
  }
  throw new WalletError(`“${name}” uses an unsupported compression method (${method}).`);
}

// ---------------------------------------------------------------------------
// Making sense of what is inside
// ---------------------------------------------------------------------------

/** Match on the basename, because a wallet zip may or may not have a top folder. */
const basename = (p: string): string => p.split('/').pop() ?? p;

/**
 * Pull the aliases out of a tnsnames.ora.
 *
 * An alias is a name at the start of a logical entry, followed by `=`. Anything
 * indented is a continuation of the descriptor above it, and comments start with
 * `#`. This deliberately does not try to parse the descriptor: the product only
 * needs the names, and the driver reads the file itself for everything else.
 */
export function parseTnsAliases(text: string): string[] {
  const aliases: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z0-9_.$-]+)\s*=/.exec(trimmed);
    if (m?.[1]) aliases.push(m[1]);
  }
  return aliases;
}

/**
 * Decide what a set of wallet files gives us, or say exactly what is missing.
 *
 * The two failures worth distinguishing are "you gave me the wrong folder" and
 * "your wallet is one of the ones without a PEM". The second is common, is
 * Oracle's own documented situation, and has a one-line fix — so it gets the
 * one-line fix rather than a shrug.
 */
export function analyseWallet(files: Map<string, Buffer>): WalletContents {
  let pem: Buffer | undefined;
  let p12 = false;
  let tns: Buffer | undefined;

  for (const [path, content] of files) {
    const name = basename(path).toLowerCase();
    if (name === 'ewallet.pem') pem = content;
    else if (name === 'ewallet.p12') p12 = true;
    else if (name === 'tnsnames.ora') tns = content;
  }

  if (!tns) {
    throw new WalletError(
      'no tnsnames.ora here, so this is not an Oracle wallet. Pick the wallet .zip you ' +
        'downloaded from your database, or the folder you unzipped it into.',
    );
  }
  if (!pem) {
    throw new WalletError(
      p12
        ? 'this wallet has ewallet.p12 but no ewallet.pem, and thin mode needs the PEM. ' +
          'Convert it once, in the folder you unzipped the wallet into:\n\n' +
          '    openssl pkcs12 -in ewallet.p12 -out ewallet.pem -nodes\n\n' +
          'then import that folder. (Oracle documents this: some wallet downloads ' +
          'do not include a PEM.)'
        : 'this wallet has no ewallet.pem, which is the file thin mode needs.',
    );
  }

  const tnsnames = tns.toString('utf8');
  const aliases = parseTnsAliases(tnsnames);
  if (aliases.length === 0) {
    throw new WalletError('the tnsnames.ora in this wallet declares no connection aliases.');
  }

  const pemText = pem.toString('utf8');

  // REFUSED HERE BECAUSE THE DRIVER'S OWN ERROR POINTS THE WRONG WAY.
  //
  // `walletContent` is handed to Node's TLS as `cert`, `key` and `ca` at once, so
  // a PEM with no private key dies in the decoder and node-oracledb reports
  // `NJS-505 … Please check if wallet credentials are valid` — blaming the
  // credentials when the problem is that this file never had any. That cost an
  // afternoon against RDS (docs/RESEARCH.md §17.10), and it is exactly the shape
  // a mis-run `openssl pkcs12` conversion produces. Catching it at import turns a
  // baffling connection failure into a sentence about the file the user just
  // picked.
  if (!hasPrivateKey(pemText)) {
    throw new WalletError(
      'the ewallet.pem in this wallet contains no private key, so it cannot identify ' +
        'you to the database. If you converted it yourself, the conversion dropped the ' +
        'key — repeat it with:\n\n' +
        '    openssl pkcs12 -in ewallet.p12 -out ewallet.pem -nodes\n',
    );
  }

  return { pem: pemText, tnsnames, aliases, encrypted: isEncrypted(pemText) };
}
