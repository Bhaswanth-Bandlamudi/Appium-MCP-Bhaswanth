import {execFile} from 'node:child_process';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, test} from '@jest/globals';

import {androidHealth, ENABLED, iosHealth, startMcp, writeRecord} from './harness.js';
import type {Health, Mcp, TargetPlatform} from './harness.js';

/**
 * Device integration suite. Skipped unless RUN_DEVICE_TESTS=1 and a healthy device is present.
 * A device that fails the health gate produces a recorded SKIP with the reasons, never a pass.
 *
 *   Android: INTEGRATION_PLATFORM=android RUN_DEVICE_TESTS=1 npm run test:integration
 *   iOS    : INTEGRATION_PLATFORM=ios RUN_DEVICE_TESTS=1 npm run test:integration   (macOS only)
 *
 * See src/tests/integration/README.md for setup, configuration variables and the iOS procedure.
 */
const PLATFORM = (process.env.INTEGRATION_PLATFORM ?? 'android') as TargetPlatform;
const SERIAL = process.env.ANDROID_SERIAL;
const UDID = process.env.IOS_UDID;
const APP_ID =
  process.env.INTEGRATION_APP_ID ?? (PLATFORM === 'android' ? 'com.android.settings' : 'com.apple.Preferences');

const caps = (): string =>
  JSON.stringify(
    PLATFORM === 'android'
      ? {
          'appium:app': null,
          'appium:appPackage': APP_ID,
          'appium:appActivity': process.env.INTEGRATION_APP_ACTIVITY ?? '.Settings',
          'appium:noReset': true,
          'appium:autoLaunch': false,
          // Slow or memory-constrained hosts need longer than the 30 s default to start the instrumentation.
          'appium:uiautomator2ServerLaunchTimeout': Number(process.env.INTEGRATION_LAUNCH_TIMEOUT_MS ?? 120_000),
          'appium:adbExecTimeout': 60_000,
          ...(SERIAL ? {'appium:udid': SERIAL} : {}),
        }
      : {
          'appium:bundleId': APP_ID,
          'appium:noReset': true,
          ...(UDID ? {'appium:udid': UDID} : {}),
        },
  );

/** Parses a tool result that must be JSON; a plain-text answer fails the test with the text shown. */
function parseJson(text: string, tool: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${tool} returned non-JSON text: ${text.slice(0, 200)}`);
  }
}

let anrCleared = 0;
/**
 * Clears a "not responding" dialog before a scenario whose precondition is a calm device. Every clearing is counted
 * and written to the evidence record, so a device that keeps stalling is visible, not hidden.
 */
async function clearAnrIfPresent(): Promise<void> {
  if (PLATFORM !== 'android') {
    return;
  }
  for (let i = 0; i < 3; i++) {
    const r = await mcp.call('appium_dismiss_interrupts', {extraLocators: ['id=android:id/aerr_wait']});
    if (/dismissed/.test(r.text)) {
      anrCleared++;
    } else {
      return;
    }
  }
}

const results: {name: string; status: 'passed' | 'failed' | 'skipped'; detail: string}[] = [];
let mcp: Mcp;

// Health is checked once, at collection time, so scenarios the device cannot support are reported by jest as
// SKIPPED (never as passed). A not-enabled or unhealthy device yields a recorded reason.
const health: Health = !ENABLED
  ? {healthy: false, reasons: ['RUN_DEVICE_TESTS is not 1'], facts: {}}
  : PLATFORM === 'android'
    ? await androidHealth(SERIAL)
    : await iosHealth(UDID);
const gate: 'run' | 'skip' = health.healthy ? 'run' : 'skip';

const adb = (args: string[]): Promise<string> =>
  new Promise((resolve) => {
    const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? '';
    const bin = home ? join(home, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb';
    execFile(bin, [...(SERIAL ? ['-s', SERIAL] : []), ...args], {timeout: 20_000, windowsHide: true}, (_e, out) =>
      resolve(String(out ?? '')),
    );
  });

/** Runs a scenario only when the gate is open; otherwise records an honest skip. */
function scenario(name: string, fn: () => Promise<string>, timeoutMs = 240_000): void {
  if (gate === 'skip') {
    results.push({name, status: 'skipped', detail: health.reasons.join('; ')});
    test.skip(`${name} [skipped: ${health.reasons[0] ?? 'not enabled'}]`, () => undefined);
    return;
  }
  test(
    name,
    async () => {
      try {
        const detail = await fn();
        results.push({name, status: 'passed', detail});
      } catch (err) {
        results.push({name, status: 'failed', detail: String((err as Error).message).slice(0, 500)});
        throw err;
      }
    },
    timeoutMs,
  );
}

const describeIf = ENABLED ? describe : describe.skip;

describeIf(`device integration (${PLATFORM})`, () => {
  beforeAll(async () => {
    if (gate === 'run') {
      // The suite exercises the opt-in groups as well as the default set.
      mcp = await startMcp({APPIUM_MCP_TOOL_GROUPS: 'all'});
      if (PLATFORM === 'android') {
        await mcp.call('select_device', {platform: 'android', ...(SERIAL ? {deviceUdid: SERIAL} : {})});
      } else {
        await mcp.call('select_device', {
          platform: 'ios',
          iosDeviceType: 'simulator',
          ...(UDID ? {deviceUdid: UDID} : {}),
        });
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (mcp) {
      try {
        await mcp.call('appium_session_management', {action: 'delete'});
      } catch {
        // already gone
      }
      await mcp.close();
    }
    const path = writeRecord(`integration-${PLATFORM}-${Date.now()}.json`, {
      platform: PLATFORM,
      health,
      anrDialogsCleared: anrCleared,
      results,
    });
    // eslint-disable-next-line no-console
    console.log(
      `integration record: ${path}\n${results.map((r) => `${r.status.toUpperCase().padEnd(7)} ${r.name} ${r.status === 'passed' ? '' : `- ${r.detail}`}`).join('\n')}`,
    );
  });

  scenario('creates a session and reports it in the overview with exactly one active session', async () => {
    const created = await mcp.call('appium_session_management', {
      action: 'create',
      platform: PLATFORM,
      capabilities: caps(),
    });
    expect(created.isError).toBe(false);
    const ov = JSON.parse((await mcp.call('appium_session_overview')).text);
    expect(ov.count).toBe(1);
    expect(ov.sessions.filter((s: {active: boolean}) => s.active)).toHaveLength(1);
    return `session ${ov.activeSessionId}`;
  });

  scenario('page source, screenshot and locator discovery work and compact output is smaller', async () => {
    const full = await mcp.call('appium_get_page_source');
    const compact = await mcp.call('appium_get_page_source', {mode: 'compact'});
    expect(full.isError).toBe(false);
    expect(compact.isError).toBe(false);
    expect(compact.text.length).toBeLessThan(full.text.length);
    const shot = await mcp.call('appium_screenshot');
    expect(shot.isError).toBe(false);
    const intel = JSON.parse((await mcp.call('appium_screen_intel')).text);
    expect(intel.screenType).toBeTruthy();
    return `full ${full.text.length} chars, compact ${compact.text.length} chars`;
  });

  scenario('invalid locator and missing element return errors, not crashes', async () => {
    const v = (
      await mcp.call('appium_verify_locator', {
        locators: ['id=nope:id/x', PLATFORM === 'android' ? 'xpath=//*[@bogus' : 'pred=(('],
      })
    ).text;
    expect(v).toMatch(/ABSENT|ERROR/);
    const f = await mcp.call('appium_find_element', {strategy: 'id', selector: 'nope:id/x'});
    expect(f.isError).toBe(true);
    return 'errors surfaced';
  });

  scenario('a destructive operation is blocked without a token and changes nothing', async () => {
    const r = await mcp.call('appium_app_lifecycle', {action: 'clear', id: APP_ID});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/CONFIRMATION REQUIRED/);
    const state = await mcp.call('appium_app_lifecycle', {action: 'is_installed', id: APP_ID});
    expect(state.text).toMatch(/installed/i);
    return 'blocked; app still installed';
  });

  scenario(
    'appium_explore: a normal run discovers several screens, stays in the app, and reports a clean status',
    async () => {
      const r = await mcp.call('appium_explore', {
        appId: APP_ID,
        goal: 'integration',
        maxSteps: 12,
        maxDepth: 2,
        maxScreens: 10,
        maxScreenshots: 3,
      });
      const out = parseJson(r.text, 'appium_explore');
      // The objective is to explore: a run that stops after one screen, or for a device reason, must FAIL.
      expect(['explored', 'limits']).toContain(out.status);
      expect(out.counts.screens).toBeGreaterThanOrEqual(3);
      expect(out.counts.taps).toBeGreaterThanOrEqual(3);
      expect(out.counts.taps).toBeLessThanOrEqual(12);
      expect(out.screens.length).toBe(out.counts.screens);
      expect(out.history.length).toBeGreaterThan(out.counts.taps);
      // No restricted control was tapped.
      expect(out.history.join(' ')).not.toMatch(/tap "(Delete|Reset|Erase|Log out|Sign out)/i);
      // Exactly one session still open, and the app is back in front.
      expect(JSON.parse((await mcp.call('appium_session_overview')).text).count).toBe(1);
      const fg = await mcp.call('appium_app_lifecycle', {action: 'query_state', id: APP_ID});
      expect(fg.text).toMatch(/foreground|4/i);
      return `status=${out.status} taps=${out.counts.taps} screens=${out.counts.screens} boundary=${out.counts.boundaryExits} relaunches=${out.counts.relaunches} evidence=${out.evidence.length}`;
    },
  );

  scenario('appium_explore: a missing session is a structured device-failure, not a crash or plain text', async () => {
    const r = await mcp.call('appium_explore', {appId: APP_ID, goal: 'no session', sessionId: 'does-not-exist'});
    const out = parseJson(r.text, 'appium_explore');
    expect(out.status).toBe('device-failure');
    expect(typeof out.detail).toBe('string');
    return 'structured';
  });

  scenario('appium_explore: only restricted controls are never tapped (allowOnly with a deny word)', async () => {
    const r = await mcp.call('appium_explore', {
      appId: APP_ID,
      goal: 'safety',
      maxSteps: 4,
      allowOnly: ['Network'],
      denyWords: ['network'],
    });
    const out = parseJson(r.text, 'appium_explore');
    expect(out.counts.taps).toBe(0);
    expect(['safety', 'explored']).toContain(out.status);
    return `status=${out.status}`;
  });

  scenario('session health reports healthy for a live session, and does not create another', async () => {
    await clearAnrIfPresent();
    const h = parseJson(
      (await mcp.call('appium_session_health', {detail: true, appId: APP_ID})).text,
      'appium_session_health',
    );
    expect(h.failure.kind).toBe('healthy');
    expect(h.result).toBe('not-needed');
    expect(h.attempted).toBe(false);
    expect(JSON.parse((await mcp.call('appium_session_overview')).text).count).toBe(1);
    return 'healthy';
  });

  scenario(
    'recovery: a killed driver is diagnosed, report-only changes nothing, recover=true replaces the session once on the same device',
    async () => {
      if (PLATFORM !== 'android') {
        throw new Error('driver-kill recovery scenario is Android only (it force-stops the UiAutomator2 server)');
      }
      await clearAnrIfPresent();
      const before = JSON.parse((await mcp.call('appium_session_overview')).text);
      const oldId: string = before.activeSessionId;
      const devicesBefore = await adb(['devices']);
      await adb(['shell', 'am', 'force-stop', 'io.appium.uiautomator2.server']);
      await adb(['shell', 'am', 'force-stop', 'io.appium.uiautomator2.server.test']);

      const dead = parseJson((await mcp.call('appium_session_health', {appId: APP_ID})).text, 'appium_session_health');
      expect(['driver-crashed', 'session-expired', 'unknown']).toContain(dead.failure.kind);
      expect(dead.failure.recoverable).toBe(true);
      expect(dead.attempted).toBe(false);
      expect(dead.reason).toMatch(/recover=true/);
      // Report-only mode must not have changed anything.
      const mid = JSON.parse((await mcp.call('appium_session_overview')).text);
      expect(mid.count).toBe(1);
      expect(mid.activeSessionId).toBe(oldId);

      const rec = parseJson(
        (await mcp.call('appium_session_health', {recover: true, appId: APP_ID})).text,
        'appium_session_health',
      );
      expect(rec.result).toBe('recovered');
      expect(rec.originalSession).toBe(oldId);
      expect(rec.newSessionId).toBeTruthy();
      expect(rec.newSessionId).not.toBe(oldId);
      expect(rec.appRestored).toBe('yes');
      const after = JSON.parse((await mcp.call('appium_session_overview')).text);
      expect(after.count).toBe(1);
      expect(after.activeSessionId).toBe(rec.newSessionId);
      expect(await adb(['devices'])).toBe(devicesBefore);
      await clearAnrIfPresent();
      const alive = parseJson(
        (await mcp.call('appium_session_health', {detail: true, appId: APP_ID})).text,
        'appium_session_health',
      );
      expect(alive.failure.kind).toBe('healthy');
      return `${rec.failure ? dead.failure.kind : ''}: old ${oldId} -> new ${rec.newSessionId}; app restored=${rec.appRestored}; devices unchanged`;
    },
    420_000,
  );

  scenario('exploration after recovery starts from a relaunched app and again explores several screens', async () => {
    if (PLATFORM !== 'android') {
      throw new Error('depends on the recovery scenario (Android only)');
    }
    // Deliberately leave the app so the tool has to bring it back (this used to be a plain-text refusal).
    await adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
    const r = await mcp.call('appium_explore', {
      appId: APP_ID,
      goal: 'after recovery',
      maxSteps: 8,
      maxDepth: 2,
      maxScreens: 8,
      maxScreenshots: 1,
    });
    const out = parseJson(r.text, 'appium_explore');
    expect(['explored', 'limits']).toContain(out.status);
    expect(out.counts.screens).toBeGreaterThanOrEqual(2);
    expect(out.counts.relaunches).toBeGreaterThanOrEqual(1);
    return `status=${out.status} screens=${out.counts.screens} relaunches=${out.counts.relaunches}`;
  });

  // Must stay LAST: it exhausts the recovery budget and deliberately leaves the session dead.
  scenario(
    'recovery is bounded: repeated failures stop being recovered',
    async () => {
      if (PLATFORM !== 'android') {
        throw new Error('Android only');
      }
      let refused: string | undefined;
      for (let i = 0; i < 4 && !refused; i++) {
        await adb(['shell', 'am', 'force-stop', 'io.appium.uiautomator2.server']);
        await adb(['shell', 'am', 'force-stop', 'io.appium.uiautomator2.server.test']);
        const r = parseJson(
          (await mcp.call('appium_session_health', {recover: true, appId: APP_ID})).text,
          'appium_session_health',
        );
        if (r.result === 'refused' && /limit/.test(r.reason ?? '')) {
          refused = r.reason;
        }
        expect(JSON.parse((await mcp.call('appium_session_overview')).text).count).toBe(1);
      }
      expect(refused).toMatch(/recovery limit reached/);
      return refused as string;
    },
    590_000,
  );
});

// A visible, non-failing record when the suite is not enabled, so the absence of a run is never mistaken for a pass.
if (!ENABLED || gate === 'skip') {
  describe('device integration (not run)', () => {
    test(`no device scenario executed: ${health.reasons[0] ?? 'unknown'}`, () => {
      // Jest does not run afterAll when every scenario is skipped, so the evidence record is written here.
      if (ENABLED) {
        writeRecord(`integration-${PLATFORM}-${Date.now()}.json`, {
          platform: PLATFORM,
          health,
          results,
          note: 'not run: device failed the health gate',
        });
      }
      expect(gate).toBe('skip');
    });
  });
}
