import {describe, expect, test} from '@jest/globals';

import {
  classifyTap,
  DEFAULT_DENY,
  ExploreMap,
  isBlockedByOverlay,
  screenFingerprint,
} from '../tools/explore/explorer.js';
import {parseScreen} from '../tools/intel/screen-model.js';

const o = {maxSteps: 10, maxDepth: 3, deny: DEFAULT_DENY};

describe('classifyTap', () => {
  test.each(['Delete account', 'Log out', 'Place bid', 'Pay now', 'Submit', 'Reset all settings', 'Sign out'])(
    'blocks %s',
    (l) => {
      expect(classifyTap(l, o).safe).toBe(false);
    },
  );
  test.each(['Network & internet', 'Settings', 'Search', 'Battery', 'Display'])('allows %s', (l) => {
    expect(classifyTap(l, o).safe).toBe(true);
  });
  test('whole-word match: "Bidding history" is not blocked by "bid"?', () => {
    // "bid" must not match inside a longer word such as "forbidden"
    expect(classifyTap('Forbidden zone', o).safe).toBe(true);
  });
  test('allowOnly restricts', () => {
    expect(classifyTap('Battery', {deny: [], allowOnly: ['net']}).safe).toBe(false);
    expect(classifyTap('Network', {deny: [], allowOnly: ['net']}).safe).toBe(true);
  });
});

const screenA = `<hierarchy><android.widget.FrameLayout bounds="[0,0][1000,2000]">
<android.widget.LinearLayout clickable="true" bounds="[0,100][1000,200]"><android.widget.TextView resource-id="a:id/title" text="Network" bounds="[0,100][500,200]"/></android.widget.LinearLayout>
<android.widget.LinearLayout clickable="true" bounds="[0,300][1000,400]"><android.widget.TextView resource-id="a:id/title" text="Delete data" bounds="[0,300][500,400]"/></android.widget.LinearLayout>
<android.widget.EditText resource-id="a:id/q" clickable="true" bounds="[0,500][1000,600]"/>
</android.widget.FrameLayout></hierarchy>`;

describe('ExploreMap', () => {
  test('skips destructive and input controls, queues safe ones, records the reason', () => {
    const m = new ExploreMap();
    const r = m.observe(parseScreen(screenA), 0, undefined, o);
    expect(r.next.map((c) => c.label)).toEqual(['Network']);
    expect(r.record.skipped).toEqual([{label: 'Delete data', reason: 'matches deny word "delete"'}]);
    expect(r.isNew).toBe(true);
  });
  test('the same screen is recognised and tried controls are not re-queued', () => {
    const m = new ExploreMap();
    const first = m.observe(parseScreen(screenA), 0, undefined, o);
    m.markTried(first.record.fingerprint, 'Network');
    const again = m.observe(parseScreen(screenA), 1, 'x', o);
    expect(again.isNew).toBe(false);
    expect(again.next).toHaveLength(0);
  });
  test('fingerprint ignores volatile text', () => {
    const a = parseScreen(screenA);
    const b = parseScreen(screenA.replace('text="Network"', 'text="Network (3)"'));
    expect(screenFingerprint(a)).toBe(screenFingerprint(b));
  });
});

describe('isBlockedByOverlay', () => {
  test('ANR dialog is detected; normal content is not', () => {
    const anr = `<hierarchy><android.widget.FrameLayout bounds="[0,0][1000,2000]"><android.widget.Button resource-id="android:id/aerr_wait" text="Wait" clickable="true" bounds="[0,0][100,100]"/></android.widget.FrameLayout></hierarchy>`;
    expect(isBlockedByOverlay(parseScreen(anr))).toBe(true);
    expect(isBlockedByOverlay(parseScreen(screenA))).toBe(false);
  });
});
