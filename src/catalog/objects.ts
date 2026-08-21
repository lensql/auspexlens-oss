/**
 * The object explorer's queries.
 *
 * Everything reads `ALL_*`, never `DBA_*`. Measured 2026-08-20
 * (docs/RESEARCH.md §17.5): `ALL_TABLES`, `ALL_OBJECTS`, `ALL_TAB_COLUMNS`,
 * `ALL_SOURCE` and `ALL_ERRORS` are all readable by an account with nothing but
 * `CREATE SESSION` and its object grants, while `DBA_TABLES` is refused with
 * ORA-00942. Using `DBA_*` would mean the explorer only works for a DBA, which
 * is the opposite of the product's claim.
 *
 * Every query is parameterised. Object names arriving from anywhere — including
 * the catalog itself — are hostile input: a table can legally be named with a
 * quote in it, and string-concatenating one into SQL is how that becomes an
 * injection. Binds also let Oracle cache the cursor.
 */

export interface CatalogQuery {
  sql: string;
  /**
   * Narrow on purpose. `Record<string, unknown>` would compile here and then fail
   * at the call site, because the driver's `BindParameters` does not accept
   * `unknown` — and every bind this file produces really is a string or a number.
   * Widening it later is a decision, not an accident.
   */
  binds: Record<string, string | number>;
}

/** Schemas the current account can see objects in. */
export function schemasQuery(): CatalogQuery {
  return {
    sql: `SELECT DISTINCT owner
            FROM all_objects
           WHERE object_type IN ('TABLE','VIEW','PACKAGE','PROCEDURE','FUNCTION','TRIGGER','SEQUENCE')
           ORDER BY owner`,
    binds: {},
  };
}

export type ObjectKind =
  | 'TABLE' | 'VIEW' | 'SEQUENCE' | 'PACKAGE' | 'PACKAGE BODY'
  | 'PROCEDURE' | 'FUNCTION' | 'TRIGGER' | 'INDEX' | 'TYPE';

export function objectsQuery(owner: string, kind: ObjectKind): CatalogQuery {
  return {
    sql: `SELECT object_name, status, last_ddl_time
            FROM all_objects
           WHERE owner = :owner AND object_type = :kind
           ORDER BY object_name`,
    binds: { owner, kind },
  };
}

/**
 * `:tab`, not `:table`. Oracle refuses `:table` with ORA-01745 ("invalid
 * host/bind variable name") because TABLE is a reserved word, and a bind name
 * cannot be one. It is a one-word mistake that compiles, reads correctly and
 * fails only against a real database — which is where the live suite found it.
 */
export function columnsQuery(owner: string, table: string): CatalogQuery {
  return {
    sql: `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, column_id
            FROM all_tab_columns
           WHERE owner = :owner AND table_name = :tab
           ORDER BY column_id`,
    binds: { owner, tab: table },
  };
}

/** The source of a PL/SQL object, in line order. Free tier (D5). */
export function sourceQuery(owner: string, name: string, type: ObjectKind): CatalogQuery {
  return {
    sql: `SELECT line, text
            FROM all_source
           WHERE owner = :owner AND name = :name AND type = :type
           ORDER BY line`,
    binds: { owner, name, type },
  };
}

/**
 * Compile errors for a PL/SQL object.
 *
 * This is decision D5's whole mechanism, and it was verified against a real
 * database: creating a procedure with an undeclared identifier put two rows in
 * `ALL_ERRORS` — `PLS-00201: identifier '...' must be declared` and
 * `PL/SQL: Statement ignored` — with line and position. That is enough to put a
 * squiggle under the right character, which is the point.
 */
export function errorsQuery(owner: string, name: string): CatalogQuery {
  return {
    sql: `SELECT line, position, text, attribute, type
            FROM all_errors
           WHERE owner = :owner AND name = :name
           ORDER BY sequence`,
    binds: { owner, name },
  };
}

/**
 * "Find database object" — the fuzzy search the official extension does not have
 * (its issue #20). Case-insensitive, matches anywhere in the name.
 *
 * `ROWNUM` rather than `FETCH FIRST`: thin mode reaches Oracle Database 12.1, and
 * `FETCH FIRST` needs 12.1 too — but `ROWNUM` needs nothing and behaves the same
 * once the ordering is done in the subquery. Choosing the older construct costs
 * nothing and removes a version question.
 */
export function findObjectQuery(term: string, limit = 200): CatalogQuery {
  return {
    sql: `SELECT * FROM (
            SELECT owner, object_name, object_type
              FROM all_objects
             WHERE UPPER(object_name) LIKE UPPER('%' || :term || '%')
               AND object_type IN ('TABLE','VIEW','PACKAGE','PROCEDURE','FUNCTION','TRIGGER','SEQUENCE')
             ORDER BY
               CASE WHEN UPPER(object_name) = UPPER(:term) THEN 0
                    WHEN UPPER(object_name) LIKE UPPER(:term || '%') THEN 1
                    ELSE 2 END,
               object_name
          ) WHERE ROWNUM <= :lim`,
    binds: { term, lim: limit },
  };
}
