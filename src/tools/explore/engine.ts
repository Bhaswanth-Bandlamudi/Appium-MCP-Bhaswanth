import {analyzeScreen} from '../intel/engines.js';
import type {Screen} from '../intel/screen-model.js';
import {candidates, classifyTap, isBlockedByOverlay} from './explorer.js';
import type {Candidate, ExploreOptions} from './explorer.js';

export type ExploreStatus =
  | 'explored' // everything reachable by safe taps within the limits was visited
  | 'app-boundary' // could not get back into the target app
  | 'safety' // nothing was tapped because every available control is restricted
  | 'device-failure' // device, session or an uncleared system dialog stopped the run
  | 'limits' // a configured action, screen or depth limit ended the run
  | 'incomplete' // stopped with untried controls left on known screens and no way back to them
  | 'error'; // unexpected exception inside the engine

export interface ExploreDevice {
  /** Foreground package or bundle id, if the platform can tell. */
  foreground(): Promise<string | undefined>;
  snapshot(): Promise<Screen>;
  tap(c: Candidate): Promise<'tapped' | 'missing'>;
  back(): Promise<void>;
  activate(appId: string): Promise<void>;
  /** Try to clear a system dialog (ANR, permission). True when something was dismissed. */
  dismissOverlay(): Promise<boolean>;
  /** Save a screenshot and return its path, or undefined when unavailable. */
  screenshot?(label: string): Promise<string | undefined>;
  /** Replace a dead session. Context held by the engine is kept. */
  recover?(): Promise<{ok: boolean; detail: string}>;
  sleep(ms: number): Promise<void>;
}

export interface EngineOptions extends ExploreOptions {
  appId: string;
  maxScreens: number;
  maxScreenshots: number;
  maxRecoveries: number;
  settleMs: number;
  /** How many times to re-check, settleMs apart, after Back or a relaunch before trying the next remedy (default 6). */
  returnPolls: number;
}

export interface ScreenSummary {
  id: string;
  type: string;
  depth: number;
  parent?: string;
  via?: string;
  untried: number;
  skipped: {label: string; reason: string}[];
  findings: string[];
}

export interface ExploreReport {
  status: ExploreStatus;
  detail: string;
  counts: {
    taps: number;
    screens: number;
    backs: number;
    relaunches: number;
    recoveries: number;
    overlaysDismissed: number;
    boundaryExits: number;
    loadingWaits: number;
  };
  screens: ScreenSummary[];
  unexplored: {screen: string; label: string}[];
  safetySkipped: {screen: string; label: string; reason: string}[];
  boundaryControls: string[];
  history: string[];
  evidence: string[];
}

/** Readable strings on a page: what a person would use to tell two screens apart. */
export function labelSet(screen: Screen): Set<string> {
  const out = new Set<string>();
  for (const n of screen.nodes) {
    if (!n.visible) {
      continue;
    }
    for (const v of [n.text, n.desc]) {
      if (v && v.length > 1 && v.length < 80 && !/\d{3,}/.test(v)) {
        out.add(v);
      }
    }
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) {
      inter++;
    }
  }
  return inter / (a.size + b.size - inter);
}

/** Two snapshots are the same screen when most of their readable strings agree; lazy-loaded rows must not create a new screen. */
export const SAME_SCREEN = 0.6;

/** Errors that mean the Appium session or driver is gone, as opposed to an element problem. */
export function looksLikeSessionFailure(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err);
  return /invalid session|no such (driver|session)|session (is )?(not|has) (found|started|terminated|ended)|(terminated|ended) or not started|instrumentation process|UiAutomator2 server|socket hang up|ECONNREFUSED|ECONNRESET|cannot be proxied|not running|has crashed|terminated|NoSuchDriver/i.test(
    m,
  );
}

/** Package that most visible nodes of a page belong to. */
export function screenPackage(screen: Screen): string | undefined {
  const counts = new Map<string, number>();
  for (const n of screen.nodes) {
    if (n.pkg && n.visible) {
      counts.set(n.pkg, (counts.get(n.pkg) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [p, c] of counts) {
    if (c > bestN) {
      best = p;
      bestN = c;
    }
  }
  return best;
}

const SYSTEM_PKGS =
  /^(com\.android\.systemui|android|com\.google\.android\.permissioncontroller|com\.android\.permissioncontroller)$/;

/**
 * The exploration state machine. All device access goes through `ExploreDevice`, so every stop reason
 * can be reproduced in tests with a simulated app. Visited-screen context lives in this closure and
 * survives a session recovery.
 */
export async function runExploration(device: ExploreDevice, o: EngineOptions): Promise<ExploreReport> {
  const screens = new Map<string, ScreenSummary & {n: number}>();
  const labels = new Map<string, Set<string>>();
  let seq = 0;
  /** Canonical key for a snapshot: an existing screen it matches, else a new key. */
  const identify = (s: Screen): string => {
    const mine = labelSet(s);
    let best: string | undefined;
    let bestScore = 0;
    for (const [k, l] of labels) {
      const sc = jaccard(mine, l);
      if (sc > bestScore) {
        bestScore = sc;
        best = k;
      }
    }
    if (best !== undefined && bestScore >= SAME_SCREEN) {
      // keep the richer snapshot so later comparisons see lazily loaded rows
      const kept = labels.get(best) as Set<string>;
      for (const x of mine) {
        kept.add(x);
      }
      return best;
    }
    const key = `k${++seq}`;
    labels.set(key, mine);
    return key;
  };
  const tried = new Set<string>();
  const parent = new Map<string, string | undefined>();
  const history: string[] = [];
  const evidence: string[] = [];
  const boundaryControls: string[] = [];
  const safetySkipped = new Map<string, {screen: string; label: string; reason: string}>();
  const counts = {
    taps: 0,
    screens: 0,
    backs: 0,
    relaunches: 0,
    recoveries: 0,
    overlaysDismissed: 0,
    boundaryExits: 0,
    loadingWaits: 0,
  };
  let status: ExploreStatus = 'explored';
  let detail = 'explored everything reachable within the limits';
  let shots = 0;

  const log = (s: string) => {
    if (history.length < 400) {
      history.push(`${history.length + 1}. ${s}`);
    }
  };
  const shot = async (label: string, force = false) => {
    if (!device.screenshot || (!force && shots >= o.maxScreenshots)) {
      return;
    }
    try {
      const p = await device.screenshot(label);
      if (p) {
        shots++;
        evidence.push(p);
      }
    } catch {
      // evidence is best effort
    }
  };
  const stop = async (s: ExploreStatus, d: string) => {
    status = s;
    detail = d;
    await shot(`stop-${s}`, true);
  };
  const idOf = (fp: string) => {
    let rec = screens.get(fp);
    if (!rec) {
      rec = {
        id: `S${screens.size + 1}`,
        type: '',
        depth: 0,
        untried: 0,
        skipped: [],
        findings: [],
        n: screens.size + 1,
      };
      screens.set(fp, rec);
    }
    return rec.id;
  };
  const depthOf = (fp: string): number => {
    let d = 0;
    let cur = parent.get(fp);
    const seen = new Set<string>([fp]);
    while (cur !== undefined && !seen.has(cur)) {
      d++;
      seen.add(cur);
      cur = parent.get(cur);
    }
    return d;
  };

  const foregroundOrUnknown = () =>
    device.foreground().catch((err) => {
      if (looksLikeSessionFailure(err)) {
        throw err;
      }
      return undefined;
    });

  /**
   * Make sure the target app is in front. A control can open an activity owned by another package inside the
   * app's own task (for example the settings search screen). Relaunching only brings that task forward and leaves
   * the foreign activity on top, so Back is tried first; relaunch is the fallback for a different task.
   */
  /** True when neither the foreground query nor the page itself points at another app. */
  const inApp = async (): Promise<{ok: boolean; other?: string}> => {
    const fg = await foregroundOrUnknown();
    let pagePkg: string | undefined;
    try {
      pagePkg = pageIsForeign(await device.snapshot());
    } catch (err) {
      if (looksLikeSessionFailure(err)) {
        throw err;
      }
    }
    const other = pagePkg ?? (fg && fg !== o.appId ? fg : undefined);
    return other ? {ok: false, other} : {ok: true};
  };

  /** Activity transitions are slow on busy hosts: poll for the result instead of assuming a fixed delay. */
  const waitInApp = async (): Promise<{ok: boolean; other?: string}> => {
    let last = await inApp();
    for (let i = 0; i < o.returnPolls && !last.ok; i++) {
      await device.sleep(o.settleMs);
      last = await inApp();
    }
    return last;
  };

  const ensureInApp = async (): Promise<boolean> => {
    let state = await inApp();
    for (let i = 0; i < 6 && !state.ok; i++) {
      if (i % 2 === 0) {
        log(`foreground is ${state.other}; pressing back`);
        await device.back().catch(() => undefined);
        counts.backs++;
      } else {
        counts.relaunches++;
        log(`foreground is ${state.other}; relaunching ${o.appId}`);
        await device.activate(o.appId).catch(() => undefined);
      }
      state = await waitInApp();
    }
    return state.ok;
  };

  /** True when the page itself belongs to another app (the foreground query can lag behind the real screen). */
  const pageIsForeign = (s: Screen): string | undefined => {
    const p = screenPackage(s);
    return p && p !== o.appId && !SYSTEM_PKGS.test(p) ? p : undefined;
  };

  /** Snapshot, clearing system dialogs first. Returns undefined when a dialog could not be cleared. */
  const settle = async (): Promise<Screen | undefined> => {
    for (let i = 0; i < 4; i++) {
      const s = await device.snapshot();
      if (!isBlockedByOverlay(s)) {
        return s;
      }
      const cleared = await device.dismissOverlay().catch(() => false);
      if (cleared) {
        counts.overlaysDismissed++;
        log('dismissed a system dialog');
        await device.sleep(o.settleMs);
      } else {
        await shot('uncleared-dialog', true);
        return undefined;
      }
    }
    return undefined;
  };

  /**
   * A near-empty screen right after a relaunch is often still loading. Each distinct screen is waited on at most
   * once: a leaf page with no controls is a real page, and waiting again on every visit would loop forever.
   */
  const waitedOn = new Set<string>();
  let loadingBudget = 4;
  const settleLoaded = async (first: Screen): Promise<Screen> => {
    let s = first;
    for (let i = 0; i < 6 && loadingBudget > 0; i++) {
      const a = analyzeScreen(s);
      if (!a.screenType.startsWith('sparse') || candidates(s).length > 0) {
        return s;
      }
      const key = [...labelSet(s)].sort().join('|');
      if (waitedOn.has(key) && i === 0) {
        return s; // seen empty before and already waited: treat as a leaf page
      }
      waitedOn.add(key);
      loadingBudget--;
      counts.loadingWaits++;
      log('screen looks like it is still loading; waiting');
      await device.sleep(Math.max(o.settleMs, 1500));
      const next = await settle();
      if (!next) {
        return s;
      }
      s = next;
    }
    return s;
  };

  const observeCurrent = (screen: Screen) => {
    const fp = identify(screen);
    const known = screens.has(fp);
    const rec = screens.get(fp);
    const a = analyzeScreen(screen);
    const cands = candidates(screen);
    const next: Candidate[] = [];
    const skipped: {label: string; reason: string}[] = [];
    for (const c of cands) {
      const d = classifyTap(c.label, o);
      if (!d.safe) {
        skipped.push({label: c.label, reason: d.reason});
        safetySkipped.set(`${fp}>${c.label}`, {screen: idOf(fp), label: c.label, reason: d.reason});
      } else if (!tried.has(`${fp}>${c.label}`)) {
        next.push(c);
      }
    }
    const id = idOf(fp);
    const r = screens.get(fp) as ScreenSummary & {n: number};
    if (!known || !rec?.type) {
      r.type = a.screenType;
      r.findings = [
        ...(a.dialog ? ['dialog/alert present'] : []),
        ...(a.screenType.startsWith('sparse') ? ['very few visible elements (loading or empty?)'] : []),
      ];
    }
    r.skipped = skipped.slice(0, 8);
    r.untried = next.length;
    return {fp, id, isNew: !known, next};
  };

  const recoverOrFail = async (err: unknown): Promise<'recovered' | 'failed'> => {
    if (!device.recover || counts.recoveries >= o.maxRecoveries || !looksLikeSessionFailure(err)) {
      await stop(
        'device-failure',
        `session or device failure: ${String((err as Error)?.message ?? err).slice(0, 160)}`,
      );
      return 'failed';
    }
    counts.recoveries++;
    log(`session failure (${String((err as Error)?.message ?? err).slice(0, 80)}); recovering`);
    const r = await device.recover().catch((e) => ({ok: false, detail: String((e as Error)?.message ?? e)}));
    if (!r.ok) {
      await stop('device-failure', `session recovery failed: ${r.detail.slice(0, 160)}`);
      return 'failed';
    }
    log(`recovered: ${r.detail.slice(0, 100)}`);
    if (!(await ensureInApp())) {
      await stop('app-boundary', `could not bring ${o.appId} to the front after recovery`);
      return 'failed';
    }
    return 'recovered';
  };

  let screen: Screen | undefined;
  let currentFp: string;
  try {
    try {
      if (!(await ensureInApp())) {
        await stop('app-boundary', `${o.appId} is not in front and could not be brought there`);
        return finish();
      }
    } catch (err) {
      if ((await recoverOrFail(err)) === 'failed') {
        return finish();
      }
    }
    screen = await settle();
    if (!screen) {
      await stop('device-failure', 'a system dialog covers the app and could not be dismissed');
      return finish();
    }
    screen = await settleLoaded(screen);
    const first = observeCurrent(screen);
    currentFp = first.fp;
    parent.set(currentFp, undefined);
    log(`start on ${first.id} (${screens.get(currentFp)?.type})`);
    await shot(first.id);

    let iterations = 0;
    let stuckBacks = 0;
    let lastBackFrom = '';
    const maxIterations = o.maxSteps * 12 + o.maxScreens * 6 + 50;
    for (;;) {
      if (++iterations > maxIterations) {
        await stop(
          'limits',
          `internal iteration limit (${maxIterations}) reached without finishing; the app may be changing between snapshots`,
        );
        break;
      }
      if (counts.taps >= o.maxSteps) {
        await stop('limits', `action limit (${o.maxSteps}) reached`);
        break;
      }
      let obs;
      try {
        screen = await settle();
        if (!screen) {
          await stop('device-failure', 'a system dialog could not be dismissed');
          break;
        }
        let foreign = pageIsForeign(screen);
        for (let k = 0; foreign && k < 3; k++) {
          counts.boundaryExits++;
          boundaryControls.push(`(page belongs to ${foreign})`);
          log(`current page belongs to ${foreign}, not ${o.appId}; returning`);
          if (!(await ensureInApp())) {
            await stop('app-boundary', `the screen belongs to ${foreign} and ${o.appId} could not be brought back`);
            return finish();
          }
          const again = await settle();
          if (!again) {
            await stop('device-failure', 'a system dialog could not be dismissed');
            return finish();
          }
          screen = again;
          foreign = pageIsForeign(screen);
        }
        if (foreign) {
          await stop('app-boundary', `the screen still belongs to ${foreign} after returning`);
          return finish();
        }
        screen = await settleLoaded(screen);
        obs = observeCurrent(screen);
      } catch (err) {
        if ((await recoverOrFail(err)) === 'failed') {
          break;
        }
        // Context kept; re-anchor on whatever screen the app shows now.
        try {
          screen = await settle();
          if (!screen) {
            await stop('device-failure', 'a system dialog covers the app after recovery');
            break;
          }
          const o2 = observeCurrent(screen);
          if (o2.isNew) {
            parent.set(o2.fp, undefined);
          }
          currentFp = o2.fp;
        } catch (err2) {
          await stop(
            'device-failure',
            `snapshot failed after recovery: ${String((err2 as Error)?.message ?? err2).slice(0, 120)}`,
          );
          break;
        }
        continue;
      }
      currentFp = obs.fp;
      if (obs.isNew) {
        // A screen reached by something other than a tracked tap (relaunch, recovery) keeps no parent.
        if (!parent.has(obs.fp)) {
          parent.set(obs.fp, undefined);
        }
      }
      const rec = screens.get(currentFp) as ScreenSummary;
      rec.depth = depthOf(currentFp);

      const cand = obs.next.shift();
      if (!cand) {
        const up = parent.get(currentFp);
        if (up === undefined) {
          const left = [...screens.values()].filter((s) => s.untried > 0 && s.id !== obs.id);
          if (left.length > 0) {
            status = 'incomplete';
            detail = `stopped on ${obs.id} with untried controls remaining on ${left.map((s) => s.id).join(', ')}; the app could not be returned to those screens`;
            await shot('incomplete', true);
          } else {
            status = 'explored';
            detail = 'explored everything reachable within the limits';
          }
          break;
        }
        // Several Backs in a row are normal when climbing out of a deep branch; only repeats from the SAME screen mean Back is not working.
        stuckBacks = lastBackFrom === currentFp ? stuckBacks + 1 : 1;
        lastBackFrom = currentFp;
        if (stuckBacks > 3) {
          await stop(
            'incomplete',
            `Back did not leave ${obs.id} after ${stuckBacks - 1} attempts; the remaining screens could not be reached`,
          );
          break;
        }
        try {
          await device.back();
          counts.backs++;
          await device.sleep(o.settleMs);
          log(`back from ${obs.id}`);
        } catch (err) {
          if ((await recoverOrFail(err)) === 'failed') {
            break;
          }
        }
        continue;
      }
      if (rec.depth >= o.maxDepth) {
        tried.add(`${currentFp}>${cand.label}`);
        log(`depth limit (${o.maxDepth}): not tapping "${cand.label}" on ${obs.id}`);
        continue;
      }

      tried.add(`${currentFp}>${cand.label}`);
      let tapResult: 'tapped' | 'missing';
      try {
        tapResult = await device.tap(cand);
      } catch (err) {
        if ((await recoverOrFail(err)) === 'failed') {
          break;
        }
        continue;
      }
      if (tapResult === 'missing') {
        log(`"${cand.label}" on ${obs.id} was not found; skipped`);
        continue;
      }
      counts.taps++;
      stuckBacks = 0;
      await device.sleep(o.settleMs);

      let fg: string | undefined;
      try {
        fg = await device.foreground();
        screen = await device.snapshot();
      } catch (err) {
        if ((await recoverOrFail(err)) === 'failed') {
          break;
        }
        log(`tap on "${cand.label}" was followed by a session failure`);
        continue;
      }
      const pkg = fg ?? screenPackage(screen);
      if (pkg && pkg !== o.appId && !SYSTEM_PKGS.test(pkg)) {
        counts.boundaryExits++;
        boundaryControls.push(`${obs.id}:${cand.label}`);
        log(`tap "${cand.label}" on ${obs.id} left the app (now ${pkg}); returning`);
        await shot(`left-app-${pkg}`);
        if (!(await ensureInApp())) {
          await stop(
            'app-boundary',
            `tapping "${cand.label}" left ${o.appId} (now ${pkg}) and it could not be brought back`,
          );
          break;
        }
        continue;
      }
      let after: Screen | undefined;
      try {
        after = await settle();
      } catch (err) {
        if ((await recoverOrFail(err)) === 'failed') {
          break;
        }
        continue;
      }
      if (!after) {
        log(`tap "${cand.label}" on ${obs.id} raised a dialog that could not be cleared`);
        await stop(
          'device-failure',
          `a system dialog appeared after tapping "${cand.label}" and could not be dismissed`,
        );
        break;
      }
      const afterFp = identify(after);
      if (afterFp === currentFp) {
        log(`tap "${cand.label}" on ${obs.id} did not navigate`);
        continue;
      }
      const wasKnown = screens.has(afterFp);
      if (!wasKnown && screens.size >= o.maxScreens) {
        await stop('limits', `screen limit (${o.maxScreens}) reached`);
        break;
      }
      const ao = observeCurrent(after);
      if (ao.isNew) {
        parent.set(afterFp, currentFp);
        (screens.get(afterFp) as ScreenSummary).via = cand.label;
        (screens.get(afterFp) as ScreenSummary).parent = obs.id;
        (screens.get(afterFp) as ScreenSummary).depth = depthOf(afterFp);
        log(`tap "${cand.label}" on ${obs.id} -> NEW ${ao.id} (${screens.get(afterFp)?.type})`);
        await shot(ao.id);
        currentFp = afterFp;
      } else {
        log(`tap "${cand.label}" on ${obs.id} -> already seen ${ao.id}; going back`);
        try {
          await device.back();
          counts.backs++;
          await device.sleep(o.settleMs);
        } catch (err) {
          if ((await recoverOrFail(err)) === 'failed') {
            break;
          }
        }
      }
    }
  } catch (err) {
    if (looksLikeSessionFailure(err)) {
      await stop(
        'device-failure',
        `session or device failure: ${String((err as Error)?.message ?? err).slice(0, 160)}`,
      );
    } else {
      await stop('error', `unexpected error: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
  }
  // Leave the device where it was found: the app in front, even when the run ended on another app's page or on a limit.
  const endStatus: ExploreStatus = status as ExploreStatus;
  if (endStatus !== 'device-failure') {
    try {
      if (!(await ensureInApp()) && endStatus !== 'app-boundary') {
        log(`could not bring ${o.appId} back to the front at the end of the run`);
      }
    } catch {
      // best effort
    }
  }
  return finish();

  function finish(): ExploreReport {
    counts.screens = screens.size;
    if (status === 'explored' && counts.taps === 0 && safetySkipped.size > 0) {
      status = 'safety';
      detail = `nothing was tapped: all ${safetySkipped.size} available control(s) are restricted by the safety policy`;
    }
    const unexplored: {screen: string; label: string}[] = [];
    for (const [fp, rec] of screens) {
      void fp;
      if (rec.untried > 0 && unexplored.length < 20) {
        unexplored.push({screen: rec.id, label: `${rec.untried} untried control(s)`});
      }
    }
    return {
      status,
      detail,
      counts,
      screens: [...screens.values()].map(({n: _n, ...s}) => s),
      unexplored,
      safetySkipped: [...safetySkipped.values()].slice(0, 30),
      boundaryControls,
      history,
      evidence,
    };
  }
}
