/**
 * What this connection is allowed to see, and what it is allowed to do.
 *
 * Two questions, and they are not the same one.
 *
 * **What it can see** decides which features work. Measured 2026-08-20
 * (docs/RESEARCH.md §17.5): a user with only `CREATE SESSION` + `SELECT` reads
 * every `ALL_*` view — 51 tables, 11,853 objects — but is refused EVERY `v$` view
 * with ORA-00942. The grant that opens them without granting any DDL is
 * `SELECT_CATALOG_ROLE`. So the free explorer works with the minimum privilege,
 * and Pro's session monitor needs one more grant. Pro must say which grant is
 * missing rather than showing an error — "works with least privilege, and tells
 * you exactly what to ask your DBA for" is a feature.
 *
 * **What it can do** decides how safe the read-only floor really is. Oracle's
 * `SET TRANSACTION READ ONLY` does not stop DDL, so a connection that CAN create
 * tables is one where our own guard is the only thing standing between a language
 * model and `DROP TABLE`. That is worth telling the user, loudly, once.
 */

export interface Privileges {
  /** `ALL_*` catalog views are readable. Without this almost nothing works. */
  catalog: boolean;
  /** `v$` performance views are readable — i.e. SELECT_CATALOG_ROLE or equivalent. */
  performanceViews: boolean;
  /** The connection can create objects. TRUE means the native read-only floor is
   *  weaker than it looks, because DDL is not blocked by a read-only transaction. */
  canCreate: boolean;
}

export interface ProbeCapableConnection {
  execute(
    sql: string,
    binds?: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ rows?: unknown[][] }>;
}

/**
 * Can this connection RUN the statement at all?
 *
 * For the two catalog questions that is the whole question: a connection without
 * the privilege cannot even parse `SELECT … FROM v$session`, so ORA-00942 is the
 * answer rather than an error. This is the one place a swallowed exception is
 * correct.
 *
 * It is NOT the right question for anything that reads a privilege out of a view
 * every user can read — see `hasRow`, and the paragraph on `canCreate` that
 * explains why the difference cost this product a warning that fired on
 * everybody.
 */
async function can(conn: ProbeCapableConnection, sql: string): Promise<boolean> {
  try {
    await conn.execute(sql);
    return true;
  } catch {
    return false;
  }
}

/** Did the statement come back with at least one row? A query that runs and
 *  returns nothing is an ANSWER OF NO, and `can` cannot tell the two apart. */
async function hasRow(conn: ProbeCapableConnection, sql: string): Promise<boolean> {
  try {
    const result = await conn.execute(sql);
    return (result?.rows?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function probePrivileges(conn: ProbeCapableConnection): Promise<Privileges> {
  const catalog = await can(conn, 'SELECT 1 FROM all_tables WHERE ROWNUM = 1');
  const performanceViews = await can(conn, 'SELECT 1 FROM v$session WHERE ROWNUM = 1');
  // WHY THIS ASKS FOR A ROW AND NOT FOR SUCCESS.
  //
  // Until 2026-08-22 this went through `can`, which answers "did the statement
  // run". Both catalog questions above are privilege questions where that is the
  // same thing: without the grant the statement does not parse. This one is not.
  // `user_sys_privs` is readable by every user about itself, so
  // `SELECT 1 FROM dual WHERE EXISTS (…)` ALWAYS runs — and returns no rows when
  // the answer is no. `canCreate` was therefore `true` for every connection that
  // ever used this product, and `privilegeAdvice` showed "this account can create
  // objects" to everybody, including the least-privileged account there is. A
  // warning that fires on every connection is a warning nobody reads, and then
  // neither is the one that mattered.
  //
  // It survived because nothing here had ever seen an account with no privileges:
  // the container's app user has CREATE TABLE. It was caught on AWS RDS
  // (PLAN.md §E.1, alternative A), where such an account had to be made by hand.
  //
  // CREATE SESSION is excluded for the same reason the shape of the question
  // matters: every connection has it — it is what being able to log in is called —
  // and it matches `CREATE %`. It is the only `CREATE %` privilege that does not
  // create a schema object; CREATE ANY TABLE and CREATE PUBLIC SYNONYM are DDL and
  // belong in the warning.
  const canCreate = await hasRow(
    conn,
    `SELECT 1 FROM dual WHERE EXISTS (
       SELECT 1 FROM user_sys_privs WHERE privilege LIKE 'CREATE %' AND privilege != 'CREATE SESSION'
       UNION ALL
       SELECT 1 FROM role_sys_privs WHERE privilege LIKE 'CREATE %' AND privilege != 'CREATE SESSION'
     )`,
  );

  return { catalog, performanceViews, canCreate };
}

/** What to tell the user, in their own terms. Empty when nothing needs saying. */
export function privilegeAdvice(p: Privileges): string[] {
  const out: string[] = [];
  if (!p.catalog) {
    out.push(
      'This connection cannot read the ALL_* catalog views, so the object ' +
        'explorer will be empty. The account needs SELECT on the data dictionary ' +
        '— usually just CREATE SESSION plus the object grants it already has.',
    );
  }
  if (!p.performanceViews) {
    out.push(
      'The v$ performance views are not readable by this account, so session ' +
        'monitoring and cursor-level plans are unavailable. The grant that opens ' +
        'them without granting any DDL is: GRANT SELECT_CATALOG_ROLE TO <user>.',
    );
  }
  if (p.canCreate) {
    out.push(
      'This account can create objects. Oracle’s SET TRANSACTION READ ONLY ' +
        'does not block DDL, so on this connection AuspexLens’s own guard is the ' +
        'only thing preventing a destructive statement. For read-only work — and ' +
        'especially for the MCP server — connect with an account that has only ' +
        'CREATE SESSION and the SELECT grants it needs.',
    );
  }
  return out;
}
