/**
 * Which container this connection is in — a free capability, and deliberately so.
 *
 * Every modern Oracle is a container database: non-CDB mode has been desupported
 * since 21c, an Autonomous Database is a PDB, and so is the container this
 * product's own test suite runs against. So "where am I about to run this?" is
 * not an advanced question, it is the first one — and under the principle this
 * product follows (free is working with the database safely; Pro is performance,
 * incidents and governance) **knowing where you are is safety**. It is free, it
 * is in `ALWAYS_FREE`, and it needs no privilege at all.
 *
 * What Pro adds on top is the *estate*: the inventory of every container, their
 * metrics, and what each is allowed to consume. That needs `SELECT_CATALOG_ROLE`
 * and answers a different question — not "where am I" but "what is out there".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ASKS THE DATABASE INSTEAD OF READING THE DRIVER
 *
 * node-oracledb exposes a connection property that documents itself as returning
 * the same value as `SYS_CONTEXT('USERENV','CON_NAME')`. **Measured 2026-08-23
 * against a real CDB, that equivalence does not hold in the root**: connected to
 * the root service, the property returned the database name (`FREE`) while
 * `CON_NAME` correctly returned `CDB$ROOT`.
 *
 * A user sitting in the CDB root would therefore be told they are inside a
 * pluggable database called FREE. That is precisely the wrong thing to be
 * confident about before running a statement — the root is where a careless
 * statement reaches the whole instance — so the product asks the database every
 * time and never reads the property.
 * ---------------------------------------------------------------------------
 */

/** The name Oracle gives the root container of a CDB. Not a pluggable database. */
export const ROOT_CONTAINER = 'CDB$ROOT';

export interface ContainerInfo {
  /** `CDB$ROOT`, or the PDB's name. Straight from the database. */
  name: string;
  /** 1 for the root, higher for a PDB. 0 means a non-CDB database. */
  id: number;
  /** The database name, which is NOT the container name. */
  dbName: string;
  /** True when connected to the root of a container database. */
  isRoot: boolean;
  /** False for a genuine non-CDB — still supported, just old. */
  isContainerDatabase: boolean;
}

/**
 * The statement. No binds, no privilege, no pack.
 *
 * `SYS_CONTEXT` reads the session's own environment, so this works for an account
 * holding nothing but `CREATE SESSION` — verified live. That is what makes the
 * capability free without qualification: there is no connection this product can
 * open where it fails.
 */
export const CONTAINER_SQL =
  `SELECT SYS_CONTEXT('USERENV','CON_NAME') AS container_name,
          SYS_CONTEXT('USERENV','CON_ID')   AS container_id,
          SYS_CONTEXT('USERENV','DB_NAME')  AS db_name
     FROM dual`;

/**
 * Turn the single row into something the rest of the product can reason about.
 *
 * `CON_ID` arrives as a string from `SYS_CONTEXT` regardless of driver settings,
 * and on a genuine non-CDB it is `0` — which is a real answer meaning "there are
 * no containers here", not a missing one. Distinguishing that from a PDB matters:
 * offering the estate view on a non-CDB would advertise something the database
 * cannot have.
 */
export function parseContainer(row: readonly unknown[] | undefined): ContainerInfo | undefined {
  if (!row || row[0] == null) return undefined;
  const name = String(row[0]);
  const id = Number(row[1] ?? 0);
  return {
    name,
    id: Number.isFinite(id) ? id : 0,
    dbName: String(row[2] ?? ''),
    isRoot: name.toUpperCase() === ROOT_CONTAINER,
    // A non-CDB reports CON_ID 0. Anything above that is a container database,
    // whether we are sitting in its root or in one of its PDBs.
    isContainerDatabase: Number.isFinite(id) && id > 0,
  };
}

/**
 * One line for the output channel and the connection notice.
 *
 * The root gets a warning rather than a label, and that is the entire point of
 * shipping this for free. A statement run in `CDB$ROOT` is not scoped to one
 * application's data, and the read-only guard — which stops the statement being
 * destructive — has nothing to say about it reaching further than the user meant.
 * Two safety layers that are both working can still leave that surprise, so the
 * product removes it by saying where you are.
 */
export function describeContainer(info: ContainerInfo | undefined): string {
  if (!info) return 'container: unknown (the database did not report one).';
  if (!info.isContainerDatabase) {
    return `container: none — ${info.dbName} is a non-CDB database.`;
  }
  if (info.isRoot) {
    return (
      `container: ${info.name} — you are connected to the ROOT of ${info.dbName}, not to a ` +
      'pluggable database. Statements here are not scoped to one application; connect to a ' +
      "PDB's own service for ordinary work."
    );
  }
  return `container: ${info.name} (PDB ${info.id} of ${info.dbName}).`;
}

/** Short form for a status line, where there is no room for the explanation. */
export function shortContainerLabel(info: ContainerInfo | undefined): string {
  if (!info) return '';
  if (!info.isContainerDatabase) return info.dbName;
  return info.isRoot ? `${info.name} (root)` : info.name;
}
