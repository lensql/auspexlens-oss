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
  execute(sql: string, binds?: unknown, options?: Record<string, unknown>): Promise<unknown>;
}

async function can(conn: ProbeCapableConnection, sql: string): Promise<boolean> {
  try {
    await conn.execute(sql);
    return true;
  } catch {
    // A refusal is the answer, not an error. This is the ONE place a swallowed
    // exception is correct: the probe's whole purpose is to find out whether the
    // statement is permitted, and ORA-00942 / ORA-01031 are that answer.
    return false;
  }
}

export async function probePrivileges(conn: ProbeCapableConnection): Promise<Privileges> {
  const catalog = await can(conn, 'SELECT 1 FROM all_tables WHERE ROWNUM = 1');
  const performanceViews = await can(conn, 'SELECT 1 FROM v$session WHERE ROWNUM = 1');
  // Asked without creating anything: USER_SYS_PRIVS is readable by every user
  // about itself, and the roles view covers privileges arriving through a role.
  const canCreate = await can(
    conn,
    `SELECT 1 FROM dual WHERE EXISTS (
       SELECT 1 FROM user_sys_privs WHERE privilege LIKE 'CREATE %'
       UNION ALL
       SELECT 1 FROM role_sys_privs WHERE privilege LIKE 'CREATE %'
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
