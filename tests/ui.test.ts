/**
 * The VS Code surface, checked against the manifest that produces it.
 *
 * This file exists because an interface audit on 2026-08-25 found five defects
 * that no test could have caught, and every one of them was visible to a user
 * before they ran a single query: commands with no `category`, so the palette
 * showed a hand-typed prefix as label text; a full-colour PNG where the activity
 * bar wants a single-colour SVG; an empty tree with no welcome content; commands
 * offered while disconnected whose only outcome was a warning; and no keybinding
 * to run a query, in a SQL editor.
 *
 * None of that is reachable from the extension host in a unit test. All of it is
 * declarative, which means it is checkable — and a manifest is a promise about
 * what the user will see, exactly like the listing metadata `listing.test.ts`
 * already pins.
 *
 * The reference throughout is RedLens, which had all five right, and the VS Code
 * extension API reference, which says why.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  icon: string;
  contributes: {
    commands: { command: string; title: string; category?: string; enablement?: string; icon?: string }[];
    keybindings?: { command: string; key: string; mac?: string; when?: string }[];
    menus?: Record<string, { command?: string; submenu?: string; when?: string; group?: string }[]>;
    views: Record<string, { id: string }[]>;
    viewsContainers: { activitybar: { id: string; title: string; icon: string }[] };
    viewsWelcome?: { view: string; contents: string }[];
  };
};
const c = manifest.contributes;

describe('the command palette', () => {
  it('gives every command a category, so VS Code can group them', () => {
    // "The Command Palette prefixes commands with their category, allowing for
    // easy grouping" — VS Code API, contributes.commands. Without it there is no
    // grouping and no way to filter to this extension.
    for (const cmd of c.commands) {
      expect(cmd.category, cmd.command).toBe('AuspexLens');
    }
  });

  it('never types the prefix into a title by hand', () => {
    // The defect this replaced. A baked prefix is rendered as part of the label,
    // so the palette showed "AuspexLens: AuspexLens: Connect" waiting to happen
    // the moment a category was added — and until then, no grouping at all.
    for (const cmd of c.commands) {
      expect(cmd.title, cmd.command).not.toMatch(/^AuspexLens\b/);
      expect(cmd.title.trim()).toBe(cmd.title);
    }
  });

  it('starts every title with a capital and no trailing punctuation', () => {
    for (const cmd of c.commands) {
      expect(cmd.title[0], cmd.command).toBe(cmd.title[0]!.toUpperCase());
      expect(cmd.title, cmd.command).not.toMatch(/[.:]$/);
    }
  });

  it('hides from the palette every command that needs a connection', () => {
    // A command offered while disconnected can only produce a warning dialog.
    // Offering it is not neutral: it teaches the user that this extension's
    // commands do not work.
    const gated = c.commands.filter((x) => x.enablement === 'auspexlens.connected');
    expect(gated.length).toBeGreaterThan(0);
    const palette = c.menus?.['commandPalette'] ?? [];
    for (const cmd of gated) {
      const rule = palette.find((m) => m.command === cmd.command);
      expect(rule, `${cmd.command} is enablement-gated but always in the palette`).toBeDefined();
      // Either it appears once connected, or it never appears at all — a
      // tree-only command like `openSource` is hidden outright, which is
      // stricter than the gate rather than a hole in it.
      expect(['auspexlens.connected', 'false'], cmd.command).toContain(rule!.when);
    }
  });

  it('gates on a context key the extension actually sets', () => {
    // A `when` naming a key nothing sets hides the command from everyone,
    // forever, while the manifest still looks correct. This is the half of that
    // decision that lives in code.
    const src = readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf8');
    expect(src).toContain("'auspexlens.connected'");
    expect(src).toMatch(/setContext/);
    // Both edges: set true somewhere and false somewhere.
    expect(src).toMatch(/setConnected\(true\)/);
    expect(src).toMatch(/setConnected\(false\)/);
  });

  it('keeps the tree-only command out of the palette entirely', () => {
    // `openSource` needs a tree node as its argument. From the palette it would
    // be invoked with nothing.
    const rule = (c.menus?.['commandPalette'] ?? []).find((m) => m.command === 'auspexlens.openSource');
    expect(rule?.when).toBe('false');
  });
});

describe('the activity bar', () => {
  it('uses an SVG, not the Marketplace tile', () => {
    // "It is recommended that icons be in SVG… Icons should use a single color."
    // — VS Code API, contributes.viewsContainers. The bar masks its icons to the
    // theme colour; a colour raster cannot follow that and is the one icon in
    // the strip that will not match.
    const icon = c.viewsContainers.activitybar[0]!.icon;
    expect(icon).toMatch(/\.svg$/);
    expect(existsSync(join(ROOT, icon)), `${icon} is declared but not in the package`).toBe(true);
  });

  it('keeps a PNG for the Marketplace, which wants a raster', () => {
    expect(manifest.icon).toMatch(/\.png$/);
    expect(existsSync(join(ROOT, manifest.icon))).toBe(true);
  });

  it('draws the icon in one colour, inheriting the theme', () => {
    const svg = readFileSync(join(ROOT, c.viewsContainers.activitybar[0]!.icon), 'utf8');
    expect(svg).toContain('currentColor');
    expect(svg).toContain('viewBox="0 0 24 24"');
    // No hardcoded colours: a fill or stroke with a literal would defeat the mask.
    expect(svg).not.toMatch(/(fill|stroke)="#/);
  });

  it('ships both icons in the package, or they resolve to nothing at runtime', () => {
    const ignore = readFileSync(join(ROOT, '.vscodeignore'), 'utf8');
    expect(ignore).toContain('!media/icon.svg');
    expect(ignore).toContain('!media/icon.png');
  });
});

describe('the first thing a new user sees', () => {
  it('fills the empty tree with somewhere to start', () => {
    // "Welcome content only applies to empty tree views" — VS Code API. Before
    // the first connection the tree has no children, so without this the answer
    // to clicking the icon is an empty rectangle.
    const welcome = c.viewsWelcome ?? [];
    expect(welcome.length).toBeGreaterThan(0);
    const view = c.views['auspexlens']![0]!.id;
    expect(welcome.some((w) => w.view === view)).toBe(true);
  });

  it('offers commands that work with no connection', () => {
    // Welcome content that links a connection-gated command is a dead button on
    // the one screen that exists to be clicked.
    const contents = (c.viewsWelcome ?? []).map((w) => w.contents).join('\n');
    const linked = [...contents.matchAll(/command:([\w.]+)/g)].map((m) => m[1]!);
    expect(linked.length).toBeGreaterThan(0);
    for (const id of linked) {
      const cmd = c.commands.find((x) => x.command === id);
      expect(cmd, `${id} is linked from the welcome view but not contributed`).toBeDefined();
      expect(cmd!.enablement, `${id} needs a connection and cannot be a welcome action`)
        .toBeUndefined();
    }
  });
});

describe('running a query', () => {
  it('has the keybinding a SQL editor is expected to have', () => {
    const binding = (c.keybindings ?? []).find((k) => k.command === 'auspexlens.runQuery');
    expect(binding, 'no keybinding for runQuery').toBeDefined();
    expect(binding!.key).toBe('ctrl+enter');
    expect(binding!.mac).toBe('cmd+enter');
  });

  it('scopes it so it cannot steal Enter outside a SQL editor', () => {
    const binding = (c.keybindings ?? []).find((k) => k.command === 'auspexlens.runQuery')!;
    expect(binding.when).toContain('editorTextFocus');
    expect(binding.when).toMatch(/editorLangId/);
  });
});

describe('the explorer toolbar and its right-click menu', () => {
  const title = c.menus?.['view/title'] ?? [];
  const item = c.menus?.['view/item/context'] ?? [];

  it('has a refresh button, which the tree could never be told to do', () => {
    // The provider has had refresh() since it was written, and until 1.3.0 only
    // `connect` and `disconnect` could call it. A table created in another
    // session simply never appeared.
    const refresh = title.find((m) => m.command === 'auspexlens.refreshExplorer');
    expect(refresh, 'no refresh in the view toolbar').toBeDefined();
    expect(refresh!.group).toMatch(/^navigation/);
  });

  it('gives every toolbar icon-group entry an icon, or it falls into the overflow', () => {
    // An entry in `navigation` without an icon is not a toolbar button — VS Code
    // drops it into the "..." menu, which is where things go to be unfindable.
    for (const m of title.filter((x) => (x.group ?? '').startsWith('navigation'))) {
      const cmd = c.commands.find((x) => x.command === m.command)!;
      expect(cmd.icon, `${m.command} sits in navigation with no icon`).toBeDefined();
    }
  });

  it('separates the toolbar into groups instead of one bucket', () => {
    const groups = new Set(title.map((m) => (m.group ?? '').split('@')[0]));
    expect(groups.size, 'every toolbar entry is in one group').toBeGreaterThan(1);
  });

  it('has a right-click menu at all — the explorer had none', () => {
    // The single largest gap the 2026-08-25 audit found. RedLens has seven
    // entries here; AuspexLens had the key absent entirely, so right-clicking a
    // table did nothing.
    expect(item.length).toBeGreaterThan(0);
  });

  it('matches every context entry to a contextValue the tree actually sets', () => {
    // `getTreeItem` sets contextValue = node.kind. A `when` naming anything else
    // is a menu entry that can never appear, and nothing would ever say so.
    const KINDS = ['schema', 'folder', 'object', 'column'];
    for (const m of item) {
      const when = m.when ?? '';
      expect(when, `${m.command} does not scope to this view`).toContain('view == auspexlens.explorer');
      const named = [...when.matchAll(/viewItem\s*(?:==|=~)\s*\/?\^?\(?([\w|]+)/g)]
        .flatMap((x) => x[1]!.split('|'));
      expect(named.length, `${m.command} has no viewItem condition`).toBeGreaterThan(0);
      for (const k of named) {
        expect(KINDS, `${m.command} targets "${k}", which no node ever has`).toContain(k);
      }
    }
  });

  it('offers the two things a person wants on a table', () => {
    const onObject = item.filter((m) => (m.when ?? '').includes('viewItem == object')).map((m) => m.command);
    expect(onObject).toContain('auspexlens.previewObject');
    expect(onObject).toContain('auspexlens.openSource');
  });

  it('promotes one action inline, so the common case is a single click', () => {
    expect(item.some((m) => m.group === 'inline')).toBe(true);
  });

  it('keeps node-argument commands out of the palette', () => {
    // previewObject and copyName take a TreeNode. From the palette they would be
    // invoked with nothing — the same reason openSource is hidden.
    const palette = c.menus?.['commandPalette'] ?? [];
    for (const id of ['auspexlens.previewObject', 'auspexlens.copyName', 'auspexlens.openSource']) {
      expect(palette.find((m) => m.command === id)?.when, id).toBe('false');
    }
  });

  it('never lists a command it does not contribute', () => {
    const known = new Set(c.commands.map((x) => x.command));
    for (const [menu, entries] of Object.entries(c.menus ?? {})) {
      for (const m of entries) {
        if (!m.command) continue;
        expect(known.has(m.command), `${menu} lists ${m.command}, which is not contributed`).toBe(true);
      }
    }
  });
});

describe('no exported capability without a way to reach it', () => {
  it('wires every connection-deriving helper to a command', () => {
    // proposePdbProfile shipped in 1.4.0 exported and tested with nothing calling
    // it — dead code inside a published .vsix. This is the assertion that would
    // have caught it: the module exists to serve commands, so each of its two
    // directions must be reachable from one.
    const src = readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf8');
    for (const fn of ['proposeRootProfile', 'proposePdbProfile']) {
      expect(src, `${fn} is exported but nothing in extension.ts calls it`).toContain(`${fn}(`);
    }
    for (const id of ['auspexlens.addRootConnection', 'auspexlens.addPdbConnection']) {
      expect(c.commands.some((x) => x.command === id), id).toBe(true);
    }
  });

  it('keeps both directions free, because connections are never the paid half', () => {
    // The rule the root connection established: a limitation whose only exit is
    // another connection cannot have that exit behind the paywall it feeds.
    const pro = JSON.parse(
      readFileSync(join(ROOT, '..', 'pro', 'package.json'), 'utf8'),
    ) as { contributes: { commands: { command: string }[] } };
    const proIds = new Set(pro.contributes.commands.map((x) => x.command));
    for (const id of ['auspexlens.addRootConnection', 'auspexlens.addPdbConnection']) {
      expect(proIds.has(id), `${id} must not be a Pro command`).toBe(false);
    }
  });
});
