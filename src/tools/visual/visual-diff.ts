import type {Screen, ScreenNode} from '../intel/screen-model.js';
import {labelOf, shortClass} from '../intel/screen-model.js';

export interface Raw {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  pixels: number;
}

export interface PixelDiff {
  changedPct: number;
  changedPixels: number;
  regions: Region[];
  sameSize: boolean;
}

/**
 * Compare two same-size raw images on a grid. A cell is "changed" when more than `cellTolerance`
 * of its pixels differ by more than `channelTolerance` in any colour channel. Adjacent changed cells
 * are merged into regions, so an agent reads 3 rectangles rather than a bitmap.
 */
export function diffImages(
  a: Raw,
  b: Raw,
  opts: {channelTolerance?: number; cell?: number; cellTolerance?: number} = {},
): PixelDiff {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    return {
      changedPct: 100,
      changedPixels: a.width * a.height,
      regions: [{x: 0, y: 0, w: b.width, h: b.height, pixels: b.width * b.height}],
      sameSize: false,
    };
  }
  const tol = opts.channelTolerance ?? 24;
  const cell = opts.cell ?? 32;
  const cellTol = opts.cellTolerance ?? 0.02;
  const {width, height, channels} = a;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const counts = new Uint32Array(cols * rows);
  let changed = 0;
  const cc = Math.min(channels, 3);
  for (let y = 0; y < height; y++) {
    const rowBase = y * width * channels;
    const cy = Math.floor(y / cell) * cols;
    for (let x = 0; x < width; x++) {
      const i = rowBase + x * channels;
      let diff = false;
      for (let c = 0; c < cc; c++) {
        if (Math.abs(a.data[i + c] - b.data[i + c]) > tol) {
          diff = true;
          break;
        }
      }
      if (diff) {
        changed++;
        counts[cy + Math.floor(x / cell)]++;
      }
    }
  }
  const hot = new Uint8Array(cols * rows);
  for (let i = 0; i < hot.length; i++) {
    const cw = Math.min(cell, width - (i % cols) * cell);
    const ch = Math.min(cell, height - Math.floor(i / cols) * cell);
    hot[i] = counts[i] / (cw * ch) > cellTol ? 1 : 0;
  }
  // flood-fill merge 4-connected hot cells into regions
  const seen = new Uint8Array(hot.length);
  const regions: Region[] = [];
  for (let s = 0; s < hot.length; s++) {
    if (!hot[s] || seen[s]) {
      continue;
    }
    const stack = [s];
    seen[s] = 1;
    let minC = cols;
    let maxC = 0;
    let minR = rows;
    let maxR = 0;
    let px = 0;
    while (stack.length) {
      const cur = stack.pop() as number;
      const c = cur % cols;
      const r = Math.floor(cur / cols);
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      px += counts[cur];
      for (const [dc, dr] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) {
          continue;
        }
        const n = nr * cols + nc;
        if (hot[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    regions.push({
      x: minC * cell,
      y: minR * cell,
      w: Math.min(width, (maxC + 1) * cell) - minC * cell,
      h: Math.min(height, (maxR + 1) * cell) - minR * cell,
      pixels: px,
    });
  }
  regions.sort((p, q) => q.pixels - p.pixels);
  return {
    changedPct: Math.round((changed / (width * height)) * 1000) / 10,
    changedPixels: changed,
    regions: regions.slice(0, 8),
    sameSize: true,
  };
}

export interface LayoutIssue {
  rule: 'overlap' | 'clipped' | 'zero-size';
  element: string;
  detail: string;
}

const area = (r: {x1: number; y1: number; x2: number; y2: number}) =>
  Math.max(0, r.x2 - r.x1) * Math.max(0, r.y2 - r.y1);

/**
 * Geometry checks from the UI tree. Only leaf-like text/clickable nodes are compared: containers
 * legitimately overlap their children. Clipping is reported only for nodes partly outside their
 * parent, which is how truncated or cut-off content shows up in the tree.
 */
export function layoutIssues(screen: Screen, limit = 20): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const leaves = screen.nodes.filter(
    (n) =>
      n.visible &&
      n.rect &&
      (n.text || n.desc) &&
      !screen.nodes.some((c) => c.parent === n.idx && c.visible && (c.text || c.desc)),
  );
  const name = (n: ScreenNode) => `${shortClass(n.cls)} "${labelOf(n)}"`;
  for (let i = 0; i < leaves.length; i++) {
    const a = leaves[i];
    const ra = a.rect!;
    if (area(ra) === 0) {
      issues.push({rule: 'zero-size', element: name(a), detail: 'visible node with empty bounds'});
      continue;
    }
    const parent = a.parent >= 0 ? screen.nodes[a.parent] : undefined;
    if (parent?.rect && a.text) {
      const rp = parent.rect;
      const overflow =
        Math.max(0, rp.x1 - ra.x1) +
        Math.max(0, ra.x2 - rp.x2) +
        Math.max(0, rp.y1 - ra.y1) +
        Math.max(0, ra.y2 - rp.y2);
      if (overflow > 4 && area(rp) > 0 && !parent.scrollable) {
        issues.push({rule: 'clipped', element: name(a), detail: `extends ${overflow}px beyond its container`});
      }
    }
    for (let j = i + 1; j < leaves.length; j++) {
      const b = leaves[j];
      if (b.parent === a.idx || a.parent === b.idx) {
        continue;
      }
      const rb = b.rect!;
      const ix = Math.max(0, Math.min(ra.x2, rb.x2) - Math.max(ra.x1, rb.x1));
      const iy = Math.max(0, Math.min(ra.y2, rb.y2) - Math.max(ra.y1, rb.y1));
      const inter = ix * iy;
      const smaller = Math.min(area(ra), area(rb));
      if (smaller > 0 && inter / smaller > 0.3) {
        issues.push({
          rule: 'overlap',
          element: name(a),
          detail: `overlaps ${name(b)} by ${Math.round((inter / smaller) * 100)}%`,
        });
      }
    }
    if (issues.length >= limit) {
      break;
    }
  }
  return issues.slice(0, limit);
}
