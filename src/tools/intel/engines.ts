import {centerOf, countXPath, humanLabel, isInput, labelOf, looksDynamic, q, shortClass} from './screen-model.js';
import type {Screen, ScreenNode} from './screen-model.js';

// ───────────────────────── Locator engineering ─────────────────────────

export interface LocatorCandidate {
  strategy: string;
  selector: string;
  /** exact short form accepted by appium_wait_for / appium_batch */
  short: string;
  matches: number;
  score: number;
  notes: string[];
}

/** Candidates for one node, each validated against the captured tree. */
export function locatorCandidates(screen: Screen, n: ScreenNode): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  const android = screen.platform === 'android';
  const add = (strategy: string, selector: string, short: string, expr: string, base: number, notes: string[] = []) => {
    const matches = countXPath(screen, expr);
    let score = base;
    if (matches === 1) {
      score += 30;
    } else if (matches === 0 || matches === -1) {
      score = 0;
    } else {
      score -= Math.min(40, matches * 5);
    }
    if (!n.visible) {
      score -= 15;
      notes.push('target not visible');
    }
    out.push({strategy, selector, short, matches, score: Math.max(0, Math.min(100, score)), notes});
  };

  if (android && n.id) {
    const dyn = looksDynamic(n.id);
    add(
      'id',
      n.id,
      `id=${n.id}`,
      `//*[@resource-id=${q(n.id) ?? "''"}]`,
      dyn ? 25 : 65,
      dyn ? ['id looks value-dependent'] : [],
    );
  }
  if (n.desc) {
    const dyn = looksDynamic(n.desc);
    const attr = android ? 'content-desc' : 'name';
    add(
      'accessibility id',
      n.desc,
      `desc=${n.desc}`,
      `//*[@${attr}=${q(n.desc) ?? "''"}]`,
      dyn ? 25 : 60,
      dyn ? ['desc looks value-dependent'] : [],
    );
  }
  if (n.text) {
    const attr = android ? 'text' : 'label';
    const dyn = looksDynamic(n.text);
    add(
      android ? 'xpath' : '-ios predicate string',
      android ? `//*[@text=${q(n.text) ?? "''"}]` : `label == ${JSON.stringify(n.text)}`,
      `text=${n.text}`,
      `//*[@${attr}=${q(n.text) ?? "''"}]`,
      dyn ? 15 : 40,
      dyn ? ['text looks value-dependent (price/count/sentence)'] : ['text changes with localisation'],
    );
  }
  // Anchored xpath: stable ancestor id + class, only when nothing above is unique
  if (!out.some((c) => c.matches === 1)) {
    let p = n.parent;
    while (p >= 0) {
      const a = screen.nodes[p];
      const aId = a.id ?? a.desc;
      if (aId && !looksDynamic(aId)) {
        const attr = a.id ? (android ? 'resource-id' : 'name') : android ? 'content-desc' : 'name';
        const siblings = screen.nodes.filter((s) => s.parent === n.parent && s.cls === n.cls);
        const pos = siblings.findIndex((s) => s.idx === n.idx) + 1;
        const expr = `//*[@${attr}=${q(aId) ?? "''"}]//${n.cls}[${pos}]`;
        add('xpath', expr, `xpath=${expr}`, expr, 20, ['positional: breaks if siblings reorder', `anchored on ${aId}`]);
        break;
      }
      p = screen.nodes[p].parent;
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface FindQuery {
  text?: string;
  id?: string;
  clickable?: boolean;
  input?: boolean;
}

export function findNodes(screen: Screen, query: FindQuery, includeHidden = false): ScreenNode[] {
  const t = query.text?.toLowerCase();
  const i = query.id?.toLowerCase();
  return screen.nodes.filter((n) => {
    if (!includeHidden && !n.visible) {
      return false;
    }
    if (t && ![n.text, n.desc, n.id].some((v) => v?.toLowerCase().includes(t))) {
      return false;
    }
    if (i && !n.id?.toLowerCase().includes(i)) {
      return false;
    }
    if (query.clickable && !n.clickable) {
      return false;
    }
    if (query.input && !isInput(n)) {
      return false;
    }
    return true;
  });
}

// ───────────────────────── Screen analysis ─────────────────────────

export interface ScreenAnalysis {
  platform: string;
  size: string;
  screenType: string;
  dialog: boolean;
  keyboard: boolean;
  scrollRegions: number;
  inputs: string[];
  buttons: string[];
  navigation: string[];
  hiddenBelow: number;
  nextActions: string[];
  notes: string[];
}

const DIALOG_IDS =
  /android:id\/(button[123]|alertTitle|message|parentPanel)|permission_(allow|deny)|XCUIElementTypeAlert/;

export function analyzeScreen(screen: Screen): ScreenAnalysis {
  const vis = screen.nodes.filter((n) => n.visible);
  const inputs = vis.filter(isInput);
  const labelled = vis
    .filter((n) => n.clickable && !isInput(n))
    .map((n) => ({n, label: humanLabel(screen, n)}))
    .filter((x): x is {n: ScreenNode; label: string} => !!x.label);
  const seen = new Set<string>();
  const buttons = labelled.filter((x) => (seen.has(x.label) ? false : (seen.add(x.label), true)));
  const nav = vis.filter(
    (n) => /tab|nav|menu|toolbar|bottom|back/i.test(`${n.id ?? ''} ${n.desc ?? ''}`) && n.clickable,
  );
  const dialog = screen.nodes.some((n) => DIALOG_IDS.test(`${n.id ?? ''} ${n.cls}`));
  const keyboard = screen.nodes.some(
    (n) => /inputmethod|XCUIElementTypeKeyboard/.test(`${n.pkg ?? ''} ${n.cls}`) && n.visible,
  );
  const scroll = vis.filter((n) => n.scrollable);
  const hiddenBelow = screen.nodes.filter(
    (n) => !n.visible && n.rect && n.rect.y1 >= screen.height && (n.clickable || n.text),
  ).length;

  let screenType = 'content';
  const pw = inputs.some((n) => n.password);
  if (dialog) {
    screenType = 'dialog/alert';
  } else if (pw) {
    screenType = 'login/credential form';
  } else if (inputs.length >= 2) {
    screenType = 'form';
  } else if (inputs.length === 1 && scroll.length) {
    screenType = 'search/list';
  } else if (scroll.length) {
    screenType = 'list/feed';
  } else if (vis.length < 8) {
    screenType = 'sparse (loading, splash or empty state)';
  }

  const notes: string[] = [];
  if (keyboard) {
    notes.push('soft keyboard open: it may cover bottom buttons; dismiss before tapping them');
  }
  if (hiddenBelow) {
    notes.push(`${hiddenBelow} actionable/text nodes exist below the fold; scroll to reach them`);
  }
  if (vis.length < 8 && !dialog) {
    notes.push('very few visible nodes: screen may still be loading');
  }

  const next: string[] = [];
  if (dialog) {
    next.push('resolve the dialog first (appium_dismiss_interrupts)');
  }
  if (pw) {
    next.push('credentials required: ask the user, never guess');
  }
  for (const b of buttons.slice(0, 5)) {
    next.push(`tap "${b.label}"`);
  }

  const lab = (n: ScreenNode) => `${shortClass(n.cls)}:${labelOf(n)}${n.password ? ' [password]' : ''}`;
  return {
    platform: screen.platform,
    size: `${screen.width}x${screen.height}`,
    screenType,
    dialog,
    keyboard,
    scrollRegions: scroll.length,
    inputs: inputs.slice(0, 10).map(lab),
    buttons: buttons.slice(0, 15).map((x) => x.label),
    navigation: nav.slice(0, 8).map((n) => humanLabel(screen, n) ?? labelOf(n)),
    hiddenBelow,
    nextActions: next,
    notes,
  };
}

// ───────────────────────── UI state diff ─────────────────────────

export interface NodeKey {
  key: string;
  line: string;
  props: string;
}

function keyFor(screen: Screen, n: ScreenNode): NodeKey {
  const stable = n.id ?? n.desc;
  // Structural key: class + index among same-class siblings, up the ancestry. Survives text edits.
  const path: string[] = [];
  let p = n.idx;
  while (p >= 0 && path.length < 6) {
    const cur = screen.nodes[p];
    const pos = screen.nodes
      .filter((s) => s.parent === cur.parent && s.cls === cur.cls)
      .findIndex((s) => s.idx === cur.idx);
    path.unshift(`${shortClass(cur.cls)}[${pos}]`);
    p = cur.parent;
  }
  const key = stable ? `${shortClass(n.cls)}#${stable}` : path.join('>');
  const c = centerOf(n);
  const props =
    `${n.enabled ? '' : 'disabled '}${n.checked ? 'checked ' : ''}${n.focused ? 'focused ' : ''}${n.visible ? '' : 'hidden '}`.trim();
  return {
    key,
    line: `${shortClass(n.cls)} ${n.id ?? n.desc ?? ''} "${n.text ?? ''}"${c ? ` @${c[0]},${c[1]}` : ''}`.trim(),
    props,
  };
}

export interface StateDiff {
  added: string[];
  removed: string[];
  textChanged: string[];
  propChanged: string[];
  moved: string[];
  counts: {before: number; after: number};
}

export function diffScreens(a: Screen, b: Screen, limit = 25): StateDiff {
  const index = (s: Screen) => {
    const m = new Map<string, {k: NodeKey; n: ScreenNode}>();
    const seen = new Map<string, number>();
    for (const n of s.nodes.filter((x) => x.visible)) {
      const k = keyFor(s, n);
      const c = (seen.get(k.key) ?? 0) + 1;
      seen.set(k.key, c);
      m.set(`${k.key}~${c}`, {k, n});
    }
    return m;
  };
  const ia = index(a);
  const ib = index(b);
  const d: StateDiff = {
    added: [],
    removed: [],
    textChanged: [],
    propChanged: [],
    moved: [],
    counts: {before: ia.size, after: ib.size},
  };
  for (const [key, v] of ib) {
    const o = ia.get(key);
    if (!o) {
      d.added.push(v.k.line);
      continue;
    }
    if ((o.n.text ?? '') !== (v.n.text ?? '')) {
      d.textChanged.push(`${v.k.line.split('"')[0].trim()}: "${o.n.text ?? ''}" -> "${v.n.text ?? ''}"`);
    }
    if (o.k.props !== v.k.props) {
      d.propChanged.push(`${v.k.line.split('"')[0].trim()}: [${o.k.props}] -> [${v.k.props}]`);
    }
    const ca = centerOf(o.n);
    const cb = centerOf(v.n);
    if (ca && cb && (Math.abs(ca[0] - cb[0]) > 20 || Math.abs(ca[1] - cb[1]) > 20)) {
      d.moved.push(`${v.k.line.split('"')[0].trim()}: ${ca} -> ${cb}`);
    }
  }
  for (const [key, v] of ia) {
    if (!ib.has(key)) {
      d.removed.push(v.k.line);
    }
  }
  for (const k of ['added', 'removed', 'textChanged', 'propChanged', 'moved'] as const) {
    if (d[k].length > limit) {
      d[k] = [...d[k].slice(0, limit), `… +${d[k].length - limit} more`];
    }
  }
  return d;
}

// ───────────────────────── Accessibility audit ─────────────────────────

export interface A11yIssue {
  severity: 'high' | 'medium' | 'low';
  rule: string;
  element: string;
  detail: string;
}

export function auditAccessibility(screen: Screen, minTargetPx = 0): A11yIssue[] {
  const issues: A11yIssue[] = [];
  const vis = screen.nodes.filter((n) => n.visible);
  // 48dp ≈ 48 * density; density unknown from XML, caller can pass pixels.
  const label = (n: ScreenNode) => `${shortClass(n.cls)}${n.id ? ` ${n.id}` : ''}`;
  for (const n of vis) {
    const named = !!(n.text || n.desc);
    if (n.clickable && !named && !n.id) {
      issues.push({
        severity: 'high',
        rule: 'unlabeled-control',
        element: label(n),
        detail: 'clickable with no text, content-desc or id',
      });
    } else if (n.clickable && !named && /ImageView|ImageButton|Image/.test(n.cls)) {
      issues.push({
        severity: 'high',
        rule: 'image-control-no-label',
        element: label(n),
        detail: 'clickable image without content-desc: invisible to screen readers',
      });
    }
    if (isInput(n) && !n.desc && !n.text && !n.id) {
      issues.push({
        severity: 'medium',
        rule: 'input-no-label',
        element: label(n),
        detail: 'input has no hint/label/desc',
      });
    }
    if (minTargetPx > 0 && n.clickable && n.rect) {
      const w = n.rect.x2 - n.rect.x1;
      const h = n.rect.y2 - n.rect.y1;
      if (w < minTargetPx || h < minTargetPx) {
        issues.push({
          severity: 'low',
          rule: 'small-touch-target',
          element: label(n),
          detail: `${w}x${h}px < ${minTargetPx}px`,
        });
      }
    }
  }
  const byDesc = new Map<string, number>();
  for (const n of vis) {
    if (n.desc && n.clickable) {
      byDesc.set(n.desc, (byDesc.get(n.desc) ?? 0) + 1);
    }
  }
  for (const [d, c] of byDesc) {
    if (c > 1) {
      issues.push({
        severity: 'low',
        rule: 'duplicate-label',
        element: d,
        detail: `${c} clickable elements share this accessible name`,
      });
    }
  }
  return issues;
}
