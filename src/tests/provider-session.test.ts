import http from 'node:http';
import type {AddressInfo} from 'node:net';

import {afterAll, beforeAll, describe, expect, jest, test} from '@jest/globals';

// Only the heavy local drivers are mocked; the WebDriver client, session store, registry and
// connect layer are the real ones talking to a fake hub over HTTP.
jest.unstable_mockModule('appium-uiautomator2-driver', () => ({AndroidUiautomator2Driver: class {}}));
jest.unstable_mockModule('appium-xcuitest-driver', () => ({XCUITestDriver: class {}}));
jest.unstable_mockModule('appium-webdriveragent', () => ({BOOTSTRAP_PATH: '/mock/wda'}));
jest.unstable_mockModule('@appium/coresim', () => ({NativeSimctl: class {}}));
jest.unstable_mockModule('../devicemanager/adb-manager', () => ({ADBManager: {getInstance: jest.fn()}}));
jest.unstable_mockModule('../devicemanager/ios-manager', () => ({IOSManager: {getInstance: jest.fn()}}));

const SECRET = 'TOPSECRET-KEY-123';
const seen: {method?: string; url?: string; auth?: string; body: string}[] = [];
let server: http.Server;
let port = 0;
let counter = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({method: req.method, url: req.url, auth: req.headers.authorization, body});
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url?.endsWith('/session')) {
        counter++;
        res.end(
          JSON.stringify({
            value: {
              sessionId: `fake-${counter}`,
              capabilities: {platformName: 'Android', 'appium:deviceName': 'Fake Pixel'},
            },
          }),
        );
        return;
      }
      if (req.method === 'GET' && req.url?.endsWith('/source')) {
        const who = /fake-(\d)/.exec(req.url ?? '')?.[1];
        res.end(
          JSON.stringify({
            value: `<hierarchy><android.widget.FrameLayout bounds="[0,0][100,100]"><android.widget.TextView text="SCREEN-OF-${who}" bounds="[0,0][50,50]"/></android.widget.FrameLayout></hierarchy>`,
          }),
        );
        return;
      }
      res.end(JSON.stringify({value: null}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('cloud session connect + isolation', () => {
  test('credentials never reach the stored session, listings, or persisted metadata; routing stays per session', async () => {
    const {connectCloudSession, scrubCapabilities} = await import('../providers/connect.js');
    const {getSessionInfo, listSessions, safeDeleteSession, getSessionId, setActiveSession} =
      await import('../session-store.js');
    const {providerOfSession, _resetForTests} = await import('../providers/registry.js');
    const {getPageSource} = await import('../command.js');
    _resetForTests();

    // Plain-HTTP localhost hub is allowed by the URL validator (http or https).
    const provider = {id: 'lambdatest', label: 'x', kind: 'cloud'} as never;
    const mk = (n: string) => ({
      hubUrl: `http://127.0.0.1:${port}/wd/hub`,
      auth: {user: 'alice', key: SECRET},
      capabilities: {
        platformName: 'Android',
        'appium:deviceName': n,
        'sauce:options': {username: 'alice', accessKey: SECRET, build: 'b'},
      },
    });

    const a = await connectCloudSession(provider, mk('A'));
    const b = await connectCloudSession(provider, mk('B'));
    expect([a.sessionId, b.sessionId]).toEqual(['fake-1', 'fake-2']);

    // 1. Secrets: not in connect result, not in the store, not in listSessions().
    const everything = JSON.stringify({
      a,
      b,
      list: listSessions().map((s) => ({...s})),
      info: getSessionInfo('fake-1')?.metadata,
      hub: getSessionInfo('fake-1')?.remoteServerUrl,
    });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('"alice"');
    expect(a.hub).toBe(`http://127.0.0.1:${port}/wd/hub`);
    expect(JSON.stringify(scrubCapabilities({'sauce:options': {accessKey: SECRET}}))).not.toContain(SECRET);

    // 2. The hub did receive the credentials (basic auth) so the session could actually be created.
    const create = seen.find((r) => r.method === 'POST' && r.url?.endsWith('/session'));
    expect(create?.auth).toBe(`Basic ${Buffer.from(`alice:${SECRET}`).toString('base64')}`);

    // 3. Both sessions are open, the latest is active, and nothing was silently closed.
    expect(listSessions()).toHaveLength(2);
    expect(getSessionId()).toBe('fake-2');
    expect(providerOfSession('fake-1')).toBe('lambdatest');

    // 4. Routing: explicit sessionId reaches the right session; the default follows the active one.
    const d1 = getSessionInfo('fake-1')?.driver as never;
    const d2 = getSessionInfo('fake-2')?.driver as never;
    expect(await getPageSource(d1)).toContain('SCREEN-OF-1');
    expect(await getPageSource(d2)).toContain('SCREEN-OF-2');
    expect(setActiveSession('fake-1')).toBe(true);
    expect(await getPageSource(getSessionInfo()?.driver as never)).toContain('SCREEN-OF-1');

    // 5. Deleting one session leaves the other intact.
    await safeDeleteSession('fake-1');
    expect(listSessions().map((s) => s.sessionId)).toEqual(['fake-2']);
    await safeDeleteSession('fake-2');
  });

  test('a failed hub login does not echo the key and leaves no session behind', async () => {
    const {connectCloudSession} = await import('../providers/connect.js');
    const {listSessions} = await import('../session-store.js');
    const before = listSessions().length;
    const provider = {id: 'browserstack', label: 'x', kind: 'cloud'} as never;
    await expect(
      connectCloudSession(provider, {
        hubUrl: 'http://127.0.0.1:1/wd/hub',
        auth: {user: 'alice', key: SECRET},
        capabilities: {platformName: 'Android', 'bstack:options': {userName: 'alice', accessKey: SECRET}},
      }),
    ).rejects.toThrow();
    try {
      await connectCloudSession(provider, {
        hubUrl: 'http://127.0.0.1:1/wd/hub',
        auth: {user: 'alice', key: SECRET},
        capabilities: {platformName: 'Android', 'bstack:options': {userName: 'alice', accessKey: SECRET}},
      });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(SECRET);
      expect((e as Error).cause).toBeUndefined();
    }
    expect(listSessions().length).toBe(before);
  });
});
