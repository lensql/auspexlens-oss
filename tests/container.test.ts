/**
 * Container identity — the free half of the multitenant story.
 *
 * The parsing here is small, and the tests are not about the parsing. They are
 * about the three answers this product must never confuse: a PDB, the root of a
 * CDB, and a database that has no containers at all. Getting the second one
 * wrong is the expensive case — it tells someone their statement is scoped to an
 * application when it is scoped to the instance.
 */
import { describe, it, expect } from 'vitest';
import {
  CONTAINER_SQL, ROOT_CONTAINER, parseContainer, describeContainer,
  shortContainerLabel,
} from '../src/engine/container';

const pdb = parseContainer(['FREEPDB1', '3', 'FREE']);
const root = parseContainer([ROOT_CONTAINER, '1', 'FREE']);
const nonCdb = parseContainer(['ORCL', '0', 'ORCL']);

describe('the statement itself', () => {
  it('asks the database rather than reading a driver property', () => {
    // Measured 2026-08-23: in the CDB root, node-oracledb's connection property
    // returns the database name, not CDB$ROOT. The product must not depend on it.
    expect(CONTAINER_SQL).toContain("SYS_CONTEXT('USERENV','CON_NAME')");
  });

  it('needs no privilege, so it carries no grant and no bind', () => {
    // SYS_CONTEXT reads the session's own environment. If this ever grew a join
    // to a V$ view it would stop working for the least-privileged account, which
    // is the account this product tells people to use.
    expect(CONTAINER_SQL.toLowerCase()).not.toContain('v$');
    expect(CONTAINER_SQL).not.toContain(':');
  });
});

describe('the three answers, kept apart', () => {
  it('reads a pluggable database', () => {
    expect(pdb).toMatchObject({
      name: 'FREEPDB1', id: 3, dbName: 'FREE',
      isRoot: false, isContainerDatabase: true,
    });
  });

  it('reads the root, and says so', () => {
    expect(root).toMatchObject({ name: ROOT_CONTAINER, id: 1, isRoot: true, isContainerDatabase: true });
  });

  it('reads a non-CDB as having no containers, which is an answer and not a gap', () => {
    // CON_ID 0 is what a genuine non-CDB reports. Treating it as "unknown" would
    // offer the estate view on a database that cannot have one.
    expect(nonCdb).toMatchObject({ id: 0, isRoot: false, isContainerDatabase: false });
  });

  it('returns undefined only when the database reported nothing', () => {
    expect(parseContainer(undefined)).toBeUndefined();
    expect(parseContainer([null, null, null])).toBeUndefined();
  });

  it('survives a CON_ID that is not a number rather than producing NaN', () => {
    const odd = parseContainer(['X', 'not-a-number', 'DB']);
    expect(odd!.id).toBe(0);
    expect(odd!.isContainerDatabase).toBe(false);
  });
});

describe('what the user is told', () => {
  it('warns, rather than labels, when the connection is in the root', () => {
    // The reason this capability is free. The read-only guard stops a statement
    // being destructive; it says nothing about it reaching the whole instance
    // instead of one application's data. Naming the root removes that surprise.
    const msg = describeContainer(root);
    expect(msg).toMatch(/ROOT/);
    expect(msg).toMatch(/not scoped to one application/);
    expect(msg).toMatch(/PDB's own service/);
  });

  it('states a PDB plainly, with no warning to become noise', () => {
    // A warning that fires on the ordinary case is a warning nobody reads — the
    // same lesson probePrivileges cost this product in 0.1.2.
    const msg = describeContainer(pdb);
    expect(msg).toContain('FREEPDB1');
    expect(msg).not.toMatch(/ROOT|warning/i);
  });

  it('names a non-CDB as such instead of pretending it has a container', () => {
    expect(describeContainer(nonCdb)).toMatch(/non-CDB/);
  });

  it('says the database reported nothing, rather than inventing a name', () => {
    expect(describeContainer(undefined)).toMatch(/unknown/);
  });

  it('marks the root in the short label too, where there is no room to explain', () => {
    expect(shortContainerLabel(root)).toBe('CDB$ROOT (root)');
    expect(shortContainerLabel(pdb)).toBe('FREEPDB1');
    expect(shortContainerLabel(nonCdb)).toBe('ORCL');
    expect(shortContainerLabel(undefined)).toBe('');
  });
});
