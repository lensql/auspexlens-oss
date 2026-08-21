/**
 * The MCP tool contract.
 *
 * Designed against Oracle's catalog, not copied from RedLens's Redshift one
 * (PRODUCT-BASELINE §17.8 says this explicitly, and it matters: `ALL_SOURCE`,
 * `ALL_ERRORS` and packages have no Redshift equivalent, and Redshift's
 * distribution keys have no Oracle one).
 *
 * Every tool here is **read-only by construction**, and that is enforced three
 * ways rather than promised once:
 *
 *   1. There is no tool that takes arbitrary DDL, or that runs PL/SQL. The only
 *      free-text entry point is `run_query`, and it goes through `sqlGuard`.
 *   2. `sqlGuard` is an allowlist — `SELECT`, `WITH … SELECT`, `EXPLAIN PLAN`,
 *      `DESCRIBE` — so a verb nobody thought of is refused rather than passed.
 *   3. Rows come back through `piiMask` because they come back through
 *      `executeReadOnly`, which masks in the engine. There is no unmasked path
 *      for a tool to reach for.
 *
 * What the model is told matters as much as what it can do. Each description
 * says plainly what the tool will refuse, so a model spends its turns on
 * something achievable instead of rephrasing a `DROP TABLE` five ways.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'list_schemas',
    description:
      'List the Oracle schemas this connection can see objects in. Reads ALL_OBJECTS, ' +
      'so it shows what the connected account has been granted and nothing more.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_objects',
    description:
      'List objects of one type in a schema: TABLE, VIEW, SEQUENCE, PACKAGE, PROCEDURE, ' +
      'FUNCTION, TRIGGER, INDEX or TYPE. Returns each object with its status, so an ' +
      'INVALID package is visible without a second call.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Schema name, e.g. HR.' },
        kind: { type: 'string', description: 'Object type, e.g. TABLE or PACKAGE.' },
      },
      required: ['owner', 'kind'],
    },
  },
  {
    name: 'describe_table',
    description:
      'Columns of a table or view: name, type, length, precision, scale, nullability, ' +
      'and column order. Reads ALL_TAB_COLUMNS.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Schema name.' },
        table: { type: 'string', description: 'Table or view name.' },
      },
      required: ['owner', 'table'],
    },
  },
  {
    name: 'find_object',
    description:
      'Fuzzy search for a database object by name across every schema this connection ' +
      'can see. Use this before guessing at a schema — Oracle databases routinely have ' +
      'hundreds of schemas and the object may not be where it seems.',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string', description: 'Part of the object name.' } },
      required: ['term'],
    },
  },
  {
    name: 'read_source',
    description:
      'The PL/SQL source of a package, procedure, function, trigger or type, from ' +
      'ALL_SOURCE. This is how to understand what stored code does — it is READ ONLY ' +
      'and cannot compile, replace or run anything.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Schema name.' },
        name: { type: 'string', description: 'Object name.' },
        kind: { type: 'string', description: 'PACKAGE, PACKAGE BODY, PROCEDURE, FUNCTION, TRIGGER or TYPE.' },
      },
      required: ['owner', 'name', 'kind'],
    },
  },
  {
    name: 'read_compile_errors',
    description:
      'Compile errors for a stored PL/SQL object, from ALL_ERRORS, with line and ' +
      'character position. Useful when list_objects reports an object as INVALID.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Schema name.' },
        name: { type: 'string', description: 'Object name.' },
      },
      required: ['owner', 'name'],
    },
  },
  {
    name: 'run_query',
    description:
      'Run one read-only SQL statement and return the rows. ' +
      'ONLY SELECT, WITH … SELECT, EXPLAIN PLAN and DESCRIBE are accepted. ' +
      'INSERT, UPDATE, DELETE, MERGE, CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE, ' +
      'anonymous PL/SQL blocks, SELECT … FOR UPDATE and multiple statements in one ' +
      'call are all refused before the database sees them — do not attempt to rephrase ' +
      'them, and do not ask the user to run them on your behalf. ' +
      'Columns whose names indicate personal data are masked before you receive them; ' +
      'that masking cannot be turned off from here.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One read-only SQL statement.' },
        maxRows: { type: 'string', description: 'Optional row cap; the server applies its own maximum regardless.' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'explain_query',
    description:
      'The execution plan for a query, as text (EXPLAIN PLAN + DBMS_XPLAN.DISPLAY). ' +
      'Accepts the same statements as run_query and executes none of them — an ' +
      'explain reads the optimiser, not the data.',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'The query to explain.' } },
      required: ['sql'],
    },
  },
];

/**
 * Names that must never appear as tools, checked by a test.
 *
 * Not a denylist standing in for the design — the design is that no such tool is
 * written. This is the tripwire for the pull request that adds one because it
 * would be convenient, in a file nobody re-reads.
 */
export const FORBIDDEN_TOOL_NAMES: readonly string[] = [
  'execute_sql', 'run_sql', 'execute_statement', 'run_plsql', 'run_block',
  'create_table', 'drop_table', 'grant', 'write', 'insert', 'update', 'delete',
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
