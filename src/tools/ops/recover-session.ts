import {execFile} from 'node:child_process';
import {join} from 'node:path';

import {execute, getPageSource, queryAppState} from '../../command.js';
import {parseAdbDevices} from '../../providers/local.js';
import {
  getPlatformName,
  getSessionInfo,
  listSessions,
  PLATFORM,
  safeDeleteSession,
  setActiveSession,
} from '../../session-store.js';
import type {DriverInstance} from '../../session-store.js';
import {createSessionAction} from '../session/create-session.js';
import {toolErrorMessage} from '../tool-response.js';
import {classifyFailure, RecoveryLedger, safeReplacementCapabilities} from './recovery.js';
import type {Evidence, RecoveryReport} from './recovery.js';

export const ledger = new RecoveryLedger();

const adbBin = (): string => {
  const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  return home ? join(home, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb';
};

const run = (args: string[], timeoutMs = 8000): Promise<string> =>
  new Promise((resolve) => {
    execFile(adbBin(), args, {timeout: timeoutMs, windowsHide: true}, (_e, out) => resolve(String(out ?? '')));
  });

export async function probeSession(driver: DriverInstance): Promise<{alive: boolean; ms: number; error?: string}> {
  const t0 = Date.now();
  try {
    await Promise.race([
      getPageSource(driver),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe timed out after 15s')), 15_000)),
    ]);
    return {alive: true, ms: Date.now() - t0};
  } catch (err) {
    return {alive: false, ms: Date.now() - t0, error: toolErrorMessage(err).slice(0, 200)};
  }
}

/** Gathers what is observable without changing anything. */
export async function gatherEvidence(sessionId: string, appId?: string): Promise<Evidence> {
  const info = getSessionInfo(sessionId);
  if (!info) {
    throw new Error(`no such session ${sessionId}`);
  }
  const driver = info.driver;
  const platform = (getPlatformName(driver) === PLATFORM.ios ? 'ios' : 'android') as 'android' | 'ios';
  const remote = Boolean(info.remoteServerUrl);
  const p = await probeSession(driver);
  const e: Evidence = {sessionResponds: p.alive, probeError: p.error, platform, remote};
  const udid = (info.metadata.capabilities['appium:udid'] ?? info.metadata.capabilities.udid) as string | undefined;
  if (platform === 'android' && !remote) {
    const devices = parseAdbDevices(await run(['devices', '-l']));
    const mine = udid ? devices.find((d) => d.id === udid) : devices.length === 1 ? devices[0] : undefined;
    e.deviceState =
      udid || devices.length === 1
        ? mine
          ? mine.status === 'available'
            ? 'device'
            : mine.status
          : 'absent'
        : undefined;
  }
  if (remote && info.remoteServerUrl) {
    try {
      const u = new URL(info.remoteServerUrl);
      u.username = '';
      u.password = '';
      const res = await fetch(`${u.toString().replace(/\/$/, '')}/status`, {signal: AbortSignal.timeout(8000)});
      e.serverReachable = res.status < 500;
    } catch {
      e.serverReachable = false;
    }
  }
  if (p.alive) {
    const app =
      appId ??
      ((info.metadata.capabilities['appium:appPackage'] ?? info.metadata.capabilities['appium:bundleId']) as
        | string
        | undefined);
    if (app) {
      try {
        e.appState = await queryAppState(driver, app);
      } catch {
        // unsupported on this driver
      }
      try {
        const fg =
          platform === 'ios'
            ? ((await execute(driver, 'mobile: activeAppInfo', {})) as {bundleId?: string}).bundleId
            : String(await execute(driver, 'mobile: getCurrentPackage', {}));
        if (fg && fg !== app) {
          e.foregroundPackage = fg;
        }
      } catch {
        // best effort
      }
    }
    try {
      const src = await getPageSource(driver);
      e.anrDialog = /android:id\/(aerr_close|aerr_wait)|Application Not Responding/.test(src);
    } catch {
      // ignore
    }
  }
  return e;
}

export interface RecoverOptions {
  sessionId: string;
  /** false: diagnose only. */
  recover: boolean;
  appId?: string;
}

/**
 * Diagnose a session and, only when replacing it is the right response and the retry budget allows,
 * replace it. Other sessions are never touched: the replacement is created, the broken one removed,
 * and the previously active session is restored if it was not the broken one.
 */
export async function recoverSession(o: RecoverOptions): Promise<RecoveryReport> {
  const limitations: string[] = [];
  const info = getSessionInfo(o.sessionId);
  if (!info) {
    return {
      originalSession: o.sessionId,
      failure: {kind: 'unknown', signals: ['no such session'], recoverable: false},
      attempted: false,
      result: 'refused',
      reason: 'no such session',
      limitations,
    };
  }
  const evidence = await gatherEvidence(o.sessionId, o.appId);
  const failure = classifyFailure(evidence);
  const base: RecoveryReport = {
    originalSession: o.sessionId,
    failure,
    attempted: false,
    result: 'not-needed',
    limitations,
  };
  if (failure.kind === 'healthy') {
    return base;
  }
  if (!failure.recoverable) {
    return {...base, result: 'refused', reason: failure.blocker ?? 'replacing the session would not help'};
  }
  if (!o.recover) {
    return {...base, result: 'refused', reason: 'report-only: call again with recover=true to replace the session'};
  }
  if (info.ownership === 'attached') {
    return {...base, result: 'refused', reason: 'attached sessions belong to someone else; not replacing'};
  }
  const platform = (info.metadata.platform ?? '').toLowerCase();
  if (platform !== 'android' && platform !== 'ios') {
    return {...base, result: 'refused', reason: `recovery supports android and ios sessions, not '${platform}'`};
  }
  if (info.remoteServerUrl) {
    return {
      ...base,
      result: 'refused',
      reason:
        'cloud and remote sessions are not replaced automatically (they are billed and may have a tunnel); create a new one with appium_provider_session',
      limitations: ['remote sessions: recovery not supported'],
    };
  }
  const budget = ledger.allow(o.sessionId);
  if (!budget.allowed) {
    return {
      ...base,
      result: 'refused',
      reason: `recovery limit reached (${budget.used} of ${budget.max} in the window); stop and investigate`,
      attempts: budget,
    };
  }
  ledger.record(o.sessionId);

  const previouslyActive = listSessions().find((s) => s.isActive)?.sessionId;
  const {caps, stripped} = safeReplacementCapabilities({...info.metadata.capabilities});
  if (stripped.length) {
    limitations.push(`removed ${stripped.join(', ')} from the replacement so recovery cannot erase app data`);
  }
  const appId = (o.appId ?? caps['appium:appPackage'] ?? caps['appium:bundleId']) as string | undefined;
  const before = new Set(listSessions().map((s) => s.sessionId));

  try {
    await safeDeleteSession(o.sessionId);
  } catch {
    // the session is dead; deletion errors are expected
  }
  if (platform === 'android') {
    for (const pkg of ['io.appium.uiautomator2.server', 'io.appium.uiautomator2.server.test']) {
      const udid = caps['appium:udid'] as string | undefined;
      await run([...(udid ? ['-s', udid] : []), 'shell', 'am', 'force-stop', pkg], 6000);
    }
  }
  const created = await createSessionAction({platform: platform as 'android' | 'ios', capabilities: caps});
  const afterSessions = listSessions();
  const fresh = afterSessions.filter((s) => !before.has(s.sessionId));
  if (created.isError || fresh.length !== 1) {
    const msg = String((created.content[0] as {text?: string})?.text ?? '')
      .split('\n')[0]
      .slice(0, 200);
    if (fresh.length > 1) {
      limitations.push(`unexpected: ${fresh.length} new sessions appeared`);
    }
    return {
      ...base,
      attempted: true,
      result: 'failed',
      reason: msg || 'session creation failed',
      attempts: ledger.allow(o.sessionId),
      limitations,
    };
  }
  const newId = fresh[0].sessionId;
  ledger.rekey(o.sessionId, newId);
  if (previouslyActive && previouslyActive !== o.sessionId && getSessionInfo(previouslyActive)) {
    setActiveSession(previouslyActive);
    limitations.push(`session ${previouslyActive} stays the active session; the new one is ${newId}`);
  }
  const newInfo = getSessionInfo(newId);
  let restored: RecoveryReport['appRestored'] = 'not-attempted';
  if (newInfo && appId) {
    try {
      await execute(
        newInfo.driver,
        platform === 'android' ? 'mobile: activateApp' : 'mobile: launchApp',
        platform === 'android' ? {appId} : {bundleId: appId},
      );
    } catch {
      // fall through to the state check
    }
    try {
      restored = (await queryAppState(newInfo.driver, appId)) === 4 ? 'yes' : 'no';
    } catch {
      restored = 'unknown';
    }
  }
  const verify = newInfo ? await probeSession(newInfo.driver) : {alive: false, ms: 0};
  if (!verify.alive) {
    return {
      ...base,
      attempted: true,
      result: 'failed',
      reason: 'the replacement session did not answer a verification request',
      newSessionId: newId,
      appRestored: restored,
      attempts: ledger.allow(o.sessionId),
      limitations,
    };
  }
  limitations.push('in-app state (screen, form input, login) is not restored; the app is relaunched');
  return {...base, attempted: true, result: 'recovered', newSessionId: newId, appRestored: restored, limitations};
}
