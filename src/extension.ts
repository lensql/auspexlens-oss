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
import { readZipEntries, analyseWallet, WalletError } from './connections/wallet';
import { ConnectionManager, type ProfileConfig } from './connections/manager';
import { executeReadOnly, explainPlan, explainPlanRows } from './engine/readOnly';
import { assessRisk, needsConfirmation, needsTypedConfirmation, confirmationPhrase } from './engine/statementRisk';
import { runAnonymousBlock, looksLikePlSql } from './plsql/run';
import { probePrivileges, privilegeAdvice } from './catalog/privileges';
import { findObjectQuery, dependenciesQuery} from './catalog/objects';
import {
  childrenQuery, folderNodes, schemaNodes, objectNodes, columnNodes, sourceQueryFor,
  type TreeNode,
} from './explorer/tree';
import { renderGrid, transpose, groupBy, barChartSvg } from './grid/render';
import { startBridge, type BridgeHandle } from './mcp/bridgeServer';
import { PRODUCT_TAGLINE, PRO_EXTENSION_ID, DOCS_URL } from './branding';
import { CAPABILITIES } from './licensing/tiers';
import { API_VERSION, type AuspexLensApi } from './api';
import { CONTAINER_SQL, parseContainer, describeContainer, shortContainerLabel } from './engine/container';
import {
  pushHistory, summarise, saveQuery, removeQuery, ago,
  type HistoryEntry, type SavedQuery,
} from './editor/history';
import { proposeRootProfile, proposePdbProfile, rootProfileAdvice } from './connections/rootProfile';
import {
  connectionKinds, defaultsFor, hintFor, validateAnswers, buildProfile, describeProfile,
  type ConnectionKindId, type WizardAnswers,
} from './ui/connectionWizard';

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

/**
 * The context key every connection-dependent command is gated on.
 *
 * Declared as a constant and set in exactly two places, because a `when` clause
 * naming a key nothing ever sets is worse than no gate at all: the command
 * silently disappears for everyone, forever, and the manifest still looks right.
 * The manifest and this file are the two halves of one decision.
 */
const CONNECTED_CONTEXT = 'auspexlens.connected';

async function setConnected(connected: boolean): Promise<void> {
  await vscode.commands.executeCommand('setContext', CONNECTED_CONTEXT, connected);
}

export async function activate(context: vscode.ExtensionContext): Promise<AuspexLensApi> {
  // Start closed. VS Code remembers no context keys across windows, and an
  // unset key is falsy — but saying so explicitly is what makes the state
  // machine two-sided rather than one.
  void setConnected(false);

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
  /**
   * The explorer view itself, kept so its header can say where you are.
   *
   * A tree of schemas looks identical in every container, which is the problem:
   * `SALES` in the root and `SALES` in a PDB are different data behind the same
   * label. VS Code puts a view's `description` beside its title, so the answer
   * sits permanently above the tree — no extra root node to expand, and no click
   * to find out.
   */
  let explorerView: vscode.TreeView<TreeNode> | undefined;

  /**
   * The safety state, where a person can see it.
   *
   * Read-only enforcement and PII masking are what this product IS — the reason
   * pointing a language model at a production database is defensible at all —
   * and until 1.8.0 both lived only in `settings.json`. A protection you cannot
   * see is one you cannot trust: the honest question "is masking on right now?"
   * had no answer short of opening a JSON file.
   *
   * The status bar is where VS Code puts modal state, and the colour is the
   * message: read-only OFF is a warning background, because that is the state
   * where our own guard is the only thing between a careless statement and the
   * database.
   */
  /**
   * History and saved queries, in globalState.
   *
   * globalState rather than workspaceState: a connection profile is global, so
   * the statements you ran against it are not a property of whichever folder
   * happened to be open. Only statements are stored — never rows; see
   * `editor/history.ts` for why that line is where it is.
   */
  const HISTORY_KEY = 'auspexlens.history';
  const SAVED_KEY = 'auspexlens.savedQueries';
  const history = () => context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  const savedQueries = () => context.globalState.get<SavedQuery[]>(SAVED_KEY, []);
  const remember = (sql: string, elapsedMs?: number) =>
    context.globalState.update(HISTORY_KEY, pushHistory(history(), {
      sql, at: Date.now(), profileId: connections.activeProfileId, elapsedMs,
    }));

  /**
   * The last result, kept only to re-render it sideways.
   *
   * In memory and never persisted — history stores statements, never rows, and
   * this must not become the exception that quietly reintroduces a row cache.
   * It is cleared on disconnect for the same reason.
   */
  let lastResult: { columns: string[]; rows: unknown[][]; maskedColumns: string[] } | undefined;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'auspexlens.statusMenu';
  context.subscriptions.push(status);

  function refreshStatus(): void {
    const readOnly = config().get<boolean>('readOnly.enabled', true);
    const pii = config().get<'off' | 'named' | 'all'>('pii.mode', 'named');
    const connected = connections.active() !== undefined;
    if (!connected) {
      status.hide();
      return;
    }
    status.text = `$(${readOnly ? 'lock' : 'unlock'}) AuspexLens` +
      `${readOnly ? '' : ' · WRITEABLE'}${pii === 'off' ? ' · PII shown' : ''}`;
    status.tooltip =
      `Read-only: ${readOnly ? 'on — only SELECT, WITH, EXPLAIN and DESCRIBE are sent' : 'OFF'}\n` +
      `PII masking: ${pii}\nClick to change either.`;
    // Two states earn the warning colour, and only these two: they are the ones
    // where the product is doing less than a user assumes it is.
    status.backgroundColor = (!readOnly || pii === 'off')
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    status.show();
  }
  context.subscriptions.push(
    (explorerView = vscode.window.createTreeView('auspexlens.explorer', {
      treeDataProvider: treeProvider,
    })),
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
    vscode.commands.registerCommand('auspexlens.showContainer', async () => {
      const conn = connections.active();
      if (!conn) {
        void vscode.window.showWarningMessage('Not connected. Run “AuspexLens: Connect”.');
        return;
      }
      const res = await executeReadOnly(conn, CONTAINER_SQL, { mask: maskPolicy() });
      const container = parseContainer(res.rows[0]);
      const message = describeContainer(container);
      output.appendLine(message);
      // Root gets a warning severity, a PDB an informational one — the same
      // distinction the connect flow makes, so the two never disagree.
      if (container?.isRoot) void vscode.window.showWarningMessage(message);
      else void vscode.window.showInformationMessage(message);
    }),

    /**
     * Add a connection to the CDB root, derived from the one you are on.
     *
     * FREE, and that is the point. Oracle's own documentation says a session in a
     * PDB sees that PDB only, so the estate features are gated by which container
     * you connected to — not by a privilege a DBA can grant. A limitation whose
     * only exit is another connection must not have that exit behind the paywall
     * the limitation feeds; connections are never counted in this product.
     */
    vscode.commands.registerCommand('auspexlens.addRootConnection', async () => {
      const conn = connections.active();
      const activeId = connections.activeProfileId;
      const source = profiles().find((p) => p.id === activeId);
      if (!conn || !source) {
        void vscode.window.showWarningMessage(
          'Connect to a pluggable database first — the root connection is derived from it.',
        );
        return;
      }

      const res = await executeReadOnly(conn, CONTAINER_SQL, { mask: maskPolicy() });
      const container = parseContainer(res.rows[0]);
      if (container?.isRoot) {
        void vscode.window.showInformationMessage(
          `This connection is already the root of ${container.dbName}.`,
        );
        return;
      }
      if (container && !container.isContainerDatabase) {
        void vscode.window.showInformationMessage(
          `${container.dbName} is a non-CDB database — it has no root to connect to.`,
        );
        return;
      }

      let proposal;
      try {
        proposal = proposeRootProfile(source, container?.dbName ?? '', profiles().map((p) => p.id));
      } catch (e) {
        void vscode.window.showErrorMessage((e as Error).message);
        return;
      }

      // Both values are proposals, not facts: the service name is a convention and
      // the account almost certainly has to change. So both are editable, and the
      // profile is written only after the user has seen them.
      const service = await vscode.window.showInputBox({
        title: 'Service name of the CDB root',
        value: proposal.service,
        prompt: rootProfileAdvice(proposal.service, proposal.profile.user),
      });
      if (service === undefined || service.trim() === '') return;
      const user = await vscode.window.showInputBox({
        title: 'User for the root connection',
        value: proposal.profile.user,
        prompt: 'A PDB-local user normally cannot log in to the root — a common user (C##…) can.',
      });
      if (user === undefined || user.trim() === '') return;

      const profile = {
        ...proposal.profile,
        user: user.trim(),
        connectString: proposal.profile.connectString.replace(
          `/${proposal.service}`, `/${service.trim()}`),
      };
      // Written to the workspace settings the profile list already comes from —
      // no second store, and no password: that is asked for on first connect and
      // goes to SecretStorage like every other one.
      await config().update(
        'connections.profiles', [...profiles(), profile], vscode.ConfigurationTarget.Global,
      );
      output.appendLine(`added root profile ${profile.id} -> ${profile.connectString}`);
      const choice = await vscode.window.showInformationMessage(
        `Added “${profile.label}”. Connect to it to see every container in this CDB.`,
        'Connect now',
      );
      if (choice) void vscode.commands.executeCommand('auspexlens.connect', profile.id);
    }),

    /**
     * Add a connection to a pluggable database, derived from the one you are on.
     *
     * The mirror of `addRootConnection`, and free for the same reason. The estate
     * view lists a dozen PDBs and, without this, leaves you to type a connection
     * by hand for each — the way across is a connection, and connections are
     * never counted in this product.
     *
     * The name arrives as an argument when Pro's inventory offers the button, and
     * is prompted for otherwise. Base cannot list the containers itself: that
     * needs the catalog grant, which is what makes the inventory a paid feature.
     */
    vscode.commands.registerCommand('auspexlens.addPdbConnection', async (pdbName?: unknown) => {
      const activeId = connections.activeProfileId;
      const source = profiles().find((p) => p.id === activeId);
      if (!source) {
        void vscode.window.showWarningMessage(
          'Connect first — the new connection is derived from the one you are on.',
        );
        return;
      }

      const given = typeof pdbName === 'string' ? pdbName : undefined;
      const name = given ?? await vscode.window.showInputBox({
        title: 'Add a connection to a pluggable database',
        prompt: 'The PDB name. Each pluggable database publishes a service of its own name.',
        placeHolder: 'SALESPDB',
      });
      if (name === undefined || name.trim() === '') return;

      let proposal;
      try {
        proposal = proposePdbProfile(source, name, profiles().map((p) => p.id));
      } catch (e) {
        void vscode.window.showErrorMessage((e as Error).message);
        return;
      }

      const user = await vscode.window.showInputBox({
        title: `User for ${proposal.service}`,
        value: proposal.profile.user,
        prompt: 'Carried over from the current connection. A common user can usually reach a PDB; '
          + 'a user local to another PDB cannot.',
      });
      if (user === undefined || user.trim() === '') return;

      const profile = { ...proposal.profile, user: user.trim() };
      await config().update(
        'connections.profiles', [...profiles(), profile], vscode.ConfigurationTarget.Global,
      );
      output.appendLine(`added PDB profile ${profile.id} -> ${profile.connectString}`);
      const choice = await vscode.window.showInformationMessage(
        `Added “${profile.label}”.`, 'Connect now',
      );
      if (choice) void vscode.commands.executeCommand('auspexlens.connect', profile.id);
    }),

    vscode.commands.registerCommand('auspexlens.toggleReadOnly', async () => {
      const now = config().get<boolean>('readOnly.enabled', true);
      await config().update('readOnly.enabled', !now, vscode.ConfigurationTarget.Global);
      refreshStatus();
      if (now) {
        // Turning it OFF is the direction worth interrupting for. Oracle's own
        // read-only transaction never stopped DDL; with ours off, nothing does
        // except the privileges of the account.
        void vscode.window.showWarningMessage(
          'Read-only is now OFF. AuspexLens will send statements that write, and Oracle’s own ' +
            'read-only transaction does not stop DDL — the account’s privileges are the only ' +
            'thing left. The MCP server still refuses everything but reads.',
        );
      } else {
        void vscode.window.setStatusBarMessage('Read-only is on.', 2000);
      }
    }),

    vscode.commands.registerCommand('auspexlens.togglePiiMasking', async () => {
      // Three states, cycled in the order a person wants them: the middle one is
      // the default and the two ends are the deliberate choices.
      const order = ['named', 'all', 'off'] as const;
      const now = config().get<'off' | 'named' | 'all'>('pii.mode', 'named');
      const next = order[(order.indexOf(now) + 1) % order.length]!;
      await config().update('pii.mode', next, vscode.ConfigurationTarget.Global);
      refreshStatus();
      const said = next === 'off'
        ? 'PII masking is OFF — results, exports and the MCP server show raw values.'
        : `PII masking: ${next === 'all' ? 'every column' : 'columns that look personal'}.`;
      if (next === 'off') void vscode.window.showWarningMessage(said);
      else void vscode.window.setStatusBarMessage(said, 2500);
    }),

    /**
     * The status bar's own menu. One click from "what is on?" to changing it.
     */
    vscode.commands.registerCommand('auspexlens.statusMenu', async () => {
      const readOnly = config().get<boolean>('readOnly.enabled', true);
      const pii = config().get<'off' | 'named' | 'all'>('pii.mode', 'named');
      const picked = await vscode.window.showQuickPick(
        [
          { label: `$(${readOnly ? 'lock' : 'unlock'}) Read-only: ${readOnly ? 'on' : 'OFF'}`,
            detail: 'Toggle whether statements that write may be sent at all', value: 'ro' },
          { label: `$(eye${pii === 'off' ? '-closed' : ''}) PII masking: ${pii}`,
            detail: 'Cycle named → all → off', value: 'pii' },
          { label: '$(database) Which container am I in?', value: 'container' },
          { label: '$(gear) Manage connections', value: 'conn' },
          { label: '$(debug-disconnect) Disconnect', value: 'disconnect' },
        ],
        { title: 'AuspexLens' },
      );
      if (!picked) return;
      const map: Record<string, string> = {
        ro: 'auspexlens.toggleReadOnly', pii: 'auspexlens.togglePiiMasking',
        container: 'auspexlens.showContainer', conn: 'auspexlens.manageConnections',
        disconnect: 'auspexlens.disconnect',
      };
      void vscode.commands.executeCommand(map[picked.value]!);
    }),

    /**
     * Cancel whatever is running, from the palette or a keybinding.
     *
     * The progress notification already offers Cancel; this exists because a
     * person whose editor is frozen reaches for the palette, not for a toast
     * that may have scrolled away.
     */
    vscode.commands.registerCommand('auspexlens.cancelQuery', async () => {
      const conn = connections.active();
      if (!conn?.break) {
        void vscode.window.showWarningMessage('Nothing to cancel.');
        return;
      }
      await conn.break();
      void vscode.window.setStatusBarMessage('Cancel sent.', 2000);
    }),

    vscode.commands.registerCommand('auspexlens.queryHistory', async () => {
      const list = history();
      if (list.length === 0) {
        void vscode.window.showInformationMessage('No queries run yet in this window.');
        return;
      }
      const now = Date.now();
      const picked = await vscode.window.showQuickPick(
        list.map((h, i) => ({
          label: summarise(h.sql),
          description: ago(h.at, now) + (h.elapsedMs !== undefined ? ` · ${h.elapsedMs} ms` : ''),
          index: i,
        })),
        { title: 'AuspexLens: query history', matchOnDescription: true },
      );
      if (!picked) return;
      // Opened in an editor rather than run. The statement is the thing being
      // recalled, and running someone's old query the instant they click it is
      // exactly the surprise this product exists to avoid.
      const doc = await vscode.workspace.openTextDocument({
        content: list[picked.index]!.sql, language: 'sql',
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('auspexlens.saveQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      const sql = (editor?.selection.isEmpty === false
        ? editor.document.getText(editor.selection)
        : editor?.document.getText() ?? '').trim();
      if (sql === '') {
        void vscode.window.showWarningMessage('Nothing to save — open a query first.');
        return;
      }
      const name = await vscode.window.showInputBox({
        title: 'Save this query as', placeHolder: 'Daily order totals', ignoreFocusOut: true,
      });
      if (name === undefined) return;
      try {
        await context.globalState.update(SAVED_KEY, saveQuery(savedQueries(), name, sql, Date.now()));
        void vscode.window.setStatusBarMessage(`Saved “${name.trim()}”.`, 2500);
      } catch (e) {
        void vscode.window.showErrorMessage((e as Error).message);
      }
    }),

    vscode.commands.registerCommand('auspexlens.openSavedQuery', async () => {
      const list = savedQueries();
      if (list.length === 0) {
        void vscode.window.showInformationMessage(
          'No saved queries yet. Run “AuspexLens: Save query” with a query open.',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        list.map((q) => ({ label: q.name, description: summarise(q.sql, 70), name: q.name })),
        { title: 'AuspexLens: saved queries', matchOnDescription: true },
      );
      if (!picked) return;
      const action = await vscode.window.showQuickPick(
        [{ label: '$(go-to-file) Open', value: 'open' },
         { label: '$(trash) Delete', value: 'delete' }],
        { title: picked.label },
      );
      if (!action) return;
      if (action.value === 'delete') {
        await context.globalState.update(SAVED_KEY, removeQuery(savedQueries(), picked.name));
        void vscode.window.setStatusBarMessage(`Deleted “${picked.name}”.`, 2000);
        return;
      }
      const q = savedQueries().find((x) => x.name === picked.name)!;
      const doc = await vscode.workspace.openTextDocument({ content: q.sql, language: 'sql' });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    /**
     * Show the last result on its side.
     *
     * A re-render rather than an interaction: this grid runs with no scripts at
     * all, which the threat model names as a control (T15), and copying an
     * interactive grid would mean giving that up in the product whose pitch is
     * that pointing a language model at it is defensible.
     */
    vscode.commands.registerCommand('auspexlens.transposeResults', async () => {
      if (!lastResult) {
        void vscode.window.showInformationMessage('Run a query first — there is nothing to transpose.');
        return;
      }
      const t = transpose(lastResult.columns, lastResult.rows);
      const panel = vscode.window.createWebviewPanel(
        'auspexlens.results', 'AuspexLens results (transposed)',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: false },
      );
      panel.webview.html = renderGrid({
        columns: t.columns,
        rows: t.rows,
        // The masked columns are now rows, so the header flag no longer applies;
        // the values themselves were already masked in the engine.
        maskedColumns: [],
        cspSource: panel.webview.cspSource,
        note: t.truncated
          ? `Showing the first ${t.columns.length - 1} rows as columns.`
          : undefined,
      });
    }),

    /**
     * What references this object, and what it references.
     *
     * The question that precedes every schema change, and the one a table alone
     * cannot answer. Oracle keeps the record; this reads it in the user's own
     * scope so the answer matches what they can actually act on.
     */
    vscode.commands.registerCommand('auspexlens.findUsages', async (node: TreeNode) => {
      const conn = connections.active();
      if (!conn || !node?.owner || !node.objectName) return;
      const q = dependenciesQuery(node.owner, node.objectName);
      try {
        const res = await executeReadOnly(conn, q.sql, { binds: q.binds, mask: maskPolicy() });
        output.appendLine('');
        output.appendLine(`=== ${node.owner}.${node.objectName} — dependencies ===`);
        if (res.rows.length === 0) {
          // An answer, not an absence — and one worth qualifying, because the
          // catalog only knows about stored objects.
          output.appendLine('   Nothing in the database references it, and it references nothing.');
          output.appendLine('   Oracle records dependencies for stored objects only: code in your');
          output.appendLine('   application, or SQL built at runtime, cannot appear here.');
        } else {
          output.appendLine(`   ${res.columns.join('\t')}`);
          for (const row of res.rows) {
            output.appendLine(`   ${row.map((c) => String(c ?? '')).join('\t')}`);
          }
        }
        output.show(true);
      } catch (e) {
        void vscode.window.showWarningMessage((e as Error).message);
      }
    }),

    /**
     * Count the rows behind each value of one column, and chart it.
     *
     * Both are re-renders of what was already fetched, and both are drawn on this
     * side: the results view has no `script-src` at all (threat model T15), and a
     * chart is the feature most likely to be offered as the reason to give that
     * up. It does not have to be — a bar chart is rectangles and text.
     */
    vscode.commands.registerCommand('auspexlens.groupResults', async () => {
      if (!lastResult) {
        void vscode.window.showInformationMessage('Run a query first — there is nothing to group.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        lastResult.columns.map((name, index) => ({ label: name, index })),
        { title: 'Group the last result by which column?' },
      );
      if (!picked) return;

      const g = groupBy(lastResult.columns, lastResult.rows, picked.index);
      if (g.rows.length === 0) {
        void vscode.window.showInformationMessage('The last result had no rows to group.');
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        'auspexlens.results', `AuspexLens results (by ${picked.label})`,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: false },
      );
      // The chart shows the top slice; the table underneath is complete, so
      // nothing is hidden by the picture.
      const bars = g.rows.slice(0, 20).map((r) => ({ label: String(r[0]), value: Number(r[1]) }));
      panel.webview.html = renderGrid({
        columns: g.columns,
        rows: g.rows,
        maskedColumns: [],
        cspSource: panel.webview.cspSource,
        chartSvg: barChartSvg(bars),
        note: g.rows.length > bars.length
          ? `Charting the ${bars.length} largest of ${g.rows.length} groups; the table lists them all.`
          : undefined,
      });
    }),

    vscode.commands.registerCommand('auspexlens.showDocs', () =>
      vscode.env.openExternal(vscode.Uri.parse(DOCS_URL)),
    ),

    vscode.commands.registerCommand('auspexlens.connect', async (profileId?: unknown) => {
      const list = profiles();
      if (list.length === 0) {
        // Not a message telling you to go and edit a settings key. The command a
        // person pressed was "connect", so the answer is the thing that leads to
        // a connection — RedLens has worked this way since its first release and
        // it is the single largest difference in the first five minutes.
        void vscode.commands.executeCommand('auspexlens.addConnection');
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

          // Where this connection landed, reported next to what it may do. Both
          // are orientation, both are free, and the root case below is the one
          // worth interrupting for: the read-only guard stops a statement being
          // destructive and says nothing about it reaching the whole instance.
          try {
            const res = await executeReadOnly(conn, CONTAINER_SQL, { mask: maskPolicy() });
            const container = parseContainer(res.rows[0]);
            output.appendLine(describeContainer(container));
            // The header, from the same read. One query, two places that need it.
            if (explorerView) explorerView.description = shortContainerLabel(container);
            if (container?.isRoot) {
              void vscode.window.showWarningMessage(
                `Connected to ${container.name} — the ROOT of ${container.dbName}, not a pluggable ` +
                  'database. Statements here are not scoped to one application. For ordinary work, ' +
                  "connect to a PDB's own service instead.",
                'Show details',
              ).then((choice) => { if (choice) output.show(true); });
            }
          } catch (e) {
            // Never fail a connection over an orientation message. A database
            // that will not answer SYS_CONTEXT is odd; a connect that aborts
            // because of it is worse.
            output.appendLine(`container: could not be determined (${(e as Error).message}).`);
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
      await setConnected(true);
      refreshStatus();
      treeProvider.refresh();
      vscode.window.showInformationMessage(`Connected to ${picked.profile.label}.`);
    }),

    vscode.commands.registerCommand('auspexlens.disconnect', async () => {
      const id = connections.activeProfileId;
      if (!id) return;
      await connections.disconnect(id);
      await setConnected(false);
      // A stale container name over an empty tree is worse than none: it says
      // you are somewhere you are not.
      if (explorerView) explorerView.description = undefined;
      lastResult = undefined;
      refreshStatus();
      treeProvider.refresh();
    }),

    // The optional Uri is what lets the integration suite drive this without a
    // file dialog. It is only a location — every secret still comes from a prompt,
    // except in ExtensionMode.Test, exactly as `connect` already does.
    /**
     * The wizard. Contextual defaults, a hint under every field, and a test
     * before anything is written — the three rules RedLens's wizard follows.
     */
    vscode.commands.registerCommand('auspexlens.addConnection', async () => {
      const kinds = connectionKinds();
      const picked = await vscode.window.showQuickPick(
        kinds.map((k) => ({ label: k.label, detail: k.detail, id: k.id })),
        { title: 'AuspexLens: add a connection — what are you connecting to?',
          placeHolder: 'Pick how this database is reached', ignoreFocusOut: true },
      );
      if (!picked) return;
      const kind = picked.id as ConnectionKindId;

      // The wallet path is the import command's, not a second copy of it.
      if (kind === 'wallet') {
        await vscode.commands.executeCommand('auspexlens.importWallet');
        return;
      }

      const spec = kinds.find((k) => k.id === kind)!;
      const defaults = defaultsFor(kind);
      const answers: WizardAnswers = {};
      let step = 0;
      for (const field of spec.asks) {
        step += 1;
        const value = await vscode.window.showInputBox({
          title: `Add a connection (${step}/${spec.asks.length})`,
          value: defaults[field] ?? '',
          placeHolder: hintFor(field),
          prompt: hintFor(field),
          ignoreFocusOut: true,
        });
        if (value === undefined) return;   // escape cancels the whole wizard
        answers[field as keyof WizardAnswers] = value;
      }

      const errors = validateAnswers(kind, answers);
      if (errors.length > 0) {
        // Every problem at once. Running the wizard three times to learn three
        // things is how a person decides the tool is not worth it.
        void vscode.window.showErrorMessage(errors.join(' '));
        return;
      }
      const profile = buildProfile(kind, answers, profiles().map((p) => p.id));

      // Test before save. A profile that does not connect is worse than no
      // profile: it fails later, somewhere else, with the wizard forgotten.
      const password = await vscode.window.showInputBox({
        title: `Password for ${profile.user}@${profile.connectString}`,
        password: true, ignoreFocusOut: true,
        prompt: 'Stored in your OS keychain via SecretStorage — never in settings.json.',
      });
      if (password === undefined) return;
      await credentials.put(profile.id, 'password', password);

      const ok = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Testing the connection…' },
        async () => {
          try {
            await connections.connect(profile);
            return true;
          } catch (e) {
            const message = (e as Error).message.split('\n')[0];
            const choice = await vscode.window.showErrorMessage(
              `Could not connect: ${message}`, 'Save anyway', 'Discard',
            );
            return choice === 'Save anyway';
          }
        },
      );
      if (!ok) {
        await credentials.forget(profile.id);
        return;
      }

      await config().update(
        'connections.profiles', [...profiles(), profile], vscode.ConfigurationTarget.Global,
      );
      await setConnected(connections.active() !== undefined);
      treeProvider.refresh();
      void vscode.window.showInformationMessage(`Added and connected: ${profile.label}.`);
    }),

    /**
     * See what is configured, and remove what is not wanted.
     *
     * Adding lands back in the wizard rather than growing a second flow: there is
     * one description of what a connection needs, and it is the one that already
     * validates.
     */
    vscode.commands.registerCommand('auspexlens.manageConnections', async () => {
      const list = profiles();
      if (list.length === 0) {
        void vscode.commands.executeCommand('auspexlens.addConnection');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        list.map((p) => ({ ...describeProfile(p), id: p.id })),
        { title: 'AuspexLens: connections', placeHolder: 'Pick one to act on' },
      );
      if (!picked) return;
      const action = await vscode.window.showQuickPick(
        [
          { label: '$(plug) Connect', value: 'connect' },
          { label: '$(add) Add another…', value: 'add' },
          { label: '$(trash) Remove', value: 'remove',
            detail: 'Deletes the profile and forgets its stored password' },
        ],
        { title: picked.label },
      );
      if (!action) return;
      if (action.value === 'connect') {
        void vscode.commands.executeCommand('auspexlens.connect', picked.id);
        return;
      }
      if (action.value === 'add') {
        void vscode.commands.executeCommand('auspexlens.addConnection');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Remove “${picked.label}”?`, { modal: true }, 'Remove',
      );
      if (confirm !== 'Remove') return;
      await credentials.forget(picked.id);
      await config().update(
        'connections.profiles', profiles().filter((p) => p.id !== picked.id),
        vscode.ConfigurationTarget.Global,
      );
      void vscode.window.showInformationMessage(`Removed ${picked.label}.`);
    }),

    vscode.commands.registerCommand('auspexlens.importWallet', async (source?: vscode.Uri) => {
      await importWallet(context, credentials, output, source);
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
      runFromEditor(connections, output, { explain: false, remember, keepResult: (r) => { lastResult = r; } }),
    ),
    vscode.commands.registerCommand('auspexlens.explainQuery', () =>
      runFromEditor(connections, output, { explain: true, remember }),
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

    /**
     * Refresh the explorer.
     *
     * The tree caches nothing, but it also re-reads nothing on its own: a table
     * created in another session, or a package recompiled, simply does not
     * appear. The provider has had a `refresh()` since it was written and until
     * now there was no way for a person to call it — the button existed only for
     * `connect` and `disconnect` to press.
     */
    vscode.commands.registerCommand('auspexlens.refreshExplorer', () => treeProvider.refresh()),

    /**
     * Copy an object's name, qualified the way you would paste it into SQL.
     *
     * The smallest useful thing an explorer can do, and the one a person reaches
     * for constantly. Qualified with the owner because an unqualified name only
     * resolves for its own schema, and pasting one that silently resolves to a
     * *different* object is worse than pasting nothing.
     */
    vscode.commands.registerCommand('auspexlens.copyName', async (node: TreeNode) => {
      if (!node) return;
      const name = node.kind === 'column' && node.objectName
        ? node.label
        : [node.owner, node.objectName ?? (node.kind === 'schema' ? undefined : node.label)]
            .filter(Boolean).join('.') || node.label;
      await vscode.env.clipboard.writeText(name);
      void vscode.window.setStatusBarMessage(`Copied ${name}`, 2000);
    }),

    /**
     * Open a SELECT for this object, ready to run.
     *
     * A document rather than an immediate execution, and that is the point: the
     * statement is the thing being taught. You see exactly what will be sent,
     * you can edit it before sending, and running it is the same Ctrl/Cmd+Enter
     * as any other query — one path to the database, not a private one for the
     * explorer.
     *
     * ROWNUM rather than FETCH FIRST so nothing here depends on a version newer
     * than the 19c this product supports — the same rule the Pro monitor follows.
     */
    vscode.commands.registerCommand('auspexlens.previewObject', async (node: TreeNode) => {
      if (!node?.owner || !node.objectName) return;
      const sql =
        `-- ${node.owner}.${node.objectName}\n` +
        `SELECT * FROM (SELECT * FROM ${node.owner}.${node.objectName}) WHERE ROWNUM <= 100;\n`;
      const doc = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
      await vscode.window.showTextDocument(doc, { preview: false });
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

  // Settings can change from the JSON file, another window, or a sync. A status
  // bar that only updates when our own commands run would confidently show the
  // wrong thing.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('auspexlens')) refreshStatus();
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
    async currentContainer() {
      const conn = connections.active();
      if (!conn) return undefined;
      // Through the same read-only executor as everything else, masking included.
      // It reads SYS_CONTEXT and touches no table, but a second path to the
      // database is a second path to get wrong.
      const res = await executeReadOnly(conn, CONTAINER_SQL, { mask: maskPolicy() });
      return parseContainer(res.rows[0]);
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
  options: {
    explain: boolean;
    /**
     * Record the statement once it has run.
     *
     * Passed in rather than reached for, because this function lives outside
     * `activate` and the storage belongs to the ExtensionContext. It is called
     * only after the statement completed — a query the guard refused was never
     * run, and putting it in "what I ran" would be a lie the list cannot correct.
     */
    remember?: (sql: string, elapsedMs?: number) => Thenable<void>;
    /** Hand the rows back so they can be re-rendered sideways. In memory only. */
    keepResult?: (r: { columns: string[]; rows: unknown[][]; maskedColumns: string[] }) => void;
  },
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
      void options.remember?.(sql, Date.now() - started);
      const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'plaintext' });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }

    // Cancellable, and cancellable for real: the progress notification's Cancel
    // calls the driver's `break()`, which stops the statement on the server. A
    // spinner with a Cancel that only stops watching would be worse than none —
    // the query keeps running and the user believes it did not.
    const res = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Running query…',
        cancellable: true,
      },
      (_progress, token) => {
        token.onCancellationRequested(() => {
          // A no-op by the driver's own definition when nothing is running, so a
          // cancel that arrives after the rows do is harmless.
          void conn.break?.();
        });
        return executeReadOnly(conn, sql, {
          maxRows: config().get<number>('results.maxRows', 5000),
          mask: maskPolicy(),
        });
      },
    );

    const panel = vscode.window.createWebviewPanel(
      'auspexlens.results', 'AuspexLens results',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // No scripts, no local resource roots: this view needs neither, and a
      // capability not granted cannot be misused.
      { enableScripts: false },
    );
    const elapsedMs = Date.now() - started;
    void options.remember?.(sql, elapsedMs);
    options.keepResult?.({ columns: res.columns, rows: res.rows, maskedColumns: res.masked.columns });

    panel.webview.html = renderGrid({
      columns: res.columns,
      rows: res.rows,
      maskedColumns: res.masked.columns,
      elapsedMs,
      cspSource: panel.webview.cspSource,
      note: res.rows.length >= config().get<number>('results.maxRows', 5000)
        ? `Truncated at ${config().get<number>('results.maxRows', 5000)} rows.`
        : undefined,
    });
  } catch (e) {
    const message = (e as Error).message;
    // ORA-01013 is not a failure, it is the user's own decision arriving back as
    // an exception. Showing it raw — "user requested cancel of current
    // operation" — reads like something went wrong.
    if (/ORA-01013/.test(message)) {
      void vscode.window.setStatusBarMessage('Query cancelled.', 2500);
      return;
    }
    // The guard's refusal is the useful message. Show it as-is: it names the
    // statement family and says why Oracle would not have stopped it.
    vscode.window.showErrorMessage(message);
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

/**
 * Import an Oracle wallet, and leave behind a profile that can connect.
 *
 * This is the half that was missing until 0.2.0: the engine has spoken wallet
 * mTLS since Phase 3, but nothing ever put a wallet into SecretStorage, so the
 * capability was advertised and unreachable (docs/RESEARCH.md §17). Everything
 * that can go wrong with the FILE is decided in `connections/wallet.ts`, which is
 * pure and tested; this function is the part that needs an editor.
 *
 * Where each piece ends up, and why:
 *
 *  - `ewallet.pem` goes to **SecretStorage** and never to disk. It carries a
 *    private key, and `walletContent` takes it as a string precisely so the
 *    product never has to leave one lying in a folder (threat T7).
 *  - `tnsnames.ora` goes to the extension's **global storage**, because the
 *    driver reads that file itself and needs a real `configDir`. It is not a
 *    secret — it is a list of hostnames.
 *  - the wallet password and the database password go to SecretStorage.
 *  - the profile itself goes to settings, where every other profile lives.
 */
async function importWallet(
  context: vscode.ExtensionContext,
  credentials: CredentialStore,
  output: vscode.OutputChannel,
  given?: vscode.Uri,
): Promise<void> {
  // Test mode only, and structurally unreachable anywhere else — the same rule
  // the connect command follows. VS Code sets Test exclusively when a test runner
  // launched this host, which is the one place a prompt has nobody to answer it.
  const seeded =
    context.extensionMode === vscode.ExtensionMode.Test
      ? {
          alias: process.env['AUSPEXLENS_TEST_WALLET_ALIAS'],
          user: process.env['AUSPEXLENS_TEST_WALLET_USER'],
          walletPassword: process.env['AUSPEXLENS_TEST_WALLET_PASSWORD'],
          password: process.env['AUSPEXLENS_TEST_PASSWORD'],
          label: process.env['AUSPEXLENS_TEST_WALLET_LABEL'],
        }
      : {};

  const source =
    given ??
    (
      await vscode.window.showOpenDialog({
        title: 'Import Oracle wallet',
        openLabel: 'Import',
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: false,
        filters: { 'Wallet archive': ['zip'] },
      })
    )?.[0];
  if (!source) return;

  let contents;
  try {
    contents = analyseWallet(await readWalletFiles(source));
  } catch (e) {
    // A WalletError is a sentence written for the user — including the openssl
    // line for a wallet that shipped only a PKCS#12. Anything else is a bug and
    // should not be dressed up as advice.
    const message = e instanceof WalletError ? e.message : `Could not read that wallet: ${String(e)}`;
    await vscode.window.showErrorMessage(message, { modal: e instanceof WalletError });
    return;
  }

  const alias =
    seeded.alias ??
    (await vscode.window.showQuickPick(contents.aliases, {
      title: 'Which service?',
      placeHolder: 'Autonomous Database offers _high, _medium and _low',
    }));
  if (!alias) return;

  const user =
    seeded.user ??
    (await vscode.window.showInputBox({
      title: 'Database user',
      prompt: 'The database account, not your cloud login. ADMIN for a fresh Autonomous Database.',
      ignoreFocusOut: true,
    }));
  if (!user) return;

  // Only ask when there is something to ask for. An Autonomous wallet's PEM is
  // encrypted and its password is the one set at download; a PEM produced by the
  // `openssl pkcs12 … -nodes` conversion this product recommends is NOT encrypted
  // and has no password at all. Prompting there would demand something that does
  // not exist, and whatever the user typed would then be sent to the driver as
  // the passphrase for an unencrypted key.
  const walletPassword = contents.encrypted
    ? seeded.walletPassword ??
      (await vscode.window.showInputBox({
        title: 'Wallet password',
        prompt: 'The password you set when downloading the wallet — not the database password.',
        password: true,
        ignoreFocusOut: true,
      }))
    : '';
  if (walletPassword === undefined) return;

  const password =
    seeded.password ??
    (await vscode.window.showInputBox({
      title: `Database password for ${user}`,
      password: true,
      ignoreFocusOut: true,
      prompt: 'Stored in your OS keychain via SecretStorage — never in settings.json.',
    }));
  if (password === undefined) return;

  const label =
    seeded.label ??
    (await vscode.window.showInputBox({
      title: 'Name this connection',
      value: alias,
      ignoreFocusOut: true,
    }));
  if (!label) return;

  // The id has to survive secretKey()'s rules — no spaces, no colons — because a
  // profile id with a colon in it could forge another profile's key.
  const id = `wallet-${alias.replace(/[^A-Za-z0-9_.-]/g, '-')}-${Date.now().toString(36)}`;

  const dir = vscode.Uri.joinPath(context.globalStorageUri, 'wallets', id);
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(dir, 'tnsnames.ora'),
    Buffer.from(contents.tnsnames, 'utf8'),
  );

  await credentials.put(id, 'walletContent', contents.pem);
  await credentials.put(id, 'walletPassword', walletPassword);
  await credentials.put(id, 'password', password);

  const profile: ProfileConfig = {
    id,
    label,
    user,
    connectString: alias,
    kind: 'wallet',
    configDir: dir.fsPath,
  };
  const existing = profiles();
  await config().update(
    'connections.profiles',
    [...existing, profile],
    vscode.ConfigurationTarget.Global,
  );

  output.appendLine(
    `wallet: imported “${label}” (${alias}); ${contents.aliases.length} aliases available, ` +
      `${contents.encrypted ? 'encrypted' : 'unencrypted'} PEM in SecretStorage, ` +
      'tnsnames.ora in global storage.',
  );

  // A modal offer would hang a headless run, and the import is already complete
  // by this point — the prompt is a convenience, not part of the operation.
  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    const connectNow = await vscode.window.showInformationMessage(
      `Imported “${label}”. The wallet is in your OS keychain; only tnsnames.ora was written to disk.`,
      'Connect now',
    );
    if (connectNow) await vscode.commands.executeCommand('auspexlens.connect', id);
  }
}

/**
 * Read a wallet from either a .zip or an already-unzipped folder.
 *
 * Both, because Oracle's own instructions tell people to unzip the archive, and
 * because a wallet that shipped only a PKCS#12 has to be converted on disk before
 * it can be imported at all — at which point the user has a folder, not a zip.
 */
async function readWalletFiles(source: vscode.Uri): Promise<Map<string, Buffer>> {
  const stat = await vscode.workspace.fs.stat(source);
  if (stat.type === vscode.FileType.Directory) {
    const out = new Map<string, Buffer>();
    for (const [name, type] of await vscode.workspace.fs.readDirectory(source)) {
      if (type !== vscode.FileType.File) continue;
      out.set(name, Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(source, name))));
    }
    return out;
  }
  return readZipEntries(Buffer.from(await vscode.workspace.fs.readFile(source)));
}
