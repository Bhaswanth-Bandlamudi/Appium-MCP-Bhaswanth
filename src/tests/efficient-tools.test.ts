import {describe, expect, test} from '@jest/globals';

import {compactPageSource, diffLines, formatNode, parseLocator} from '../tools/efficient/compact-screen.js';

const xml = `<hierarchy><android.widget.FrameLayout bounds="[0,0][100,100]">
<android.widget.Button resource-id="a:id/ok" text="OK" clickable="true" enabled="true" bounds="[0,0][100,50]"/>
<android.widget.TextView text="⁦$126.50⁩" bounds="[0,50][100,100]"/>
<android.widget.LinearLayout bounds="[0,0][1,1]"/>
</android.widget.FrameLayout></hierarchy>`;

describe('compactPageSource', () => {
  test('keeps actionable nodes, drops bare layouts, strips bidi marks', () => {
    const lines = compactPageSource(xml).map(formatNode);
    expect(lines).toEqual(['Button id=a:id/ok text=OK [c] @50,25', 'TextView text=$126.50 @50,75']);
  });
  test('diffLines', () => {
    expect(diffLines(['a', 'b'], ['b', 'c'])).toEqual({added: ['c'], removed: ['a'], unchanged: 1});
  });
});

describe('parseLocator', () => {
  test('grammar', () => {
    expect(parseLocator('id=x:id/y', true)).toEqual({strategy: 'id', selector: 'x:id/y'});
    expect(parseLocator("text=It's", true).selector).toBe(`//*[@text="It's"]`);
    expect(() => parseLocator('bogus', true)).toThrow();
  });
});

describe('clickable container folding', () => {
  test('unlabeled clickable row is merged into its labelled child, not emitted alone', () => {
    const src = `<hierarchy><android.widget.FrameLayout bounds="[0,0][100,100]">
<android.widget.LinearLayout clickable="true" bounds="[0,0][100,50]">
<android.widget.TextView resource-id="android:id/title" text="Wi-Fi" bounds="[0,0][50,20]"/>
</android.widget.LinearLayout></android.widget.FrameLayout></hierarchy>`;
    const lines = compactPageSource(src).map(formatNode);
    expect(lines).toEqual(['TextView id=android:id/title text=Wi-Fi [c] @50,25']);
  });
});
