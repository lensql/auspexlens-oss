/**
 * The object explorer's shape.
 *
 * Kept as a pure description of nodes and their children, with the VS Code
 * TreeDataProvider a thin wrapper in `extension.ts`. The tree's logic — what a
 * node's children are, which query answers it — is testable without an editor,
 * which is the same reason the grid renderer is a pure function.
 */

import {
  schemasQuery, objectsQuery, columnsQuery, sourceQuery,
  type CatalogQuery, type ObjectKind,
} from '../catalog/objects';

export type NodeKind = 'schema' | 'folder' | 'object' | 'column';

export interface TreeNode {
  kind: NodeKind;
  label: string;
  /** Stable id, used for expansion state. */
  id: string;
  owner?: string;
  objectKind?: ObjectKind;
  objectName?: string;
  /** Whether the node can be expanded. */
  expandable: boolean;
  /** Extra text shown after the label, e.g. an INVALID status. */
  description?: string;
}

/** The folders every schema gets, in the order a person looks for them. */
export const SCHEMA_FOLDERS: readonly ObjectKind[] = [
  'TABLE', 'VIEW', 'PACKAGE', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'SEQUENCE', 'TYPE',
];

/** Object kinds whose source can be read from ALL_SOURCE. */
export const SOURCE_KINDS: readonly ObjectKind[] = [
  'PACKAGE', 'PACKAGE BODY', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'TYPE',
];

export function hasSource(kind: ObjectKind | undefined): boolean {
  return kind !== undefined && SOURCE_KINDS.includes(kind);
}

/** The query that answers "what are this node's children?" — or null for a leaf. */
export function childrenQuery(node: TreeNode | undefined): CatalogQuery | null {
  if (!node) return schemasQuery();

  if (node.kind === 'schema') return null; // folders are synthesised, not queried

  if (node.kind === 'folder' && node.owner && node.objectKind) {
    return objectsQuery(node.owner, node.objectKind);
  }

  if (node.kind === 'object' && node.owner && node.objectName) {
    // Tables and views expand to columns; everything else is a leaf whose source
    // opens in an editor rather than expanding in the tree.
    if (node.objectKind === 'TABLE' || node.objectKind === 'VIEW') {
      return columnsQuery(node.owner, node.objectName);
    }
    return null;
  }

  return null;
}

export function folderNodes(owner: string): TreeNode[] {
  return SCHEMA_FOLDERS.map((kind) => ({
    kind: 'folder' as const,
    label: kind === 'TABLE' ? 'Tables'
      : kind === 'VIEW' ? 'Views'
      : kind === 'PACKAGE' ? 'Packages'
      : kind === 'PROCEDURE' ? 'Procedures'
      : kind === 'FUNCTION' ? 'Functions'
      : kind === 'TRIGGER' ? 'Triggers'
      : kind === 'SEQUENCE' ? 'Sequences'
      : 'Types',
    id: `${owner}/${kind}`,
    owner,
    objectKind: kind,
    expandable: true,
  }));
}

export function schemaNodes(rows: unknown[][]): TreeNode[] {
  return rows.map((r) => {
    const owner = String(r[0]);
    return { kind: 'schema' as const, label: owner, id: owner, owner, expandable: true };
  });
}

export function objectNodes(owner: string, kind: ObjectKind, rows: unknown[][]): TreeNode[] {
  return rows.map((r) => {
    const name = String(r[0]);
    const status = r[1] === undefined || r[1] === null ? undefined : String(r[1]);
    return {
      kind: 'object' as const,
      label: name,
      id: `${owner}/${kind}/${name}`,
      owner,
      objectKind: kind,
      objectName: name,
      expandable: kind === 'TABLE' || kind === 'VIEW',
      // An INVALID package is the thing you are usually looking for, so it is
      // visible in the tree rather than one click away.
      description: status && status !== 'VALID' ? status : undefined,
    };
  });
}

export function columnNodes(owner: string, table: string, rows: unknown[][]): TreeNode[] {
  return rows.map((r) => {
    const name = String(r[0]);
    const type = String(r[1] ?? '');
    const len = r[2] === null || r[2] === undefined ? undefined : Number(r[2]);
    const precision = r[3] === null || r[3] === undefined ? undefined : Number(r[3]);
    const scale = r[4] === null || r[4] === undefined ? undefined : Number(r[4]);
    const nullable = String(r[5] ?? 'Y') === 'Y';
    return {
      kind: 'column' as const,
      label: name,
      id: `${owner}/${table}/${name}`,
      owner,
      expandable: false,
      description: `${formatType(type, len, precision, scale)}${nullable ? '' : ' NOT NULL'}`,
    };
  });
}

/** `NUMBER(12,2)`, `VARCHAR2(120)`, `DATE` — the way a DBA writes it. */
export function formatType(
  type: string,
  length?: number,
  precision?: number,
  scale?: number,
): string {
  if (precision !== undefined && precision !== null) {
    return scale ? `${type}(${precision},${scale})` : `${type}(${precision})`;
  }
  if (/CHAR|RAW/.test(type) && length) return `${type}(${length})`;
  return type;
}

export function sourceQueryFor(node: TreeNode): CatalogQuery | null {
  if (node.kind !== 'object' || !node.owner || !node.objectName || !hasSource(node.objectKind)) {
    return null;
  }
  return sourceQuery(node.owner, node.objectName, node.objectKind!);
}
