import {describe, expect, test} from '@jest/globals';

import {
  jaccard,
  labelSet,
  looksLikeSessionFailure,
  runExploration,
  SAME_SCREEN,
  screenPackage,
} from '../tools/explore/engine.js';
import type {EngineOptions, ExploreDevice} from '../tools/explore/engine.js';
import {DEFAULT_DENY} from '../tools/explore/explorer.js';
import {parseScreen} from '../tools/intel/screen-model.js';

const APP = 'com.test.app';

interface Page {
  /** Labels of tappable rows. */
  rows: string[];
  pkg?: string;
  overlay?: boolean;
}

/** Page XML with one clickable row per label. A stable id per label keeps fingerprints deterministic. */
const xml = (name: string, p: Page) => {
  const pkg = p.pkg ?? APP;
  const rows = p.rows
    .map(
      (r, i) =>
        `<android.widget.LinearLayout clickable="true" package="${pkg}" bounds="[0,${100 + i * 100}][1000,${190 + i * 100}]"><android.widget.TextView package="${pkg}" resource-id="${pkg}:id/row_${r.replace(/\W/g, '')}" text="${r}" bounds="[0,${100 + i * 100}][500,${190 + i * 100}]"/></android.widget.LinearLayout>`,
    )
    .join('');
  const overlay = p.overlay
    ? `<android.widget.Button resource-id="android:id/aerr_wait" text="Wait" clickable="true" package="android" bounds="[0,1500][500,1600]"/>`
    : '';
  return `<hierarchy><android.widget.FrameLayout package="${pkg}" bounds="[0,0][1000,2000]"><android.widget.TextView package="${pkg}" resource-id="${pkg}:id/title_${name}" text="${name}" bounds="[0,0][500,90]"/>${rows}${overlay}</android.widget.FrameLayout></hierarchy>`;
};

/** A tiny simulated app: pages, a "back" stack, optional foreign-package pages and scripted failures. */
class SimApp implements ExploreDevice {
  pages: Record<string, Page>;
  /** label on a page -> destination page name */
  links: Record<string, string>;
  stack: string[] = ['Home'];
  fg = APP;
  taps: string[] = [];
  backs = 0;
  activated = 0;
  dismissed = 0;
  recovered = 0;
  failNext: Error | undefined;
  recoverResult: {ok: boolean; detail: string} = {ok: true, detail: 'sim recovered'};
  noRecover = false;
  /** true: a foreign page is an activity on top of the app's task: back pops it, activate does not. */
  foreignOnTop = false;
  dialog = false;
  dialogSticky = false;
  private dead = false;

  constructor(pages: Record<string, Page>, links: Record<string, string>) {
    this.pages = pages;
    this.links = links;
  }
  get page(): string {
    return this.stack[this.stack.length - 1];
  }
  private calls = 0;
  private trace: string[] = [];
  private guard(what = '?') {
    this.trace.push(`${what}:${this.fg}:${this.stack.join('>')}`);
    if (++this.calls > 2000) {
      throw new Error(`SimApp runaway: ${this.trace.slice(-10).join(' / ')}`);
    }
    if (this.dead) {
      throw new Error('invalid session id');
    }
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      this.dead = true;
      throw e;
    }
  }
  async foreground() {
    this.guard('fg');
    return this.fg;
  }
  async snapshot() {
    this.guard('snap');
    const p = this.pages[this.page];
    return parseScreen(xml(this.page, {...p, pkg: this.fg === APP ? p.pkg : this.fg, overlay: this.dialog}));
  }
  async tap(c: {label: string}) {
    this.guard(`tap ${c.label}`);
    const dest = this.links[`${this.page}>${c.label}`];
    if (dest === undefined) {
      return 'missing' as const;
    }
    this.taps.push(`${this.page}>${c.label}`);
    if (dest.startsWith('pkg:')) {
      this.fg = dest.slice(4);
      return 'tapped' as const;
    }
    if (dest === '!dialog') {
      this.dialog = true;
      return 'tapped' as const;
    }
    if (dest !== this.page) {
      this.stack.push(dest);
    }
    return 'tapped' as const;
  }
  async back() {
    this.guard('back');
    this.backs++;
    if (this.fg !== APP) {
      if (this.foreignOnTop) {
        this.fg = APP;
      }
      return;
    }
    if (this.stack.length > 1) {
      this.stack.pop();
    }
  }
  async activate() {
    this.activated++;
    if (!this.foreignOnTop) {
      this.fg = APP;
    }
  }
  async dismissOverlay() {
    if (!this.dialog) {
      return false;
    }
    if (this.dialogSticky) {
      return false;
    }
    this.dialog = false;
    this.dismissed++;
    return true;
  }
  async screenshot(label: string) {
    return `shot_${label}.png`;
  }
  async recover() {
    this.recovered++;
    if (this.recoverResult.ok) {
      this.dead = false;
    }
    return this.recoverResult;
  }
  sleep = async () => undefined;
}

const opts = (over: Partial<EngineOptions> = {}): EngineOptions => ({
  appId: APP,
  maxSteps: 30,
  maxDepth: 3,
  maxScreens: 20,
  maxScreenshots: 5,
  maxRecoveries: 2,
  settleMs: 0,
  returnPolls: 3,
  deny: DEFAULT_DENY,
  ...over,
});

const threeScreenApp = () =>
  new SimApp(
    {Home: {rows: ['Alpha', 'Beta']}, AlphaPage: {rows: ['Gamma']}, BetaPage: {rows: []}, GammaPage: {rows: []}},
    {'Home>Alpha': 'AlphaPage', 'Home>Beta': 'BetaPage', 'AlphaPage>Gamma': 'GammaPage'},
  );

describe('exploration engine: success', () => {
  test('visits every reachable screen once, goes back correctly, and reports explored', async () => {
    const app = threeScreenApp();
    const r = await runExploration(app, opts());
    expect(r.status).toBe('explored');
    expect(r.counts.screens).toBe(4);
    expect(r.counts.taps).toBe(3);
    expect(new Set(app.taps).size).toBe(app.taps.length); // nothing tapped twice
    expect(
      r.screens
        .map((s) => s.via)
        .filter(Boolean)
        .sort(),
    ).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(r.unexplored).toEqual([]);
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.history.length).toBeGreaterThan(0);
  });
  test('records parentage and depth', async () => {
    const r = await runExploration(threeScreenApp(), opts());
    const gamma = r.screens.find((s) => s.via === 'Gamma')!;
    expect(gamma.depth).toBe(2);
    expect(r.screens.find((s) => s.id === gamma.parent)?.via).toBe('Alpha');
  });
});

describe('exploration engine: the previous failure (a control that opens another app)', () => {
  test('relaunches the app, records the boundary control, and keeps exploring other screens', async () => {
    const app = new SimApp(
      {Home: {rows: ['Search', 'Network']}, NetPage: {rows: ['Wifi']}, WifiPage: {rows: []}},
      {'Home>Search': 'pkg:com.google.intelligence', 'Home>Network': 'NetPage', 'NetPage>Wifi': 'WifiPage'},
    );
    const r = await runExploration(app, opts());
    expect(r.counts.boundaryExits).toBe(1);
    expect(r.boundaryControls[0]).toMatch(/Search/);
    expect(app.activated).toBeGreaterThanOrEqual(1);
    // The old implementation stopped here with one screen. It must now have reached the other branch.
    expect(r.counts.screens).toBe(3);
    expect(r.status).toBe('explored');
  });
  test('REAL CASE: a foreign activity on top of the app task is popped with back (relaunch alone cannot clear it)', async () => {
    const app = new SimApp(
      {Home: {rows: ['Search', 'Network']}, NetPage: {rows: ['Wifi']}, WifiPage: {rows: []}},
      {
        'Home>Search': 'pkg:com.google.settings.intelligence',
        'Home>Network': 'NetPage',
        'Home>Search2': 'x',
        'NetPage>Wifi': 'WifiPage',
      },
    );
    app.foreignOnTop = true;
    const r = await runExploration(app, opts());
    expect(r.counts.boundaryExits).toBe(1);
    expect(app.backs).toBeGreaterThanOrEqual(1);
    expect(r.counts.screens).toBe(3);
    expect(r.status).toBe('explored');
  });
  test('a boundary that cannot be undone ends as app-boundary, not as success', async () => {
    const app = new SimApp({Home: {rows: ['Out']}}, {'Home>Out': 'pkg:com.other'});
    app.activate = async () => undefined; // the OS refuses to bring the app back
    app.back = async () => undefined; // and back does not help either
    const r = await runExploration(app, opts());
    expect(r.status).toBe('app-boundary');
    expect(r.detail).toMatch(/com\.other/);
  });
});

describe('exploration engine: stop reasons', () => {
  test('action limit -> limits', async () => {
    const r = await runExploration(threeScreenApp(), opts({maxSteps: 1}));
    expect(r.status).toBe('limits');
    expect(r.detail).toMatch(/action limit/);
    expect(r.counts.taps).toBe(1);
  });
  test('screen limit -> limits', async () => {
    const r = await runExploration(threeScreenApp(), opts({maxScreens: 2}));
    expect(r.status).toBe('limits');
    expect(r.detail).toMatch(/screen limit/);
    expect(r.counts.screens).toBeLessThanOrEqual(2);
  });
  test('depth limit prevents deeper taps and lists them as unexplored history, without failing', async () => {
    const r = await runExploration(threeScreenApp(), opts({maxDepth: 1}));
    expect(r.screens.some((s) => s.via === 'Gamma')).toBe(false);
    expect(r.history.join('\n')).toMatch(/depth limit/);
  });
  test('only restricted controls -> safety, nothing tapped', async () => {
    const app = new SimApp({Home: {rows: ['Delete account', 'Place bid', 'Log out']}}, {});
    const r = await runExploration(app, opts());
    expect(r.status).toBe('safety');
    expect(r.counts.taps).toBe(0);
    expect(r.safetySkipped.map((s) => s.label).sort()).toEqual(['Delete account', 'Log out', 'Place bid']);
  });
  test('restricted controls are never tapped even alongside safe ones', async () => {
    const app = new SimApp(
      {Home: {rows: ['Delete account', 'Profile']}, ProfilePage: {rows: []}},
      {'Home>Profile': 'ProfilePage', 'Home>Delete account': 'BOOM'},
    );
    const r = await runExploration(app, opts());
    expect(app.taps.some((t) => /Delete/.test(t))).toBe(false);
    expect(r.safetySkipped.map((s) => s.label)).toContain('Delete account');
    expect(r.status).toBe('explored');
  });
  test('a dialog that cannot be cleared -> device-failure with the reason', async () => {
    const app = new SimApp({Home: {rows: ['Open']}, P: {rows: []}}, {'Home>Open': '!dialog'});
    app.dialogSticky = true;
    const r = await runExploration(app, opts());
    expect(r.status).toBe('device-failure');
    expect(r.detail).toMatch(/dialog/);
  });
  test('a dialog that can be cleared is cleared and exploration continues', async () => {
    const app = new SimApp(
      {Home: {rows: ['Open', 'Next']}, NextPage: {rows: []}},
      {'Home>Open': '!dialog', 'Home>Next': 'NextPage'},
    );
    const r = await runExploration(app, opts());
    expect(app.dismissed).toBeGreaterThanOrEqual(1);
    expect(r.counts.overlaysDismissed).toBeGreaterThanOrEqual(1);
    expect(r.status).toBe('explored');
    expect(r.screens.some((s) => s.via === 'Next')).toBe(true);
  });
  test('an unexpected exception in the engine -> error status, not a throw', async () => {
    const app = threeScreenApp();
    app.snapshot = async () => {
      throw new TypeError('boom');
    };
    const r = await runExploration(app, opts());
    expect(['error', 'device-failure']).toContain(r.status);
  });
});

describe('exploration engine: recovery keeps context', () => {
  test('a session failure mid-run is recovered once and exploration continues with history intact', async () => {
    const app = threeScreenApp();
    let n = 0;
    const origTap = app.tap.bind(app);
    app.tap = async (c) => {
      n++;
      if (n === 2) {
        app.failNext = new Error('instrumentation process is not running');
      }
      return origTap(c);
    };
    const r = await runExploration(app, opts());
    expect(app.recovered).toBe(1);
    expect(r.counts.recoveries).toBe(1);
    expect(r.counts.screens).toBeGreaterThanOrEqual(3);
    expect(r.history.join('\n')).toMatch(/recovered/);
    expect(['explored', 'limits']).toContain(r.status);
  });
  test('recovery that fails -> device-failure with the recovery detail', async () => {
    const app = threeScreenApp();
    app.failNext = new Error('invalid session id');
    app.recoverResult = {ok: false, detail: 'refused: recovery limit reached'};
    const r = await runExploration(app, opts());
    expect(r.status).toBe('device-failure');
    expect(r.detail).toMatch(/recovery failed/);
  });
  test('recovery is bounded: a device that keeps failing is not recovered forever', async () => {
    const app = threeScreenApp();
    const orig = app.snapshot.bind(app);
    app.snapshot = async () => {
      app.failNext = new Error('invalid session id');
      return orig();
    };
    const r = await runExploration(app, opts({maxRecoveries: 2}));
    expect(r.counts.recoveries).toBeLessThanOrEqual(2);
    expect(r.status).toBe('device-failure');
  });
  test('an element-level error is not mistaken for a session failure', async () => {
    expect(looksLikeSessionFailure(new Error('An element could not be located on the page'))).toBe(false);
    expect(looksLikeSessionFailure(new Error('invalid session id'))).toBe(true);
    expect(looksLikeSessionFailure(new Error('The instrumentation process cannot be initialized'))).toBe(true);
    expect(looksLikeSessionFailure('socket hang up')).toBe(true);
    expect(looksLikeSessionFailure(new Error('A session is either terminated or not started'))).toBe(true);
  });
  test('without a recover capability a session failure is a device failure', async () => {
    const app = threeScreenApp();
    app.failNext = new Error('invalid session id');
    (app as {recover?: unknown}).recover = undefined; // shadows the prototype method
    const r = await runExploration(app, opts());
    expect(r.status).toBe('device-failure');
  });
});

describe('screenPackage', () => {
  test('picks the package most visible nodes belong to', () => {
    expect(screenPackage(parseScreen(xml('X', {rows: ['A', 'B'], pkg: 'com.foreign'})))).toBe('com.foreign');
  });
});

describe('exploration engine: loading screens and honest completion', () => {
  test('a screen that is still loading after a relaunch is waited out, not treated as "nothing left"', async () => {
    const app = new SimApp({Home: {rows: ['Alpha']}, AlphaPage: {rows: []}}, {'Home>Alpha': 'AlphaPage'});
    let loads = 0;
    const real = app.snapshot.bind(app);
    app.snapshot = async () => {
      loads++;
      if (loads <= 3) {
        return parseScreen(xml('Loading', {rows: []})); // empty, no controls
      }
      return real();
    };
    const r = await runExploration(app, opts());
    expect(r.counts.loadingWaits).toBeGreaterThanOrEqual(1);
    expect(r.counts.taps).toBeGreaterThanOrEqual(1);
    expect(r.screens.some((s) => s.via === 'Alpha')).toBe(true);
  });
  test('stopping with untried controls on a known screen is "incomplete", never "explored"', async () => {
    const app = new SimApp(
      {Home: {rows: ['Out', 'Beta']}, BetaPage: {rows: []}},
      {'Home>Out': 'pkg:com.other', 'Home>Beta': 'BetaPage'},
    );
    // After leaving, the app comes back on a different, empty screen that has no way to reach Home's remaining control.
    const realActivate = app.activate.bind(app);
    app.activate = async () => {
      await realActivate();
      app.pages.Home = {rows: []};
    };
    const r = await runExploration(app, opts());
    expect(['incomplete', 'explored']).toContain(r.status);
    if (r.screens.some((s) => s.untried > 0)) {
      expect(r.status).not.toBe('explored');
    }
  });
});

describe('screen identity', () => {
  const page = (rows: string[]) => parseScreen(xml('Home', {rows}));
  test('the same screen with a few more lazily loaded rows is the same screen', () => {
    const a = labelSet(page(['A', 'B', 'C', 'D', 'E', 'F']));
    const b = labelSet(page(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']));
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(SAME_SCREEN);
  });
  test('a genuinely different screen is not the same screen', () => {
    const a = labelSet(parseScreen(xml('Home', {rows: ['A', 'B', 'C', 'D']})));
    const b = labelSet(parseScreen(xml('Other', {rows: ['W', 'X', 'Y', 'Z']})));
    expect(jaccard(a, b)).toBeLessThan(SAME_SCREEN);
  });
  test('numbers that change (counts, prices) do not make a screen look new', () => {
    const mk = (n: string) => parseScreen(xml('Home', {rows: ['Inbox', 'Sent', `Total ${n}00000`]}));
    expect(jaccard(labelSet(mk('1')), labelSet(mk('2')))).toBe(1);
  });
  test('exploration does not create a new screen for each lazy-load state of the same screen', async () => {
    const app = threeScreenApp();
    let n = 0;
    const real = app.snapshot.bind(app);
    app.snapshot = async () => {
      n++;
      const s = await real();
      return n % 2 === 0 && app.page === 'Home'
        ? parseScreen(xml('Home', {rows: ['Alpha', 'Beta', 'Extra1', 'Extra2']}))
        : s;
    };
    const r = await runExploration(app, opts());
    expect(r.counts.screens).toBeLessThanOrEqual(5);
  });
});

describe('exploration engine: the page, not just the foreground query, decides which app we are in', () => {
  test('foreground query says the app is in front but the page belongs to another package: back is pressed', async () => {
    const app = new SimApp({Home: {rows: ['Alpha']}, AlphaPage: {rows: []}}, {'Home>Alpha': 'AlphaPage'});
    app.foreignOnTop = true;
    // A lagging foreground query: always claims the app. The page ownership is the truth.
    app.foreground = async () => APP;
    app.fg = 'com.google.intelligence';
    const r = await runExploration(app, opts());
    expect(app.backs).toBeGreaterThanOrEqual(1);
    expect(r.counts.taps).toBeGreaterThanOrEqual(1);
    expect(r.status).not.toBe('error');
  });
});

describe('exploration engine: slow transitions', () => {
  test('a Back that only takes effect after several polls is waited for, not declared stuck', async () => {
    const app = new SimApp(
      {Home: {rows: ['Out', 'Next']}, NextPage: {rows: []}},
      {'Home>Out': 'pkg:com.other', 'Home>Next': 'NextPage'},
    );
    const popped = {pending: false, polls: 0};
    // Back is acknowledged immediately but the foreign activity is only gone after 3 foreground checks.
    app.back = async () => {
      app.backs++;
      if (app.fg !== APP) {
        popped.pending = true;
        popped.polls = 0;
      } else if (app.stack.length > 1) {
        app.stack.pop();
      }
    };
    app.activate = async () => undefined; // relaunch does nothing, as with a foreign activity in the same task
    const fgBefore = app.foreground.bind(app);
    app.foreground = async () => {
      if (popped.pending) {
        popped.polls++;
        if (popped.polls >= 3) {
          popped.pending = false;
          app.fg = APP;
        }
      }
      return fgBefore();
    };
    const r = await runExploration(app, opts({returnPolls: 6}));
    if (r.status !== 'explored') {
      throw new Error(`status=${r.status} detail=${r.detail} history=${r.history.slice(-8).join(' // ')}`);
    }
    expect(r.screens.some((s) => s.via === 'Next')).toBe(true);
  });
  test('with too few polls the same slow Back is reported as app-boundary, never as success', async () => {
    const app = new SimApp({Home: {rows: ['Out']}}, {'Home>Out': 'pkg:com.other'});
    app.activate = async () => undefined;
    app.back = async () => undefined; // never returns
    const r = await runExploration(app, opts({returnPolls: 1}));
    expect(r.status).toBe('app-boundary');
  });
});

describe('exploration engine: termination', () => {
  test('a leaf page with no controls is visited without waiting on it forever', async () => {
    const app = new SimApp({Home: {rows: ['Leaf']}, LeafPage: {rows: []}}, {'Home>Leaf': 'LeafPage'});
    const r = await runExploration(app, opts());
    expect(r.status).toBe('explored');
    expect(r.counts.loadingWaits).toBeLessThanOrEqual(4);
  });
  test('an app that changes at every snapshot cannot make the engine run unbounded', async () => {
    const app = threeScreenApp();
    let n = 0;
    app.snapshot = async () => parseScreen(xml(`Page${n++}`, {rows: [`Row${n}`, `Other${n}`]}));
    app.tap = async () => 'tapped';
    const r = await runExploration(app, opts({maxSteps: 6, maxScreens: 6}));
    expect(['limits', 'explored', 'incomplete', 'device-failure', 'app-boundary']).toContain(r.status);
    expect(r.counts.taps).toBeLessThanOrEqual(6);
  });
});

describe('exploration engine: Back that does nothing', () => {
  test('a screen that Back cannot leave ends with a specific, non-success status', async () => {
    const app = threeScreenApp();
    app.back = async () => {
      app.backs++; // the page never changes
    };
    const r = await runExploration(app, opts());
    expect(['incomplete', 'limits']).toContain(r.status);
    expect(r.detail).toMatch(/back|iteration|limit/i);
    expect(r.counts.backs).toBeLessThan(40);
  });
});

describe('exploration engine: climbing out of a deep branch', () => {
  test('six consecutive Backs from a depth-6 branch are not mistaken for a stuck Back', async () => {
    const pages: Record<string, {rows: string[]}> = {Home: {rows: ['L1']}};
    const links: Record<string, string> = {'Home>L1': 'P1'};
    for (let i = 1; i <= 6; i++) {
      pages[`P${i}`] = {rows: i < 6 ? [`L${i + 1}`] : []};
      if (i < 6) {
        links[`P${i}>L${i + 1}`] = `P${i + 1}`;
      }
    }
    const app = new SimApp(pages, links);
    const r = await runExploration(app, opts({maxDepth: 6, maxSteps: 20, maxScreens: 20}));
    expect(r.status).toBe('explored');
    expect(r.counts.screens).toBe(7);
    expect(r.counts.backs).toBeGreaterThanOrEqual(6);
  });
});

describe('exploration engine: leaves the app in front', () => {
  test('a run that ends on the action limit while another app is showing brings the app back', async () => {
    const app = new SimApp({Home: {rows: ['Out']}}, {'Home>Out': 'pkg:com.other'});
    app.foreignOnTop = true;
    const r = await runExploration(app, opts({maxSteps: 1}));
    expect(r.status).toBe('limits');
    expect(app.fg).toBe(APP);
  });
  test('a normal completed run also ends with the app in front', async () => {
    const app = threeScreenApp();
    await runExploration(app, opts());
    expect(app.fg).toBe(APP);
  });
});
