import {analyzeScreen} from '../intel/engines.js';
import {centerOf, humanLabel, isInput} from '../intel/screen-model.js';
import type {Screen, ScreenNode} from '../intel/screen-model.js';

/** Words that make a tap potentially destructive, financial or account-changing. Matched on whole words, case-insensitive. */
export const DEFAULT_DENY = [
  'delete',
  'remove',
  'erase',
  'clear',
  'reset',
  'uninstall',
  'log out',
  'logout',
  'sign out',
  'signout',
  'deactivate',
  'close account',
  'pay',
  'buy',
  'purchase',
  'place bid',
  'bid',
  'confirm',
  'submit',
  'send',
  'post',
  'checkout',
  'order',
  'subscribe',
  'donate',
  'factory',
  'format',
  'wipe',
  'block',
  'report',
  'unfollow',
  'cancel subscription',
  'transfer',
];

export interface ExploreOptions {
  maxSteps: number;
  maxDepth: number;
  deny: string[];
  allowOnly?: string[];
}

export interface Candidate {
  label: string;
  locator: string;
  xy?: [number, number];
}

export type Decision = {safe: true} | {safe: false; reason: string};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function classifyTap(label: string, o: Pick<ExploreOptions, 'deny' | 'allowOnly'>): Decision {
  const l = label.toLowerCase();
  if (o.allowOnly?.length && !o.allowOnly.some((a) => l.includes(a.toLowerCase()))) {
    return {safe: false, reason: 'not in allowOnly'};
  }
  for (const d of o.deny) {
    if (new RegExp(`(^|[^a-z])${esc(d.toLowerCase())}([^a-z]|$)`).test(l)) {
      return {safe: false, reason: `matches deny word "${d}"`};
    }
  }
  return {safe: true};
}

/** Stable identity for a screen: ids and labels of its visible structure, ignoring volatile data. */
export function screenFingerprint(screen: Screen): string {
  const parts = screen.nodes
    .filter((n) => n.visible && (n.id || n.desc))
    .map((n) => `${n.id ?? ''}|${n.desc ?? ''}`)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  let h = 5381;
  const s = parts.join(';');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return `${screen.platform}:${parts.length}:${(h >>> 0).toString(16)}`;
}

function locatorFor(screen: Screen, n: ScreenNode, label: string): string {
  const same = (pick: (x: ScreenNode) => string | undefined, v: string) =>
    screen.nodes.filter((x) => x.visible && pick(x) === v).length;
  if (n.id && same((x) => x.id, n.id) === 1) {
    return `id=${n.id}`;
  }
  if (n.desc && same((x) => x.desc, n.desc) === 1) {
    return `desc=${n.desc}`;
  }
  return `text=${label}`;
}

export function candidates(screen: Screen): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const n of screen.nodes) {
    if (!n.visible || !n.clickable || !n.enabled || isInput(n)) {
      continue;
    }
    const label = humanLabel(screen, n);
    if (!label || seen.has(label)) {
      continue;
    }
    seen.add(label);
    out.push({label, locator: locatorFor(screen, n, label), xy: centerOf(n)});
  }
  return out;
}

export interface ScreenRecord {
  fingerprint: string;
  type: string;
  depth: number;
  via?: string;
  untried: number;
  skipped: {label: string; reason: string}[];
  findings: string[];
}

/** Pure bookkeeping: which screens were seen, what was skipped, what looked wrong. */
export class ExploreMap {
  readonly screens = new Map<string, ScreenRecord>();
  readonly tried = new Set<string>();
  readonly path: string[] = [];

  observe(
    screen: Screen,
    depth: number,
    via: string | undefined,
    o: ExploreOptions,
  ): {record: ScreenRecord; isNew: boolean; next: Candidate[]} {
    const fp = screenFingerprint(screen);
    const existing = this.screens.get(fp);
    const cands = candidates(screen);
    const skipped: {label: string; reason: string}[] = [];
    const next: Candidate[] = [];
    for (const c of cands) {
      const d = classifyTap(c.label, o);
      if (!d.safe) {
        skipped.push({label: c.label, reason: d.reason});
      } else if (!this.tried.has(`${fp}>${c.label}`)) {
        next.push(c);
      }
    }
    if (existing) {
      existing.untried = next.length;
      return {record: existing, isNew: false, next};
    }
    const a = analyzeScreen(screen);
    const findings: string[] = [];
    if (a.dialog) {
      findings.push('dialog/alert present');
    }
    if (a.screenType.startsWith('sparse')) {
      findings.push('very few visible elements (loading or empty?)');
    }
    const rec: ScreenRecord = {
      fingerprint: fp,
      type: a.screenType,
      depth,
      via,
      untried: next.length,
      skipped,
      findings,
    };
    this.screens.set(fp, rec);
    return {record: rec, isNew: true, next};
  }

  markTried(fp: string, label: string): void {
    this.tried.add(`${fp}>${label}`);
  }
}

/** True when a system dialog (ANR, crash, permission) is what is on screen rather than app content. */
export function isBlockedByOverlay(screen: Screen): boolean {
  return screen.nodes.some(
    (n) =>
      n.visible &&
      /android:id\/(aerr_close|aerr_wait|aerr_app_info)|permission_(allow|deny)_button|XCUIElementTypeAlert/.test(
        `${n.id ?? ''} ${n.cls}`,
      ),
  );
}
