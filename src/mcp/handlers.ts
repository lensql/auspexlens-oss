/**
 * What each MCP tool actually does.
 *
 * The dispatcher is exhaustive and the default case REFUSES. An unknown tool name
 * is not a warning to log and continue past: it means the caller and this file
 * disagree about what exists, and guessing at that is how a request gets handled
 * by the wrong code.
 */

import { executeReadOnly, explainPlan, type ReadOnlyCapableConnection } from '../engine/readOnly';
import type { MaskPolicy } from '../engine/piiMask';
import {
  schemasQuery, objectsQuery, columnsQuery, sourceQuery, errorsQuery, findObjectQuery,
  type ObjectKind,
} from '../catalog/objects';
import { toolByName } from './tools';

/** Hard cap, applied whatever the caller asks for. A model that asks for a
 *  million rows gets the cap, not a hung extension host. */
export const MCP_MAX_ROWS = 1_000;

export interface HandlerContext {
  conn: ReadOnlyCapableConnection;
  mask?: MaskPolicy;
}

export interface ToolResult {
  columns: string[];
  rows: unknown[][];
  /** Which columns were masked, so the model is told rather than left to wonder
   *  why an email column is full of bullets. */
  maskedColumns: string[];
  note?: string;
}

const OBJECT_KINDS: readonly ObjectKind[] = [
  'TABLE', 'VIEW', 'SEQUENCE', 'PACKAGE', 'PACKAGE BODY',
  'PROCEDURE', 'FUNCTION', 'TRIGGER', 'INDEX', 'TYPE',
];

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`the '${key}' argument is required and must be a non-empty string.`);
  }
  return v;
}

/** Object kinds are checked against a closed list rather than passed through:
 *  the value reaches a bind, so it cannot inject — but an unrecognised kind
 *  returns zero rows, and "no results" reads like "no such objects". */
function requireKind(args: Record<string, unknown>): ObjectKind {
  const raw = requireString(args, 'kind').toUpperCase();
  const kind = OBJECT_KINDS.find((k) => k === raw);
  if (!kind) {
    throw new Error(
      `unknown object kind '${raw}'. Use one of: ${OBJECT_KINDS.join(', ')}.`,
    );
  }
  return kind;
}

async function catalog(
  ctx: HandlerContext,
  q: { sql: string; binds: Record<string, string | number> },
): Promise<ToolResult> {
  // Catalog reads go through the same guarded executor as everything else. They
  // are all SELECTs, so they pass — the point is that there is no second, softer
  // path into the database for "our own" queries.
  const res = await executeReadOnly(ctx.conn, q.sql, {
    maxRows: MCP_MAX_ROWS,
    mask: ctx.mask,
    binds: q.binds,
  });
  return { columns: res.columns, rows: res.rows, maskedColumns: res.masked.columns };
}

export async function handleTool(
  ctx: HandlerContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  if (!toolByName(name)) {
    throw new Error(`unknown tool '${name}'.`);
  }

  switch (name) {
    case 'list_schemas':
      return catalog(ctx, schemasQuery());

    case 'list_objects':
      return catalog(ctx, objectsQuery(requireString(args, 'owner').toUpperCase(), requireKind(args)));

    case 'describe_table':
      return catalog(ctx, columnsQuery(
        requireString(args, 'owner').toUpperCase(),
        requireString(args, 'table').toUpperCase(),
      ));

    case 'find_object':
      return catalog(ctx, findObjectQuery(requireString(args, 'term')));

    case 'read_source':
      return catalog(ctx, sourceQuery(
        requireString(args, 'owner').toUpperCase(),
        requireString(args, 'name').toUpperCase(),
        requireKind(args),
      ));

    case 'read_compile_errors':
      return catalog(ctx, errorsQuery(
        requireString(args, 'owner').toUpperCase(),
        requireString(args, 'name').toUpperCase(),
      ));

    case 'run_query': {
      const sql = requireString(args, 'sql');
      // The cap is ours, never the caller's: `Math.min` and not `args.maxRows ??`.
      const asked = Number(args['maxRows'] ?? MCP_MAX_ROWS);
      const maxRows = Number.isFinite(asked) && asked > 0
        ? Math.min(asked, MCP_MAX_ROWS)
        : MCP_MAX_ROWS;
      const res = await executeReadOnly(ctx.conn, sql, { maxRows, mask: ctx.mask });
      return {
        columns: res.columns,
        rows: res.rows,
        maskedColumns: res.masked.columns,
        note: res.rows.length >= maxRows
          ? `Truncated at ${maxRows} rows. Narrow the query rather than asking for more.`
          : undefined,
      };
    }

    case 'explain_query': {
      const lines = await explainPlan(ctx.conn, requireString(args, 'sql'));
      return { columns: ['PLAN'], rows: lines.map((l) => [l]), maskedColumns: [] };
    }

    default:
      // Unreachable while TOOLS and this switch agree. Refusing rather than
      // falling through is the point: if they ever disagree, the safe answer is
      // "no" and not "whatever the last case did".
      throw new Error(`tool '${name}' is declared but not implemented — refusing.`);
  }
}
