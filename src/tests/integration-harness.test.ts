import {describe, expect, test} from '@jest/globals';

import {androidHealth, iosHealth} from './integration/harness.js';
import type {RunFn} from './integration/harness.js';

/** Fake adb: maps the adb sub-command to canned stdout. */
const fakeAdb =
  (o: {devices?: string; boot?: string; focus?: string; mem?: string}): RunFn =>
  async (_file, args) => {
    const joined = args.join(' ');
    if (joined === 'devices') {
      return {stdout: o.devices ?? 'List of devices attached\nemulator-5554\tdevice\n', ok: true};
    }
    if (joined.includes('sys.boot_completed')) {
      return {stdout: `${o.boot ?? '1'}\n`, ok: true};
    }
    if (joined.includes('dumpsys window')) {
      return {stdout: `  mCurrentFocus=${o.focus ?? 'Window{1 u0 com.android.settings/.Settings}'}\n`, ok: true};
    }
    if (joined.includes('/proc/meminfo')) {
      return {stdout: `MemTotal: 4009368 kB\nMemAvailable: ${o.mem ?? '2319176'} kB\n`, ok: true};
    }
    return {stdout: '', ok: false};
  };

const plentyOfHost = async () => 8000;

describe('androidHealth gate', () => {
  test('a healthy device passes', async () => {
    const h = await androidHealth(undefined, fakeAdb({}), plentyOfHost);
    expect(h.healthy).toBe(true);
    expect(h.reasons).toEqual([]);
  });
  test('no device is unhealthy with an explicit reason', async () => {
    const h = await androidHealth(undefined, fakeAdb({devices: 'List of devices attached\n'}), plentyOfHost);
    expect(h.healthy).toBe(false);
    expect(h.reasons[0]).toMatch(/no Android device/);
  });
  test('an unauthorized or offline device is not "ready"', async () => {
    const h = await androidHealth(
      undefined,
      fakeAdb({devices: 'List of devices attached\nR5CT\tunauthorized\nABC\toffline\n'}),
      plentyOfHost,
    );
    expect(h.healthy).toBe(false);
  });
  test('the observed starved-emulator condition (ANR dialog + low host memory) is unhealthy for both reasons', async () => {
    const h = await androidHealth(
      undefined,
      fakeAdb({focus: 'Window{99dc30b u0 Application Not Responding: com.android.systemui}'}),
      async () => 320,
    );
    expect(h.healthy).toBe(false);
    expect(h.reasons.join(' | ')).toMatch(/Not Responding/);
    expect(h.reasons.join(' | ')).toMatch(/host has 320 MB free/);
  });
  test('a device that has not finished booting is unhealthy', async () => {
    const h = await androidHealth(undefined, fakeAdb({boot: ''}), plentyOfHost);
    expect(h.healthy).toBe(false);
    expect(h.reasons.join()).toMatch(/boot_completed/);
  });
  test('low guest memory is unhealthy; thresholds are configurable', async () => {
    expect((await androidHealth(undefined, fakeAdb({mem: '200000'}), plentyOfHost)).healthy).toBe(false);
    process.env.INTEGRATION_MIN_GUEST_MB = '100';
    try {
      expect((await androidHealth(undefined, fakeAdb({mem: '200000'}), plentyOfHost)).healthy).toBe(true);
    } finally {
      delete process.env.INTEGRATION_MIN_GUEST_MB;
    }
  });
  test('two devices without ANDROID_SERIAL is ambiguous, so unhealthy; naming one is fine', async () => {
    const two = 'List of devices attached\nemulator-5554\tdevice\nR5CT123\tdevice\n';
    expect((await androidHealth(undefined, fakeAdb({devices: two}), plentyOfHost)).reasons.join()).toMatch(
      /ANDROID_SERIAL/,
    );
    expect((await androidHealth('R5CT123', fakeAdb({devices: two}), plentyOfHost)).healthy).toBe(true);
  });
});

describe('iosHealth gate', () => {
  test('non-mac hosts are reported unhealthy with the reason, without running anything', async () => {
    const run: RunFn = async () => {
      throw new Error('must not run');
    };
    const h = await iosHealth(undefined, run, 'win32');
    expect(h.healthy).toBe(false);
    expect(h.reasons[0]).toMatch(/win32.*macOS/);
  });
  const sims =
    (booted: {udid: string; name: string}[]): RunFn =>
    async () => ({
      stdout: JSON.stringify({devices: {'com.apple.CoreSimulator.SimRuntime.iOS-17-2': booted}}),
      ok: true,
    });
  test('no booted simulator is unhealthy; a booted one is healthy; a specific missing udid is unhealthy', async () => {
    expect((await iosHealth(undefined, sims([]), 'darwin')).reasons[0]).toMatch(/no booted simulator/);
    expect((await iosHealth(undefined, sims([{udid: 'AAAA', name: 'iPhone 15'}]), 'darwin')).healthy).toBe(true);
    expect((await iosHealth('BBBB', sims([{udid: 'AAAA', name: 'iPhone 15'}]), 'darwin')).healthy).toBe(false);
  });
  test('unparseable simctl output is a clear failure, not a throw', async () => {
    const h = await iosHealth(undefined, async () => ({stdout: 'garbage', ok: false}), 'darwin');
    expect(h.healthy).toBe(false);
    expect(h.reasons[0]).toMatch(/simctl/);
  });
});
