import {DOMParser} from '@xmldom/xmldom';
import type {Element} from '@xmldom/xmldom';

export interface CompactNode {
  /** short class name, e.g. Button, EditText, XCUIElementTypeButton -> Button */
  t: string;
  id?: string;
  desc?: string;
  text?: string;
  /** flags: c=clickable, k=checked, e=disabled, f=focused, s=scrollable, p=password */
  f?: string;
  /** center point of the element */
  xy?: [number, number];
}

const MAX_TEXT = 60;

function short(value: string | null, max = MAX_TEXT): string | undefined {
  if (!value) {
    return undefined;
  }
  // Strip unicode bidi marks the Copart app wraps around money values
  const v = value
    .replace(/[⁦-⁩‎‏]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!v) {
    return undefined;
  }
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

function center(el: Element): [number, number] | undefined {
  const bounds = el.getAttribute('bounds');
  if (bounds) {
    const m = /\[(\d+),(\d+)]\[(\d+),(\d+)]/.exec(bounds);
    if (m) {
      return [Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2)];
    }
  }
  const x = el.getAttribute('x');
  const y = el.getAttribute('y');
  const w = el.getAttribute('width');
  const h = el.getAttribute('height');
  if (x !== null && y !== null && w !== null && h !== null) {
    return [Math.round(+x + +w / 2), Math.round(+y + +h / 2)];
  }
  return undefined;
}

function isOn(el: Element, attr: string): boolean {
  const v = el.getAttribute(attr);
  return v === 'true' || v === '1';
}

/**
 * Reduce a page-source XML to only the nodes an agent can act on or read:
 * nodes that have an id/content-desc/text AND are visible, plus any clickable node.
 * Drops pure layout containers, off-screen and invisible nodes.
 */
export function compactPageSource(source: string, opts: {includeText?: boolean; limit?: number} = {}): CompactNode[] {
  const includeText = opts.includeText ?? true;
  const limit = opts.limit ?? 80;
  const doc = new DOMParser({onError: () => undefined}).parseFromString(source, 'text/xml');
  const out: CompactNode[] = [];
  // A clickable container with no label of its own is folded into its first labelled descendant.
  let pendingTap: {xy?: [number, number]} | undefined;

  const walk = (node: Element): void => {
    if (out.length >= limit) {
      return;
    }
    if (node.nodeType === 1) {
      const attr = (n: string) => node.getAttribute(n);
      const cls = attr('class') || attr('type') || node.tagName;
      const id = short(attr('resource-id'), 200);
      const desc = short(attr('content-desc')) ?? short(attr('name'));
      const text = short(attr('text')) ?? short(attr('label')) ?? short(attr('value'));
      const clickable = isOn(node, 'clickable');
      const visible = attr('displayed') !== 'false' && attr('visible') !== 'false';
      const interesting = !!id || !!desc || (includeText && !!text) || clickable;
      if (visible && interesting && node.tagName !== 'hierarchy' && node.tagName !== 'AppiumAUT') {
        let f = '';
        if (clickable) {
          f += 'c';
        }
        if (isOn(node, 'checked') || isOn(node, 'selected')) {
          f += 'k';
        }
        if (attr('enabled') === 'false') {
          f += 'e';
        }
        if (isOn(node, 'focused')) {
          f += 'f';
        }
        if (isOn(node, 'scrollable')) {
          f += 's';
        }
        if (isOn(node, 'password')) {
          f += 'p';
        }
        const item: CompactNode = {t: cls.replace(/^android\.(widget|view)\./, '').replace(/^XCUIElementType/, '')};
        if (id) {
          item.id = id;
        }
        if (desc && desc !== id) {
          item.desc = desc;
        }
        if (includeText && text && text !== desc) {
          item.text = text;
        }
        if (f) {
          item.f = f;
        }
        const xy = center(node);
        if (xy) {
          item.xy = xy;
        }
        // A bare id on a layout container is noise; keep ids only where the node has a role or readable content.
        const hasRole = !!item.f && /[cskfp]/.test(item.f);
        const isField = /EditText|TextField|SearchField|AutoComplete/.test(cls);
        const labelled = !!(item.desc || item.text);
        if (clickable && !labelled && !isField) {
          pendingTap = {xy: item.xy};
        } else if (item.desc || item.text || hasRole || isField) {
          if (pendingTap && labelled && !clickable) {
            item.f = `${item.f ?? ''}c`;
            if (pendingTap.xy) {
              item.xy = pendingTap.xy;
            }
            pendingTap = undefined;
          }
          out.push(item);
        }
      }
    }
    for (const child of Array.from(node.childNodes ?? [])) {
      if (child.nodeType === 1) {
        walk(child as Element);
      }
    }
  };

  if (doc.documentElement) {
    walk(doc.documentElement);
  }
  return out;
}

/** One line per node, tab-free and cheap on tokens. */
export function formatNode(n: CompactNode): string {
  const parts = [n.t];
  if (n.id) {
    parts.push(`id=${n.id}`);
  }
  if (n.desc) {
    parts.push(`desc=${n.desc}`);
  }
  if (n.text) {
    parts.push(`text=${n.text}`);
  }
  if (n.f) {
    parts.push(`[${n.f}]`);
  }
  if (n.xy) {
    parts.push(`@${n.xy[0]},${n.xy[1]}`);
  }
  return parts.join(' ');
}

export interface Diff {
  added: string[];
  removed: string[];
  unchanged: number;
}

export function diffLines(prev: string[], next: string[]): Diff {
  const p = new Set(prev);
  const n = new Set(next);
  return {
    added: next.filter((l) => !p.has(l)),
    removed: prev.filter((l) => !n.has(l)),
    unchanged: next.filter((l) => p.has(l)).length,
  };
}

/**
 * Short locator grammar so agents don't repeat strategy/selector pairs:
 *   id=<resource-id>  desc=<content-desc>  text=<exact text>  xpath=<expr>  uia=<uiautomator>  pred=<ios predicate>
 */
export function parseLocator(loc: string, isAndroid: boolean): {strategy: string; selector: string} {
  const i = loc.indexOf('=');
  if (i < 1) {
    throw new Error(`Locator '${loc}' must look like id=..., desc=..., text=..., xpath=..., uia=... or pred=...`);
  }
  const kind = loc.slice(0, i);
  const value = loc.slice(i + 1);
  const quote = (s: string) => (s.includes("'") ? `"${s}"` : `'${s}'`);
  switch (kind) {
    case 'id':
      return {strategy: 'id', selector: value};
    case 'desc':
      return {strategy: 'accessibility id', selector: value};
    case 'text':
      return isAndroid
        ? {strategy: 'xpath', selector: `//*[@text=${quote(value)}]`}
        : {strategy: '-ios predicate string', selector: `label == ${JSON.stringify(value)}`};
    case 'xpath':
      return {strategy: 'xpath', selector: value};
    case 'uia':
      return {strategy: '-android uiautomator', selector: value};
    case 'pred':
      return {strategy: '-ios predicate string', selector: value};
    default:
      throw new Error(`Unknown locator kind '${kind}'. Use id, desc, text, xpath, uia or pred.`);
  }
}
