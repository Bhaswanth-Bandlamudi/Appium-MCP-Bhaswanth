import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';

import {BrowserStackProvider, mapBrowserStackDevices} from '../providers/browserstack.js';
import {assertNoCredentialCaps, missingVars, pickRegion, readCreds} from '../providers/config.js';
import {scrubCapabilities} from '../providers/connect.js';
import {scrubSecrets, setFetchForTests} from '../providers/http.js';
import {KobitonProvider} from '../providers/kobiton.js';
import {LambdaTestProvider, mapLambdaTestDevices} from '../providers/lambdatest.js';
import {
  isValidAvd,
  isValidSerial,
  LocalAndroidProvider,
  LocalIosProvider,
  parseAdbDevices,
  parseAvdList,
  parseSimctl,
  setRunnerForTests,
} from '../providers/local.js';
import {mapSauceDevices, SauceLabsProvider} from '../providers/saucelabs.js';

const KEYS = [
  'LAMBDATEST_USERNAME',
  'LAMBDATEST_ACCESS_KEY',
  'BROWSERSTACK_USERNAME',
  'BROWSERSTACK_ACCESS_KEY',
  'SAUCE_USERNAME',
  'SAUCE_ACCESS_KEY',
  'SAUCE_REGION',
  'KOBITON_USERNAME',
  'KOBITON_API_KEY',
  'KOBITON_HUB_URL',
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
});

const SECRET = 'S3cr3tK3y-do-not-leak';

describe('config', () => {
  test('missing vars are names only; creds need both', () => {
    process.env.SAUCE_USERNAME = 'bob';
    expect(missingVars('saucelabs')).toEqual(['SAUCE_ACCESS_KEY']);
    expect(readCreds('saucelabs')).toBeUndefined();
    process.env.SAUCE_ACCESS_KEY = SECRET;
    expect(readCreds('saucelabs')).toEqual({user: 'bob', key: SECRET});
  });
  test('region can only pick from the fixed list, so an env value cannot redirect credentials', () => {
    const allowed = ['us-west-1', 'eu-central-1'] as const;
    expect(pickRegion('eu-central-1', allowed, 'us-west-1')).toBe('eu-central-1');
    expect(pickRegion('evil.example.com/', allowed, 'us-west-1')).toBe('us-west-1');
  });
  test('credentials in extraCapabilities are rejected at any depth and prefix', () => {
    expect(() => assertNoCredentialCaps({'appium:accessKey': 'x'})).toThrow(/credentials/);
    expect(() => assertNoCredentialCaps({'sauce:options': {username: 'x'}})).toThrow(/credentials/);
    expect(() => assertNoCredentialCaps({'bstack:options': {nested: {secret: 'x'}}})).toThrow(/credentials/);
    expect(() => assertNoCredentialCaps({'appium:noReset': true, build: 'b'})).not.toThrow();
  });
});

describe('secret scrubbing', () => {
  test('scrubSecrets removes values and URL userinfo', () => {
    const out = scrubSecrets(`failed https://bob:${SECRET}@hub.example.com/wd and ${SECRET}`, [SECRET, 'bob']);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[REDACTED]@');
  });
  test('scrubCapabilities redacts credential keys under every vendor prefix and depth', () => {
    const s = scrubCapabilities({
      platformName: 'Android',
      'appium:accessKey': SECRET,
      'appium:username': 'bob',
      'sauce:options': {username: 'bob', accessKey: SECRET, build: 'b1'},
      'bstack:options': {userName: 'bob', accessKey: SECRET, local: true},
      key: SECRET,
    });
    const text = JSON.stringify(s);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('"bob"');
    expect(text).toContain('b1');
    expect(text).toContain('"local":true');
  });
});

describe('local android', () => {
  const adbOut = [
    'List of devices attached',
    'emulator-5554          device product:sdk_gphone model:sdk_gphone64_x86_64 device:emu64xa transport_id:1',
    'R5CT123ABC             unauthorized usb:1-1 transport_id:2',
    'ABCDEF012              offline transport_id:3',
    '* daemon started successfully',
  ].join('\n');

  test('parses ready, unauthorized and offline devices, with fixes', () => {
    const d = parseAdbDevices(adbOut);
    expect(d.map((x) => [x.id, x.status, x.kind])).toEqual([
      ['emulator-5554', 'available', 'emulator'],
      ['R5CT123ABC', 'unauthorized', 'physical'],
      ['ABCDEF012', 'offline', 'physical'],
    ]);
    expect(d[1].note).toMatch(/Allow USB debugging/);
    expect(d[2].note).toMatch(/kill-server/);
    expect(d[0].name).toBe('sdk gphone64 x86 64');
  });
  test('serial and avd validation reject shell metacharacters', () => {
    expect(isValidSerial('emulator-5554')).toBe(true);
    expect(isValidSerial('192.168.1.5:5555')).toBe(true);
    expect(isValidSerial('x; rm -rf /')).toBe(false);
    expect(isValidSerial('a b')).toBe(false);
    expect(isValidAvd('Pixel_10_Pro_XL')).toBe(true);
    expect(isValidAvd('a&b')).toBe(false);
    expect(parseAvdList('INFO | x\nPixel_9\nbad name\n')).toEqual(['Pixel_9']);
  });
  test('missing adb is reported with a fix, not thrown', async () => {
    const restore = setRunnerForTests(async () => {
      throw Object.assign(new Error('x'), {code: 'ENOENT'});
    });
    const r = await new LocalAndroidProvider().check();
    restore();
    expect(r.ok).toBe(false);
    expect(r.nextSteps.join()).toMatch(/ANDROID_HOME/);
  });
  test('check reports unauthorized device next steps', async () => {
    const restore = setRunnerForTests(async (_f, args) => ({
      stdout: args[0] === 'version' ? 'Android Debug Bridge version 1.0.41' : adbOut,
      code: 0,
    }));
    const r = await new LocalAndroidProvider().check();
    restore();
    expect(r.ok).toBe(true);
    expect(r.nextSteps.join()).toMatch(/R5CT123ABC/);
  });
  test('listDevices filters by name and reads the OS release', async () => {
    const restore = setRunnerForTests(async (_f, args) => {
      if (args[0] === 'devices') {
        return {stdout: adbOut, code: 0};
      }
      if (args.includes('getprop')) {
        return {stdout: '15\n', code: 0};
      }
      throw Object.assign(new Error('x'), {code: 'ENOENT'});
    });
    const r = await new LocalAndroidProvider().listDevices({name: 'gphone'});
    restore();
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0].osVersion).toBe('15');
  });
});

describe('local ios', () => {
  const sim = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
        {name: 'iPhone 15', udid: 'AAAA', state: 'Booted', isAvailable: true},
        {name: 'iPhone 14', udid: 'BBBB', state: 'Shutdown', isAvailable: true},
        {name: 'old', udid: 'CCCC', state: 'Shutdown', isAvailable: false},
      ],
      'com.apple.CoreSimulator.SimRuntime.tvOS-17-0': [{name: 'TV', udid: 'DDDD', state: 'Shutdown'}],
    },
  });
  test('simctl parsing keeps available iOS simulators only', () => {
    const d = parseSimctl(sim);
    expect(d.map((x) => [x.name, x.status, x.osVersion])).toEqual([
      ['iPhone 15', 'booted', '17.2'],
      ['iPhone 14', 'shutdown', '17.2'],
    ]);
    expect(parseSimctl('not json')).toEqual([]);
  });
  test('non-mac hosts get an honest unsupported status', () => {
    const st = new LocalIosProvider().status();
    if (process.platform !== 'darwin') {
      expect(st.supported).toBe(false);
      expect(st.unsupportedReason).toMatch(/macOS/);
    }
  });
});

describe('cloud sessions', () => {
  test('sauce: credentials go in sauce:options, tunnel needs a name, extra creds rejected', () => {
    process.env.SAUCE_USERNAME = 'bob';
    process.env.SAUCE_ACCESS_KEY = SECRET;
    process.env.SAUCE_REGION = 'eu-central-1';
    const p = new SauceLabsProvider();
    const b = p.buildSession({
      platform: 'android',
      device: {name: 'Pixel.*', osVersion: '14'},
      app: 'storage:filename=a.apk',
      build: 'b',
      name: 'n',
    });
    expect(b.hubUrl).toBe('https://ondemand.eu-central-1.saucelabs.com/wd/hub');
    expect(b.hubUrl).not.toContain('bob');
    expect((b.capabilities['sauce:options'] as Record<string, unknown>).accessKey).toBe(SECRET);
    expect(b.capabilities['appium:app']).toBe('storage:filename=a.apk');
    expect(() => p.buildSession({platform: 'android', tunnel: {enabled: true}})).toThrow(/tunnel.name/);
    expect(() => p.buildSession({platform: 'android', extraCapabilities: {'appium:accessKey': 'x'}})).toThrow(
      /credentials/,
    );
    process.env.SAUCE_REGION = 'evil.example.com';
    expect(new SauceLabsProvider().status().endpoint).toBe('https://ondemand.us-west-1.saucelabs.com/wd/hub');
  });
  test('browserstack: bstack:options carries credentials and local settings; hub has no userinfo', () => {
    process.env.BROWSERSTACK_USERNAME = 'bob';
    process.env.BROWSERSTACK_ACCESS_KEY = SECRET;
    const b = new BrowserStackProvider().buildSession({
      platform: 'ios',
      app: 'bs://abc123',
      tunnel: {enabled: true, name: 'id1'},
      build: 'b',
    });
    expect(b.hubUrl).toBe('https://hub.browserstack.com/wd/hub');
    const o = b.capabilities['bstack:options'] as Record<string, unknown>;
    expect(o).toMatchObject({userName: 'bob', accessKey: SECRET, local: true, localIdentifier: 'id1', buildName: 'b'});
    expect(b.capabilities.platformName).toBe('iOS');
    expect(() => new BrowserStackProvider().buildSession({platform: 'ios', app: 'file:///etc/passwd'})).toThrow(
      /app must be/,
    );
  });
  test('lambdatest: creds are passed to the client separately, not in capabilities; lt:// enforced; tunnel needs a name', () => {
    process.env.LAMBDATEST_USERNAME = 'bob';
    process.env.LAMBDATEST_ACCESS_KEY = SECRET;
    const p = new LambdaTestProvider();
    const b = p.buildSession({
      platform: 'android',
      device: {name: 'Galaxy S23', osVersion: '14'},
      app: 'lt://APP123',
      tunnel: {enabled: true, name: 't1'},
    });
    expect(b.auth).toEqual({user: 'bob', key: SECRET});
    expect(JSON.stringify(b.capabilities)).not.toContain(SECRET);
    expect(b.capabilities).toMatchObject({isRealMobile: true, app: 'lt://APP123', tunnel: true, tunnelName: 't1'});
    expect(() => p.buildSession({platform: 'android', app: 'https://x/y.apk'})).toThrow(/lt:\/\//);
    expect(() => p.buildSession({platform: 'android', tunnel: {enabled: true}})).toThrow(/tunnel.name/);
  });
  test('kobiton: hub must be supplied, https, and without userinfo', () => {
    process.env.KOBITON_USERNAME = 'bob';
    process.env.KOBITON_API_KEY = SECRET;
    expect(new KobitonProvider().status().configured).toBe(false);
    process.env.KOBITON_HUB_URL = 'http://insecure/wd/hub';
    expect(new KobitonProvider().status().configured).toBe(false);
    process.env.KOBITON_HUB_URL = `https://bob:${SECRET}@hub.example.com/wd/hub`;
    expect(new KobitonProvider().status().configured).toBe(false);
    process.env.KOBITON_HUB_URL = 'https://hub.example.com/wd/hub';
    const p = new KobitonProvider();
    expect(p.status().configured).toBe(true);
    const b = p.buildSession({platform: 'android', device: {name: 'Galaxy*'}, app: 'kobiton-store:v123'});
    expect(b.hubUrl).toBe('https://hub.example.com/wd/hub');
    expect(b.capabilities['appium:accessKey']).toBe(SECRET);
    expect(() => p.buildSession({platform: 'android', tunnel: {enabled: true}})).toThrow(/not verified/);
  });
  test('unconfigured provider says which variables are missing and never throws a stack', async () => {
    const r = await new BrowserStackProvider().check();
    expect(r.ok).toBe(false);
    expect(r.findings.join()).toContain('BROWSERSTACK_USERNAME');
  });
});

describe('cloud HTTP (mocked network)', () => {
  const jsonRes = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {status});

  test('browserstack device list is mapped and filtered; list says availability unknown', async () => {
    process.env.BROWSERSTACK_USERNAME = 'bob';
    process.env.BROWSERSTACK_ACCESS_KEY = SECRET;
    const calls: {url: string; auth?: string}[] = [];
    const restore = setFetchForTests(async (url, init) => {
      calls.push({url, auth: (init?.headers as Record<string, string>)?.Authorization});
      return jsonRes(200, [
        {os: 'android', os_version: '14.0', device: 'Samsung Galaxy S23'},
        {os: 'ios', os_version: '17', device: 'iPhone 15'},
      ]);
    });
    const r = await new BrowserStackProvider().listDevices({platform: 'ios'});
    restore();
    expect(calls[0].url).toBe('https://api-cloud.browserstack.com/app-automate/devices.json');
    expect(calls[0].auth).toBe(`Basic ${Buffer.from(`bob:${SECRET}`).toString('base64')}`);
    expect(r.devices.map((d) => d.name)).toEqual(['iPhone 15']);
    expect(r.note).toMatch(/availability/);
  });
  test('auth failure is reported plainly and does not echo the key', async () => {
    process.env.SAUCE_USERNAME = 'bob';
    process.env.SAUCE_ACCESS_KEY = SECRET;
    const restore = setFetchForTests(async () => jsonRes(401, `bad key ${SECRET}`));
    const r = await new SauceLabsProvider().check();
    restore();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.nextSteps.join()).toMatch(/SAUCE_ACCESS_KEY/);
  });
  test('server error body is scrubbed', async () => {
    process.env.BROWSERSTACK_USERNAME = 'bob';
    process.env.BROWSERSTACK_ACCESS_KEY = SECRET;
    const restore = setFetchForTests(async () => jsonRes(500, `upstream echoed ${SECRET}`));
    const r = await new BrowserStackProvider().check();
    restore();
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
  test('network failure becomes a finding with a next step', async () => {
    process.env.LAMBDATEST_USERNAME = 'bob';
    process.env.LAMBDATEST_ACCESS_KEY = SECRET;
    const restore = setFetchForTests(async () => {
      throw new Error(`connect ECONNREFUSED ${SECRET}`);
    });
    const r = await new LambdaTestProvider().check();
    restore();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.nextSteps.join()).toMatch(/network access/);
  });
  test('browserstack session status request body and path', async () => {
    process.env.BROWSERSTACK_USERNAME = 'bob';
    process.env.BROWSERSTACK_ACCESS_KEY = SECRET;
    let seen: {url: string; method?: string; body?: unknown} | undefined;
    const restore = setFetchForTests(async (url, init) => {
      seen = {url, method: init?.method, body: init?.body};
      return jsonRes(200, {});
    });
    await new BrowserStackProvider().setSessionStatus('abc/../x', false, 'timeout');
    restore();
    expect(seen?.method).toBe('PUT');
    expect(seen?.url).toBe('https://api-cloud.browserstack.com/app-automate/sessions/abc%2F..%2Fx.json');
    expect(JSON.parse(String(seen?.body))).toEqual({status: 'failed', reason: 'timeout'});
  });
});

describe('device mapping', () => {
  test('sauce: states map and available devices sort first', () => {
    const r = mapSauceDevices(
      [
        {descriptor: 'a', name: 'Pixel 7', os: 'android', osVersion: '14'},
        {descriptor: 'b', name: 'iPhone 15', os: 'ios', osVersion: '17'},
      ],
      [
        {descriptor: 'a', state: 'IN_USE'},
        {descriptor: 'b', state: 'AVAILABLE'},
      ],
      {},
    );
    expect(r.devices.map((d) => [d.name, d.status])).toEqual([
      ['iPhone 15', 'available'],
      ['Pixel 7', 'busy'],
    ]);
  });
  test('limit and truncation', () => {
    const many = Array.from({length: 40}, (_, i) => ({os: 'android', os_version: '14', device: `D${i}`}));
    const r = mapBrowserStackDevices(many, {limit: 10});
    expect(r.devices).toHaveLength(10);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(40);
  });
  test('lambdatest tolerates nested shapes', () => {
    const r = mapLambdaTestDevices(
      {
        platforms: {
          android: [{deviceName: 'Pixel 8', platformVersion: '14'}],
          ios: [{deviceName: 'iPhone 15', platformVersion: '17'}],
        },
      },
      {platform: 'ios'},
    );
    expect(r.devices.map((d) => d.name)).toEqual(['iPhone 15']);
  });
});
