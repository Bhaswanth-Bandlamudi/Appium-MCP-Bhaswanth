import {describe, expect, test} from '@jest/globals';

import {parseScreen} from '../tools/intel/screen-model.js';
import {diffImages, layoutIssues} from '../tools/visual/visual-diff.js';
import type {Raw} from '../tools/visual/visual-diff.js';

const solid = (w: number, h: number, v: number): Raw => ({
  data: new Uint8Array(w * h * 3).fill(v),
  width: w,
  height: h,
  channels: 3,
});
function paint(img: Raw, x0: number, y0: number, w: number, h: number, v: number): Raw {
  const data = new Uint8Array(img.data);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      for (let c = 0; c < 3; c++) {
        data[(y * img.width + x) * 3 + c] = v;
      }
    }
  }
  return {...img, data};
}

describe('diffImages', () => {
  test('identical images report 0', () => {
    expect(diffImages(solid(100, 100, 50), solid(100, 100, 50)).changedPct).toBe(0);
  });
  test('sub-tolerance noise is ignored', () => {
    expect(diffImages(solid(100, 100, 50), solid(100, 100, 60)).changedPct).toBe(0);
  });
  test('a changed block is located as one region', () => {
    const a = solid(200, 200, 0);
    const b = paint(a, 64, 96, 64, 32, 255);
    const d = diffImages(a, b);
    expect(d.regions).toHaveLength(1);
    expect(d.regions[0]).toMatchObject({x: 64, y: 96, w: 64, h: 32});
    expect(d.changedPixels).toBe(64 * 32);
    expect(d.changedPct).toBe(5.1);
  });
  test('two separate blocks give two regions', () => {
    const a = solid(256, 256, 0);
    const b = paint(paint(a, 0, 0, 32, 32, 255), 192, 192, 32, 32, 255);
    expect(diffImages(a, b).regions).toHaveLength(2);
  });
  test('different dimensions are flagged, not compared', () => {
    expect(diffImages(solid(100, 100, 0), solid(100, 120, 0)).sameSize).toBe(false);
  });
});

describe('layoutIssues', () => {
  const xml = `<hierarchy><android.widget.FrameLayout bounds="[0,0][1000,2000]">
<android.widget.TextView text="Price" bounds="[100,100][500,200]"/>
<android.widget.TextView text="Total" bounds="[300,120][700,220]"/>
<android.widget.LinearLayout bounds="[0,300][400,400]"><android.widget.TextView text="Long label" bounds="[0,300][650,400]"/></android.widget.LinearLayout>
<android.widget.TextView text="Fine" bounds="[100,900][300,1000]"/>
</android.widget.FrameLayout></hierarchy>`;
  test('a clickable wrapper around a label is not reported as overlapping it', () => {
    const wrap = `<hierarchy><android.widget.FrameLayout bounds="[0,0][1000,2000]"><android.widget.LinearLayout clickable="true" bounds="[0,0][1000,100]"><android.widget.TextView text="Row" bounds="[0,0][500,100]"/></android.widget.LinearLayout></android.widget.FrameLayout></hierarchy>`;
    expect(layoutIssues(parseScreen(wrap))).toEqual([]);
  });
  test('overlap and clipping are found; clean element is not reported', () => {
    const issues = layoutIssues(parseScreen(xml));
    expect(issues.some((i) => i.rule === 'overlap' && i.element.includes('Price'))).toBe(true);
    expect(issues.some((i) => i.rule === 'clipped' && i.element.includes('Long label'))).toBe(true);
    expect(issues.some((i) => i.element.includes('Fine'))).toBe(false);
  });
});
