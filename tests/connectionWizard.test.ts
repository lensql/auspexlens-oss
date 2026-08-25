/**
 * The connection wizard's pure half.
 *
 * The multi-step QuickInput cannot be driven from a unit test, and does not need
 * to be: what breaks is the validation, the defaults and the profile that comes
 * out — and all three are functions of their arguments. That split is the reason
 * this file can exist at all.
 *
 * The case that matters most is the last one in the validation block. A person
 * with a connect string in front of them pastes the whole thing into the first
 * box, every time, and a wizard that accepts it produces a profile that fails
 * later with an error about the host.
 */
import { describe, it, expect } from 'vitest';
import {
  connectionKinds, defaultsFor, hintFor, validateAnswers, buildProfile, slug,
  describeProfile, type WizardAnswers,
} from '../src/ui/connectionWizard';

const good: WizardAnswers = {
  label: 'Sales (production)', host: 'db.example.com', port: '1521',
  service: 'ORCLPDB1', user: 'app_reader',
};

describe('the choices offered', () => {
  it('covers the three ways an Oracle connection is described', () => {
    expect(connectionKinds().map((k) => k.id))
      .toEqual(['easy-connect', 'wallet', 'tns-alias']);
  });

  it('puts a codicon and a plain-language detail on each', () => {
    for (const k of connectionKinds()) {
      expect(k.label, k.id).toMatch(/^\$\([a-z-]+\)/);
      expect(k.detail.length, k.id).toBeGreaterThan(20);
    }
  });

  it('asks the wallet kind for nothing, because the import command owns it', () => {
    // A second implementation of the wallet flow would be a second thing to get
    // wrong: `importWallet` already reads the zip, writes tnsnames.ora and puts
    // the key in the OS keychain.
    expect(connectionKinds().find((k) => k.id === 'wallet')!.asks).toEqual([]);
  });

  it('proposes the port every Oracle listener uses', () => {
    expect(defaultsFor('easy-connect')['port']).toBe('1521');
  });

  it('gives every field it asks for a hint with a real example', () => {
    for (const k of connectionKinds()) {
      for (const f of k.asks) {
        expect(hintFor(f).trim(), `${k.id}/${f}`).not.toBe('');
      }
    }
    // And the hints teach the distinction Oracle users get wrong.
    expect(hintFor('service')).toMatch(/not the SID/);
  });
});

describe('validation reports everything, not the first thing', () => {
  it('accepts a complete answer', () => {
    expect(validateAnswers('easy-connect', good)).toEqual([]);
  });

  it('lists every missing field at once', () => {
    // A wizard that reports one error at a time makes the user run it three
    // times to learn three things.
    const errors = validateAnswers('easy-connect', {});
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.join(' ')).toMatch(/name for this connection/);
    expect(errors.join(' ')).toMatch(/host/);
    expect(errors.join(' ')).toMatch(/service name/);
  });

  it('catches the whole connect string pasted into the host box', () => {
    // The commonest mistake by a distance: someone has `db:1521/ORCL` in front
    // of them and puts all of it in the first field.
    for (const host of ['db.example.com:1521/ORCLPDB1', 'db.example.com:1521', 'db/ORCL']) {
      const errors = validateAnswers('easy-connect', { ...good, host });
      expect(errors.join(' '), host).toMatch(/just the hostname/);
    }
  });

  it('refuses a port that is not a port', () => {
    for (const port of ['0', '70000', '-1', 'abc', '15.21', '']) {
      expect(validateAnswers('easy-connect', { ...good, port }).join(' '), port)
        .toMatch(/whole number between 1 and 65535/);
    }
  });

  it('asks a TNS profile for its alias and its directory', () => {
    const errors = validateAnswers('tns-alias', { label: 'X' });
    expect(errors.join(' ')).toMatch(/TNS alias/);
    expect(errors.join(' ')).toMatch(/tnsnames\.ora/);
  });
});

describe('the profile that comes out', () => {
  it('assembles Easy Connect from the three fields', () => {
    const p = buildProfile('easy-connect', good);
    expect(p.connectString).toBe('db.example.com:1521/ORCLPDB1');
    expect(p.kind).toBe('basic');
    expect(p.user).toBe('app_reader');
    expect(p.label).toBe('Sales (production)');
  });

  it('builds a wallet profile from an alias and a directory', () => {
    const p = buildProfile('tns-alias', {
      label: 'ADB', alias: 'mydb_high', configDir: '/w/mydb', user: 'admin',
    });
    expect(p.kind).toBe('wallet');
    expect(p.connectString).toBe('mydb_high');
    expect(p.configDir).toBe('/w/mydb');
  });

  it('derives the id from the label instead of asking for one', () => {
    // An id is a detail of how this product stores things. Asking a user to
    // invent one is asking them to care about our storage.
    expect(buildProfile('easy-connect', good).id).toBe('sales-production');
    expect(slug('  Ventas — MÉXICO  ')).toBe('ventas-m-xico');
    expect(slug('!!!')).toBe('connection');
  });

  it('never silently replaces an existing profile', () => {
    expect(buildProfile('easy-connect', good, ['sales-production']).id).toBe('sales-production-2');
    expect(buildProfile('easy-connect', good, ['sales-production', 'sales-production-2']).id)
      .toBe('sales-production-3');
  });

  it('trims what the user typed', () => {
    const p = buildProfile('easy-connect', { ...good, host: '  db.example.com  ', user: ' app ' });
    expect(p.connectString).toBe('db.example.com:1521/ORCLPDB1');
    expect(p.user).toBe('app');
  });

  it('refuses to build from answers that do not validate', () => {
    // The caller has already shown the errors; building anyway is how a broken
    // profile reaches settings.json and fails somewhere else entirely.
    expect(() => buildProfile('easy-connect', { label: 'X' })).toThrow();
    expect(() => buildProfile('easy-connect', { ...good, port: '0' })).toThrow(/65535/);
  });
});

describe('choosing between two connections', () => {
  it('describes a profile by what distinguishes it', () => {
    // "Sales" against "Sales copy" is exactly the pair where picking wrong costs
    // most, and the label alone cannot separate them.
    const basic = describeProfile(buildProfile('easy-connect', good));
    expect(basic.label).toBe('Sales (production)');
    expect(basic.description).toBe('app_reader@db.example.com:1521/ORCLPDB1');
  });

  it('marks a wallet profile as one, since its connect string is only an alias', () => {
    const p = buildProfile('tns-alias', {
      label: 'ADB', alias: 'mydb_high', configDir: '/w', user: 'admin',
    });
    expect(describeProfile(p).description).toMatch(/\(wallet\)$/);
  });
});
