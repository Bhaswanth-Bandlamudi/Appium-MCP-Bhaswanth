import {DOMParser} from '@xmldom/xmldom';
import type {Document, Element} from '@xmldom/xmldom';
import xpath from 'xpath';

export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ScreenNode {
  idx: number;
  parent: number;
  depth: number;
  el: Element;
  cls: string;
  id?: string;
  desc?: string;
  text?: string;
  pkg?: string;
  rect?: Rect;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  scrollable: boolean;
  checked: boolean;
  password: boolean;
  visible: boolean;
}

export interface Screen {
  platform: 'android' | 'ios';
  doc: Document;
  nodes: ScreenNode[];
  width: number;
  height: number;
}

const BIDI = /[⁦-⁩‎‏]/g;

function clean(v: string | null): string | undefined {
  if (!v) {
    return undefined;
  }
  const s = v.replace(BIDI, '').trim();
  return s || undefined;
}

const on = (el: Element, a: string) => el.getAttribute(a) === 'true' || el.getAttribute(a) === '1';

function readRect(el: Element): Rect | undefined {
  const b = el.getAttribute('bounds');
  if (b) {
    const m = /\[(-?\d+),(-?\d+)]\[(-?\d+),(-?\d+)]/.exec(b);
    if (m) {
      return {x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4]};
    }
  }
  const x = el.getAttribute('x');
  const y = el.getAttribute('y');
  const w = el.getAttribute('width');
  const h = el.getAttribute('height');
  if (x !== null && y !== null && w !== null && h !== null && x !== '' && w !== '') {
    return {x1: +x, y1: +y, x2: +x + +w, y2: +y + +h};
  }
  return undefined;
}

export function parseScreen(source: string): Screen {
  const doc = new DOMParser({onError: () => undefined}).parseFromString(source, 'text/xml');
  const root = doc.documentElement;
  const platform: 'android' | 'ios' = root?.tagName === 'hierarchy' ? 'android' : 'ios';
  const nodes: ScreenNode[] = [];
  let width = 0;
  let height = 0;

  const walk = (el: Element, parent: number, depth: number): void => {
    const idx = nodes.length;
    const cls = el.getAttribute('class') || el.getAttribute('type') || el.tagName;
    const rect = readRect(el);
    const isAndroid = platform === 'android';
    const node: ScreenNode = {
      idx,
      parent,
      depth,
      el,
      cls,
      id: isAndroid ? clean(el.getAttribute('resource-id')) : undefined,
      desc: isAndroid ? clean(el.getAttribute('content-desc')) : clean(el.getAttribute('name')),
      text: isAndroid
        ? clean(el.getAttribute('text'))
        : (clean(el.getAttribute('label')) ?? clean(el.getAttribute('value'))),
      pkg: clean(el.getAttribute('package')),
      rect,
      clickable: isAndroid ? on(el, 'clickable') : on(el, 'accessible') && /Button|Cell|Link|Switch|Tab/.test(cls),
      enabled: el.getAttribute('enabled') !== 'false',
      focused: on(el, 'focused'),
      scrollable: isAndroid ? on(el, 'scrollable') : /Table|CollectionView|ScrollView/.test(cls),
      checked: on(el, 'checked') || on(el, 'selected') || (!isAndroid && el.getAttribute('value') === '1'),
      password: on(el, 'password') || /SecureTextField/.test(cls),
      visible: el.getAttribute('displayed') !== 'false' && el.getAttribute('visible') !== 'false',
    };
    nodes.push(node);
    if (rect) {
      width = Math.max(width, rect.x2);
      height = Math.max(height, rect.y2);
    }
    for (const c of Array.from(el.childNodes ?? [])) {
      if (c.nodeType === 1) {
        walk(c as Element, idx, depth + 1);
      }
    }
  };

  if (root) {
    walk(root, -1, 0);
  }
  if (platform === 'ios') {
    const app = nodes.find((n) => /Application$/.test(n.cls) && n.rect);
    if (app?.rect) {
      width = app.rect.x2;
      height = app.rect.y2;
    }
  }
  // Off-screen nodes keep rects beyond the screen; clip the size to the largest top-level window.
  const top = nodes.filter((n) => n.depth === 2 && n.rect);
  if (platform === 'android' && top.length) {
    // Extents, not sizes: a dialog window sits at an offset, so its width/height understate the display.
    width = Math.max(...top.map((n) => n.rect!.x2));
    height = Math.max(...top.map((n) => n.rect!.y2));
  }
  const screen: Screen = {platform, doc, nodes, width, height};
  for (const n of nodes) {
    if (n.rect && width && height) {
      const r = n.rect;
      const inside = r.x2 > 0 && r.y2 > 0 && r.x1 < width && r.y1 < height && r.x2 > r.x1 && r.y2 > r.y1;
      if (!inside) {
        n.visible = false;
      }
    }
  }
  return screen;
}

export function centerOf(n: ScreenNode): [number, number] | undefined {
  return n.rect ? [Math.round((n.rect.x1 + n.rect.x2) / 2), Math.round((n.rect.y1 + n.rect.y2) / 2)] : undefined;
}

/** Number of elements an XPath selects, or -1 when the expression is invalid. */
export function countXPath(screen: Screen, expr: string): number {
  return selectXPath(screen, expr)?.length ?? -1;
}

export function selectXPath(screen: Screen, expr: string): Element[] | undefined {
  try {
    const r = xpath.select(expr, screen.doc as never);
    return Array.isArray(r) ? (r as unknown as Element[]).filter((x) => x.nodeType === 1) : undefined;
  } catch {
    return undefined;
  }
}

/** Value that changes with data (prices, counts, sentences) and so makes a poor locator. */
export function looksDynamic(value: string): boolean {
  const last = value.split('/').pop() ?? value;
  return /[$€£%]|\d{3,}|\d+\.\d+|\d{2,}$|(\S+\s+){3,}\S/.test(last);
}

export function labelOf(n: ScreenNode): string {
  return n.text ?? n.desc ?? n.id?.split('/').pop() ?? n.cls.split('.').pop() ?? n.cls;
}

/**
 * What a person would call this control: its own text/desc, else the first labelled
 * descendant (clickable containers carry no text themselves). Never a class or raw id.
 */
export function humanLabel(screen: Screen, n: ScreenNode): string | undefined {
  const own = n.text ?? n.desc;
  if (own) {
    return own;
  }
  for (let i = n.idx + 1; i < screen.nodes.length; i++) {
    const d = screen.nodes[i];
    if (d.depth <= n.depth) {
      break;
    }
    const label = d.text ?? d.desc;
    if (d.visible && label) {
      return label;
    }
  }
  return undefined;
}

export function shortClass(cls: string): string {
  return cls.replace(/^android\.(widget|view)\./, '').replace(/^XCUIElementType/, '');
}

export function isInput(n: ScreenNode): boolean {
  return (
    /EditText|TextField|SecureTextField|SearchField|AutoCompleteTextView|TextView$/.test(n.cls) &&
    (/EditText|TextField|SearchField|AutoComplete/.test(n.cls) || n.cls.endsWith('XCUIElementTypeTextView'))
  );
}

export const q = (s: string): string | undefined =>
  !s.includes("'") ? `'${s}'` : !s.includes('"') ? `"${s}"` : undefined;
