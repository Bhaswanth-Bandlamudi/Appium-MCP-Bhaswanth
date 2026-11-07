import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';

import {
  _resetPending,
  capabilitiesRequestFullReset,
  capabilityAppTarget,
  requireConfirmation,
} from '../tools/safety/confirm.js';
import {
  _resetAnnounced,
  OPERATION_RISK,
  readTrustedMode,
  riskOf,
  TrustedModeConfigError,
  trustedModeCovers,
} from '../tools/safety/policy.js';

const text = (r: any) => r.content[0].text as string;
const TRUST_KEYS = [
  'APPIUM_MCP_TRUSTED_MODE',
  'APPIUM_MCP_TRUSTED_OPS',
  'APPIUM_MCP_TRUSTED_APPS',
  'APPIUM_MCP_TRUSTED_REASON',
  'APPIUM_MCP_ALLOW_DESTRUCTIVE',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  _resetPending();
  _resetAnnounced();
  for (const k of TRUST_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of TRUST_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
});

const trust = (over: Record<string, string> = {}) => {
  Object.assign(process.env, {
    APPIUM_MCP_TRUSTED_MODE: 'on',
    APPIUM_MCP_TRUSTED_OPS: 'app.clear',
    APPIUM_MCP_TRUSTED_APPS: 'com.test.app',
    APPIUM_MCP_TRUSTED_REASON: 'CI on a throwaway emulator',
    ...over,
  });
};

describe('default behaviour: confirmation required', () => {
  test('first call blocks and issues a token; second call with it proceeds once', () => {
    const first = requireConfirmation('app.uninstall', 'com.x', undefined, 'gone.', undefined)!;
    expect(first.isError).toBe(true);
    expect(text(first)).toMatch(/CONFIRMATION REQUIRED/);
    const token = /confirmToken="([0-9a-f]+)"/.exec(text(first))![1];
    expect(requireConfirmation('app.uninstall', 'com.x', undefined, 'gone.', token)).toBeUndefined();
    expect(requireConfirmation('app.uninstall', 'com.x', undefined, 'gone.', token)!.isError).toBe(true);
  });
  test('token is bound to operation, target and session', () => {
    const get = (op: 'app.clear' | 'file.push', target: string, s?: string) =>
      /confirmToken="([0-9a-f]+)"/.exec(text(requireConfirmation(op, target, s, 'c', undefined)!))![1];
    const t1 = get('app.clear', 'com.x', 's1');
    expect(requireConfirmation('app.clear', 'com.other', 's1', 'c', t1)!.isError).toBe(true);
    const t2 = get('app.clear', 'com.x', 's1');
    expect(requireConfirmation('app.clear', 'com.x', 's2', 'c', t2)!.isError).toBe(true);
    const t3 = get('app.clear', 'com.x', 's1');
    expect(requireConfirmation('file.push', 'com.x', 's1', 'c', t3)!.isError).toBe(true);
  });
  test('expires after two minutes; guessed token rejected', () => {
    const t0 = 1_000_000;
    const token = /confirmToken="([0-9a-f]+)"/.exec(
      text(requireConfirmation('app.clear', 't', undefined, 'c', undefined, t0)!),
    )![1];
    expect(requireConfirmation('app.clear', 't', undefined, 'c', token, t0 + 121_000)!.isError).toBe(true);
    expect(requireConfirmation('app.clear', 't', undefined, 'c', 'deadbeef')!.isError).toBe(true);
  });
});

describe('risk classification', () => {
  test('every destructive operation is classified, and read-only ones are not guarded', () => {
    expect(riskOf('app.uninstall')).toBe('destructive');
    expect(riskOf('app.clear')).toBe('destructive');
    expect(riskOf('session.fullReset')).toBe('destructive');
    expect(riskOf('file.push')).toBe('destructive');
    expect(riskOf('app.list')).toBe('read-only');
    expect(riskOf('file.pull')).toBe('read-only');
    expect(riskOf('app.terminate')).toBe('reversible');
    expect(Object.values(OPERATION_RISK).filter((r) => r === 'destructive').length).toBeGreaterThanOrEqual(5);
  });
});

describe('trusted automation mode', () => {
  test('is off unless explicitly configured', () => {
    expect(readTrustedMode({})).toBeUndefined();
    expect(trustedModeCovers('app.clear', 'com.test.app')).toBe(false);
    expect(requireConfirmation('app.clear', 'com.test.app', undefined, 'c', undefined)!.isError).toBe(true);
  });
  test('covers exactly the listed operation on exactly the listed app', () => {
    trust();
    expect(requireConfirmation('app.clear', 'com.test.app', undefined, 'c', undefined)).toBeUndefined();
    expect(requireConfirmation('app.clear', 'com.other.app', undefined, 'c', undefined)!.isError).toBe(true);
    expect(requireConfirmation('app.uninstall', 'com.test.app', undefined, 'c', undefined)!.isError).toBe(true);
    expect(requireConfirmation('file.push', 'com.test.app', undefined, 'c', undefined)!.isError).toBe(true);
  });
  test.each([
    ['no operations', {APPIUM_MCP_TRUSTED_OPS: ''}],
    ['"all" is not accepted', {APPIUM_MCP_TRUSTED_OPS: 'all'}],
    ['a non-destructive operation', {APPIUM_MCP_TRUSTED_OPS: 'app.terminate'}],
    ['no apps', {APPIUM_MCP_TRUSTED_APPS: ''}],
    ['wildcard app', {APPIUM_MCP_TRUSTED_APPS: '*'}],
    ['glob app', {APPIUM_MCP_TRUSTED_APPS: 'com.test.*'}],
    ['no reason', {APPIUM_MCP_TRUSTED_REASON: ''}],
    ['short reason', {APPIUM_MCP_TRUSTED_REASON: 'ci'}],
    ['unknown mode value', {APPIUM_MCP_TRUSTED_MODE: 'yes'}],
  ])('a bad configuration (%s) throws, and the guard stays ON', (_name, over) => {
    trust(over as Record<string, string>);
    expect(() => readTrustedMode()).toThrow(TrustedModeConfigError);
    expect(trustedModeCovers('app.clear', 'com.test.app')).toBe(false);
    expect(requireConfirmation('app.clear', 'com.test.app', undefined, 'c', undefined)!.isError).toBe(true);
  });
  test('the old all-or-nothing switch is rejected, not honoured', () => {
    process.env.APPIUM_MCP_ALLOW_DESTRUCTIVE = 'true';
    expect(() => readTrustedMode()).toThrow(/no longer honoured/);
    expect(requireConfirmation('app.uninstall', 'com.x', undefined, 'c', undefined)!.isError).toBe(true);
  });
});

describe('fullReset detection', () => {
  test.each([
    [{'appium:fullReset': true}, true],
    [{fullReset: 'true'}, true],
    [{'appium:fullReset': 'TRUE'}, true],
    [{'appium:options': {fullReset: true}}, true],
    [{'appium:fullReset': 1}, false],
    [{'appium:fullReset': false}, false],
    [{'appium:noReset': true}, false],
    [{}, false],
    [undefined, false],
  ])('%j -> %s', (caps, expected) => {
    expect(capabilitiesRequestFullReset(caps as Record<string, unknown> | undefined)).toBe(expected);
  });
  test('target is the app identity', () => {
    expect(capabilityAppTarget({'appium:appPackage': 'com.a', 'appium:app': '/x.apk'})).toBe('com.a');
    expect(capabilityAppTarget({'appium:app': '/x.apk'})).toBe('/x.apk');
    expect(capabilityAppTarget({})).toBe('unspecified-app');
  });
});
