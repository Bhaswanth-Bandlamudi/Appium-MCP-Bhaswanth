import {describe, expect, test} from '@jest/globals';

import {classifyFailure, RecoveryLedger, safeReplacementCapabilities} from '../tools/ops/recovery.js';
import type {Evidence} from '../tools/ops/recovery.js';

const ev = (o: Partial<Evidence>): Evidence => ({sessionResponds: true, platform: 'android', remote: false, ...o});

describe('classifyFailure', () => {
  test('a responding session with the app in front is healthy', () => {
    expect(classifyFailure(ev({appState: 4})).kind).toBe('healthy');
  });
  test.each([
    ['absent', 'no-device'],
    ['unauthorized', 'device-unauthorized'],
    ['offline', 'device-offline'],
  ])(
    'device state %s is reported before session symptoms, and is not recoverable by a new session',
    (deviceState, kind) => {
      const c = classifyFailure(ev({sessionResponds: false, probeError: 'socket hang up', deviceState}));
      expect(c.kind).toBe(kind);
      expect(c.recoverable).toBe(false);
      expect(c.blocker).toBeTruthy();
    },
  );
  test('an unreachable remote server outranks a dead session', () => {
    const c = classifyFailure(
      ev({sessionResponds: false, remote: true, serverReachable: false, probeError: 'ECONNREFUSED'}),
    );
    expect(c.kind).toBe('appium-server-unreachable');
    expect(c.recoverable).toBe(false);
  });
  test('driver crash on Android is recoverable', () => {
    const c = classifyFailure(
      ev({sessionResponds: false, probeError: 'The instrumentation process is not running', deviceState: 'device'}),
    );
    expect(c.kind).toBe('driver-crashed');
    expect(c.recoverable).toBe(true);
  });
  test('the same signature on iOS is a WebDriverAgent failure', () => {
    const c = classifyFailure(
      ev({platform: 'ios', sessionResponds: false, probeError: 'WebDriverAgent is not running (xcodebuild exited)'}),
    );
    expect(c.kind).toBe('wda-failure');
    expect(c.recoverable).toBe(true);
  });
  test.each([
    'invalid session id',
    'A session is either terminated or not started',
    'no such driver',
    'new command timeout of 300 seconds',
  ])('session expiry (%s) is recoverable', (probeError) => {
    const c = classifyFailure(ev({sessionResponds: false, probeError, deviceState: 'device'}));
    expect(c.kind).toBe('session-expired');
    expect(c.recoverable).toBe(true);
  });
  test('an app that is not running is NOT a reason to replace a healthy session', () => {
    const c = classifyFailure(ev({appState: 1}));
    expect(c.kind).toBe('app-not-running');
    expect(c.recoverable).toBe(false);
    expect(c.blocker).toMatch(/activate/);
  });
  test('an app pushed to the background is not a session failure', () => {
    const c = classifyFailure(ev({appState: 3, foregroundPackage: 'com.other'}));
    expect(c.kind).toBe('app-in-background');
    expect(c.recoverable).toBe(false);
  });
  test('an ANR dialog is reported as unresponsive and a new session is explicitly not the fix', () => {
    const c = classifyFailure(ev({anrDialog: true, appState: 4}));
    expect(c.kind).toBe('app-unresponsive');
    expect(c.recoverable).toBe(false);
  });
  test('an unclassified failure is still recoverable but flagged unknown', () => {
    const c = classifyFailure(ev({sessionResponds: false, probeError: 'something odd', deviceState: 'device'}));
    expect(c.kind).toBe('unknown');
    expect(c.recoverable).toBe(true);
  });
});

describe('RecoveryLedger', () => {
  test('allows the configured number of attempts in the window, then refuses', () => {
    const l = new RecoveryLedger({maxAttempts: 2, windowMs: 1000});
    expect(l.allow('s1', 0).allowed).toBe(true);
    l.record('s1', 0);
    l.record('s1', 10);
    expect(l.allow('s1', 20)).toEqual({allowed: false, used: 2, max: 2});
  });
  test('attempts expire with the window', () => {
    const l = new RecoveryLedger({maxAttempts: 1, windowMs: 1000});
    l.record('s1', 0);
    expect(l.allow('s1', 500).allowed).toBe(false);
    expect(l.allow('s1', 1500).allowed).toBe(true);
  });
  test('lineages are independent, so one flapping device cannot block another session', () => {
    const l = new RecoveryLedger({maxAttempts: 1, windowMs: 1000});
    l.record('a', 0);
    expect(l.allow('a', 1).allowed).toBe(false);
    expect(l.allow('b', 1).allowed).toBe(true);
  });
  test('the budget follows the replacement session, so recovery cannot loop by renaming', () => {
    const l = new RecoveryLedger({maxAttempts: 2, windowMs: 10_000});
    l.record('old', 0);
    l.rekey('old', 'new');
    l.record('new', 5);
    expect(l.allow('new', 6).allowed).toBe(false);
    expect(l.allow('old', 6).allowed).toBe(true);
  });
});

describe('safeReplacementCapabilities', () => {
  test('removes every spelling of fullReset so recovery can never erase app data', () => {
    const {caps, stripped} = safeReplacementCapabilities({
      platformName: 'Android',
      'appium:fullReset': true,
      fullReset: true,
      'appium:options': {fullReset: true, noReset: true},
      'appium:noReset': true,
    });
    expect(caps).not.toHaveProperty('appium:fullReset');
    expect(caps).not.toHaveProperty('fullReset');
    expect(caps['appium:options']).toEqual({noReset: true});
    expect(caps['appium:noReset']).toBe(true);
    expect(stripped).toHaveLength(3);
  });
  test('leaves other capabilities untouched and does not mutate its input', () => {
    const input = {platformName: 'iOS', 'appium:bundleId': 'com.x'};
    const {caps, stripped} = safeReplacementCapabilities(input);
    expect(caps).toEqual(input);
    expect(stripped).toEqual([]);
  });
});
