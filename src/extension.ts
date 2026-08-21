/**
 * Activation and wiring.
 *
 * Everything that decides anything lives in `src/engine`, `src/catalog`,
 * `src/explorer` and `src/licensing`, where it is tested without an extension
 * host — which is why 250+ tests run in a plain Node container with no VS Code
 * anywhere. This file connects those pieces to the editor and owns no rules.
 *
 * **Activation must stay cheap.** The competitive claim is "starts in under a
 * second, no JVM", against an official extension that runs SQLcl on a JVM and
 * takes twenty to twenty-five seconds. So nothing here connects to a database,
 * reads a catalog, or imports the Oracle driver at activation: the driver is
 * imported lazily on first connect (`loadDriver`), and the MCP bridge binds a
 * socket but opens nothing.
 */

import * as vscode from 'vscode';
import { CredentialStore } from './connections/secrets';
import { ConnectionManager, type ProfileConfig } from './connections/manager';
import { executeReadOnly, explainPlan, explainPlanRows } from './engine/readOnly';
import { assessRisk, needsConfirmation, needsTypedConfirmation, confirmationPhrase } from './engine/statementRisk';
import { runAnonymousBlock, looksLikePlSql } from './plsql/run';
import { probePrivileges, privilegeAdvice } from './catalog/privileges';
import { findObjectQuery } from './catalog/objects';
import {
  childrenQuery, folderNodes, schemaNodes, objectNodes, columnNodes, sourceQueryFor,
  type TreeNode,
} from './explorer/tree';
import { renderGrid } from './grid/render';
import { startBridge, type BridgeHandle } from './mcp/bridgeServer';
import { PRODUCT_TAGLINE, PRO_EXTENSION_ID, DOCS_URL } from './branding';
import { CAPABILITIES } from './licensing/tiers';
import { API_VERSION, type AuspexLensApi } from './api';

let bridge: BridgeHandle | undefined;

function config() {
  return vscode.workspace.getConfiguration('auspexlens');
}

function profiles(): ProfileConfig[] {
  return config().get<ProfileConfig[]>('connections.profiles', []);
}

function maskPolicy() {
  return { mode: config().get<'off' | 'named' | 'all'>('pii.mode', 'named') };
}

export async function activate(context: vscode.ExtensionContext): Promise<AuspexLensApi> {
  const credentials = new CredentialStore(context.secrets);
  const connections = new ConnectionManager(credentials);
  const output = vscode.window.createOutputChannel(PRODUCT_TAGLINE);
  context.subscriptions.push(output);

  output.appendLine(
    `${PRODUCT_TAGLINE} — ${CAPABILITIES.filter((c) => c.tier === 'free').length} free ` +
      `capabilities, ${CAPABILITIES.filter((c) => c.tier === 'pro').length} in Pro. ` +
      'The boundary is in src/licensing/tiers.ts, public on purpose.',
  );

  // Pro is detected, never required. Free is a complete product on its own.
  const pro = vscode.extensions.getExtension(PRO_EXTENSION_ID);
  output.appendLine(pro ? 'AuspexLens Pro is installed.' : 'AuspexLens Pro is not installed.');

  // --- the explorer ---------------------------------------------------------
  const treeProvider = new ObjectTreeProvider(connections, output);
  context.subscriptions.push(
    vscode.window.createTreeView('auspexlens.explorer', { treeDataProvider: treeProvider }),
  );

  // --- the MCP bridge -------------------------------------------------------
  //
  // Started at activation because binding a loopback socket is microseconds and
  // the MCP server definition must be able to describe a real port. It holds no
  // connection: `contextFor` returns undefined until the user connects, and the
  // bridge answers 409 rather than pretending.
  bridge = await startBridge(() => {
    const conn = connections.active();
    return conn ? { conn, mask: maskPolicy() } : undefined;
  });
  context.subscriptions.push({ dispose: () => void bridge?.close() });
  output.appendLine(`MCP bridge listening on 127.0.0.1:${bridge.port} (per-session secret).`);

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider('auspexlens.mcp', {
      provideMcpServerDefinitions: () => [
        new vscode.McpStdioServerDefinition(
          'AuspexLens',
          process.execPath,
          [context.asAbsolutePath('dist/mcp-server.js')],
          {
            // The port and the secret travel in the child's ENVIRONMENT, never in
            // argv: `ps` output is readable by other users on many systems.
            AUSPEXLENS_BRIDGE_PORT: String(bridge!.port),
            AUSPEXLENS_BRIDGE_SECRET: bridge!.secret,
          },
        ),
      ],
    }),
  );

  // --- commands -------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('auspexlens.showDocs', () =>
      vscode.env.openExternal(vscode.Uri.parse(DOCS_URL)),
    ),

    vscode.commands.registerCommand('auspexlens.connect', async (profileId?: unknown) => {
      const list = profiles();
      if (list.length === 0) {
        vscode.window.showInformationMessage(
          'No connection profiles yet. Add one under the setting ' +
            '“auspexlens.connections.profiles” — passwords are NOT stored there.',
        );
        return;
      }
      // The optional argument is the programmatic path: the screenshot suite and
      // future automation pass a profile id, because a harness cannot answer a
      // QuickPick. A human invoking the palette passes nothing and gets the
      // picker exactly as before. Same pattern as RedLens's connectToProfile.
      const preset = typeof profileId === 'string' ? list.find((p) => p.id === profileId) : undefined;
      if (typeof profileId === 'string' && !preset) {
        vscode.window.showErrorMessage(`No connection profile with id “${profileId}”.`);
        return;
      }
      const picked = preset
        ? { profile: preset }
        : await vscode.window.showQuickPick(
            list.map((p) => ({ label: p.label, description: `${p.user}@${p.connectString}`, profile: p })),
            { title: 'AuspexLens: connect' },
          );
      if (!picked) return;

      if (!(await credentials.has(picked.profile.id, 'password'))) {
        // Test mode only, and structurally unreachable anywhere else: VS Code
        // sets `extensionMode` to Test exclusively when a test runner launched
        // this host — the one place a password prompt has nobody to answer it.
        // The value arrives through the environment, never argv, so `ps` on a
        // shared machine cannot see it; and it goes through the same
        // CredentialStore as a typed one, so no second read path exists (T7).
        const seeded =
          context.extensionMode === vscode.ExtensionMode.Test
            ? process.env.AUSPEXLENS_TEST_PASSWORD
            : undefined;
        const password =
          seeded ??
          (await vscode.window.showInputBox({
            title: `Password for ${picked.profile.user}@${picked.profile.connectString}`,
            password: true,
            ignoreFocusOut: true,
            prompt: 'Stored in your OS keychain via VS Code SecretStorage — never in settings.json.',
          }));
        if (password === undefined) return;
        await credentials.put(picked.profile.id, 'password', password);
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${picked.profile.label}…` },
        async () => {
          const conn = await connections.connect(picked.profile);
          const privileges = await probePrivileges(conn);
          for (const line of privilegeAdvice(privileges)) {
            output.appendLine(`privileges: ${line}`);
          }
          // The over-privileged warning is shown, not buried in a log: it is the
          // difference between our guard being a convenience and being the only
          // thing standing between a language model and a DROP.
          if (privileges.canCreate) {
            void vscode.window.showWarningMessage(
              'This account can create objects. Oracle’s read-only transaction does not block DDL, ' +
                'so on this connection AuspexLens’s own guard is the only thing preventing a ' +
                'destructive statement. For read-only work, and especially for the MCP server, ' +
                'connect with an account that has only CREATE SESSION and the SELECT grants it needs.',
              'Show details',
            ).then((choice) => { if (choice) output.show(true); });
          }
        },
      );
      treeProvider.refresh();
      vscode.window.showInformationMessage(`Connected to ${picked.profile.label}.`);
    }),

    vscode.commands.registerCommand('auspexlens.disconnect', async () => {
      const id = connections.activeProfileId;
      if (!id) return;
      await connections.disconnect(id);
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('auspexlens.forgetCredentials', async () => {
      const list = profiles();
      const picked = await vscode.window.showQuickPick(
        list.map((p) => ({ label: p.label, profile: p })),
        { title: 'Forget stored credentials for…' },
      );
      if (!picked) return;
      await credentials.forget(picked.profile.id);
      // Says what happened without ever reading a secret back to say it.
      vscode.window.showInformationMessage(
        `Removed every stored credential for “${picked.profile.label}”.`,
      );
    }),

    vscode.commands.registerCommand('auspexlens.runQuery', () =>
      runFromEditor(connections, output, { explain: false }),
    ),
    vscode.commands.registerCommand('auspexlens.explainQuery', () =>
      runFromEditor(connections, output, { explain: true }),
    ),

    vscode.commands.registerCommand('auspexlens.findObject', async () => {
      const conn = connections.active();
      if (!conn) { vscode.window.showWarningMessage('Not connected.'); return; }
      const term = await vscode.window.showInputBox({
        title: 'Find database object',
        prompt: 'Part of the name. Searches every schema this connection can see.',
      });
      if (!term) return;
      const q = findObjectQuery(term);
      const res = await executeReadOnly(conn, q.sql, { binds: q.binds, mask: maskPolicy() });
      const picked = await vscode.window.showQuickPick(
        res.rows.map((r) => ({ label: String(r[1]), description: `${String(r[2])} · ${String(r[0])}` })),
        { title: `${res.rows.length} match${res.rows.length === 1 ? '' : 'es'}` },
      );
      if (picked) vscode.window.showInformationMessage(`${picked.description} — ${picked.label}`);
    }),

    vscode.commands.registerCommand('auspexlens.openSource', async (node: TreeNode) => {
      const conn = connections.active();
      const q = node && sourceQueryFor(node);
      if (!conn || !q) return;
      const res = await executeReadOnly(conn, q.sql, { binds: q.binds, maxRows: 100_000 });
      const text = res.rows.map((r) => String(r[1] ?? '')).join('');
      const doc = await vscode.workspace.openTextDocument({ content: text, language: 'plsql' });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
  );

  context.subscriptions.push({ dispose: () => void connections.disposeAll() });

  // The API Pro consumes. Returned from activate(), which is how VS Code exposes
  // one extension to another — never a cross-package import, because base is
  // mirrored to a public repository and Pro is not.
  const api: AuspexLensApi = {
    apiVersion: API_VERSION,
    version: context.extension.packageJSON.version as string,
    isConnected: () => connections.active() !== undefined,
    async executeReadOnly(sql, options) {
      const conn = connections.active();
      if (!conn) throw new Error('AuspexLens is not connected to a database.');
      // Pro goes through the SAME executor as everything else. One path, one
      // guard: a paid feature must not be a way around a safety control.
      return executeReadOnly(conn, sql, { mask: maskPolicy(), ...options });
    },
    async privileges() {
      const conn = connections.active();
      return conn ? probePrivileges(conn) : undefined;
    },
    async explainPlanRows(sql) {
      const conn = connections.active();
      if (!conn) throw new Error('AuspexLens is not connected to a database.');
      return explainPlanRows(conn, sql);
    },
  };
  output.appendLine(`API v${API_VERSION} exported for AuspexLens Pro.`);
  return api;
}

/**
 * Run what is selected, or the whole document.
 *
 * The risk assessment happens HERE, before anything is sent, and the read-only
 * guard happens inside `executeReadOnly`. Two different questions: this one is
 * "did you mean to?", that one is "may this be sent at all?".
 */
async function runFromEditor(
  connections: ConnectionManager,
  output: vscode.OutputChannel,
  options: { explain: boolean },
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const conn = connections.active();
  if (!conn) { vscode.window.showWarningMessage('Not connected. Run “AuspexLens: Connect”.'); return; }

  const selection = editor.selection.isEmpty
    ? editor.document.getText()
    : editor.document.getText(editor.selection);
  const sql = selection.trim();
  if (!sql) return;

  const readOnly = config().get<boolean>('readOnly.enabled', true);

  // PL/SQL takes the explicit path, and only when read-only mode is off. The
  // ordering matters: with read-only on, a block is refused by the guard with an
  // explanation, which is the correct answer rather than a silent reroute.
  if (!readOnly && looksLikePlSql(sql)) {
    if (!(await confirmRisk(sql))) return;
    const result = await runAnonymousBlock(conn as never, sql);
    if (result.message) {
      vscode.window.showErrorMessage(result.message);
    } else if (result.errors.length) {
      output.appendLine(result.errors.map((e) => `${e.line}:${e.position} ${e.text}`).join('\n'));
      output.show(true);
    } else {
      vscode.window.showInformationMessage('Block executed.');
    }
    return;
  }

  if (!readOnly && !(await confirmRisk(sql))) return;

  const started = Date.now();
  try {
    if (options.explain) {
      const lines = await explainPlan(conn, sql);
      const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'plaintext' });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }

    const res = await executeReadOnly(conn, sql, {
      maxRows: config().get<number>('results.maxRows', 5000),
      mask: maskPolicy(),
    });

    const panel = vscode.window.createWebviewPanel(
      'auspexlens.results', 'AuspexLens results',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // No scripts, no local resource roots: this view needs neither, and a
      // capability not granted cannot be misused.
      { enableScripts: false },
    );
    panel.webview.html = renderGrid({
      columns: res.columns,
      rows: res.rows,
      maskedColumns: res.masked.columns,
      elapsedMs: Date.now() - started,
      cspSource: panel.webview.cspSource,
      note: res.rows.length >= config().get<number>('results.maxRows', 5000)
        ? `Truncated at ${config().get<number>('results.maxRows', 5000)} rows.`
        : undefined,
    });
  } catch (e) {
    // The guard's refusal is the useful message. Show it as-is: it names the
    // statement family and says why Oracle would not have stopped it.
    vscode.window.showErrorMessage((e as Error).message);
  }
}

/**
 * Ask before something surprising happens.
 *
 * Returns true when the statement may proceed. Silent for anything the risk
 * assessment rates 'none' or 'notice' — a dialog on a harmless statement is a
 * dialog that gets dismissed, and then so is the one that mattered.
 */
async function confirmRisk(sql: string): Promise<boolean> {
  const risk = assessRisk(sql);
  if (!needsConfirmation(risk)) return true;

  if (needsTypedConfirmation(risk)) {
    const phrase = confirmationPhrase(sql);
    if (phrase) {
      const typed = await vscode.window.showInputBox({
        title: risk.title,
        prompt: `${risk.detail}\n\nType ${phrase} to confirm.`,
        placeHolder: phrase,
        ignoreFocusOut: true,
        // Typing the object NAME, not "yes". The mistake that actually happens is
        // the right statement against the wrong object, and a yes/no dialog
        // cannot catch it: the answer is yes either way.
        validateInput: (v) =>
          v.trim().toUpperCase() === phrase ? undefined : `Type ${phrase} exactly, or press Escape.`,
      });
      return typed?.trim().toUpperCase() === phrase;
    }
  }

  const choice = await vscode.window.showWarningMessage(
    risk.title,
    { modal: true, detail: `${risk.detail}\n\n${risk.reference}` },
    'Run it',
  );
  return choice === 'Run it';
}

/** The tree, as a thin adapter over `src/explorer/tree.ts`. */
class ObjectTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly output: vscode.OutputChannel,
  ) {}

  refresh(): void { this.emitter.fire(undefined); }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.expandable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = node.description;
    item.contextValue = node.kind;
    if (node.kind === 'object' && sourceQueryFor(node)) {
      item.command = { command: 'auspexlens.openSource', title: 'Open source', arguments: [node] };
    }
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    const conn = this.connections.active();
    if (!conn) return [];

    if (node?.kind === 'schema' && node.owner) return folderNodes(node.owner);

    const query = childrenQuery(node);
    if (!query) return [];

    try {
      const res = await executeReadOnly(conn, query.sql, { binds: query.binds, maxRows: 10_000 });
      if (!node) return schemaNodes(res.rows);
      if (node.kind === 'folder' && node.owner && node.objectKind) {
        return objectNodes(node.owner, node.objectKind, res.rows);
      }
      if (node.kind === 'object' && node.owner && node.objectName) {
        return columnNodes(node.owner, node.objectName, res.rows);
      }
      return [];
    } catch (e) {
      // Never swallow: a tree that silently shows nothing looks like an empty
      // schema, and someone goes looking in the database for a problem that is
      // here.
      this.output.appendLine(`explorer: ${(e as Error).message}`);
      this.output.show(true);
      return [];
    }
  }
}

export function deactivate(): void {
  void bridge?.close();
}
