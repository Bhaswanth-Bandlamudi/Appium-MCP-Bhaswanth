import {execFile} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {platform as hostOs} from 'node:os';
import {join} from 'node:path';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Shared helpers for the device integration suite. These tests are NOT part of `npm test`; run them with
 * `npm run test:integration:android` or `npm run test:integration:ios`. They need a built server (`npm run build`)
 * and a device or simulator, and they never need cloud credentials.
 */

export type TargetPlatform = 'android' | 'ios';

export const ROOT = process.cwd();
export const RESULTS_DIR = process.env.INTEGRATION_RESULTS_DIR ?? join(ROOT, 'integration-results');

export interface Health {
  healthy: boolean;
  /** Plain-language reasons the device is not usable; empty when healthy. */
  reasons: string[];
  facts: Record<string, string | number>;
}

export type RunFn = (file: string, args: string[], timeoutMs?: number) => Promise<{stdout: string; ok: boolean}>;

const realRun: RunFn = (file, args, timeoutMs = 15_000) =>
  new Promise((resolve) => {
    execFile(file, args, {timeout: timeoutMs, windowsHide: true, maxBuffer: 4_000_000}, (err, stdout) =>
      resolve({stdout: String(stdout ?? ''), ok: !err}),
    );
  });

const adbBin = (): string => {
  const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  return home ? join(home, 'platform-tools', hostOs() === 'win32' ? 'adb.exe' : 'adb') : 'adb';
};

/**
 * Android health gate. A device is usable only if it is booted, has no "not responding" dialog, and the
 * host is not so short of memory that the emulator is known to stall. Thresholds can be overridden.
 */
export async function androidHealth(
  serial?: string,
  run: RunFn = realRun,
  hostFreeMbFn: () => Promise<number | undefined> = hostFreeMb,
): Promise<Health> {
  const reasons: string[] = [];
  const facts: Record<string, string | number> = {};
  const s = serial ? ['-s', serial] : [];
  const devices = await run(adbBin(), ['devices']);
  const ready = devices.stdout.split(/\r?\n/).filter((l) => /\tdevice$/.test(l));
  facts.devicesReady = ready.length;
  if (ready.length === 0) {
    return {healthy: false, reasons: ['no Android device or emulator in state "device"'], facts};
  }
  if (!serial && ready.length > 1) {
    reasons.push(`${ready.length} devices attached; set ANDROID_SERIAL so the right one is used`);
  }
  const boot = (await run(adbBin(), [...s, 'shell', 'getprop', 'sys.boot_completed'])).stdout.trim();
  facts.bootCompleted = boot;
  if (boot !== '1') {
    reasons.push('sys.boot_completed is not 1');
  }
  const focus =
    (await run(adbBin(), [...s, 'shell', 'dumpsys', 'window'])).stdout.match(/mCurrentFocus=.*$/m)?.[0] ?? '';
  facts.focus = focus.slice(0, 90);
  if (/Not Responding|isn't responding/i.test(focus)) {
    reasons.push('an "Application Not Responding" dialog is on screen');
  }
  const mem = (await run(adbBin(), [...s, 'shell', 'cat', '/proc/meminfo'])).stdout;
  const avail = Number(/MemAvailable:\s+(\d+)/.exec(mem)?.[1] ?? 0) / 1024;
  facts.guestMemAvailableMB = Math.round(avail);
  const minGuest = Number(process.env.INTEGRATION_MIN_GUEST_MB ?? 600);
  if (avail && avail < minGuest) {
    reasons.push(`guest has ${Math.round(avail)} MB available (< ${minGuest})`);
  }
  const freeHostMb = await hostFreeMbFn();
  if (freeHostMb !== undefined) {
    facts.hostFreeMB = freeHostMb;
    const minHost = Number(process.env.INTEGRATION_MIN_HOST_MB ?? 1500);
    if (process.env.INTEGRATION_MIN_HOST_MB) {
      facts.hostThresholdOverrideMB = minHost;
    }
    if (freeHostMb < minHost) {
      reasons.push(`host has ${freeHostMb} MB free (< ${minHost}); the emulator stalls under that`);
    }
  }
  return {healthy: reasons.length === 0, reasons, facts};
}

async function hostFreeMb(): Promise<number | undefined> {
  const {freemem} = await import('node:os');
  return Math.round(freemem() / 1024 / 1024);
}

/** iOS simulator health gate. Only meaningful on macOS. */
export async function iosHealth(udid?: string, run: RunFn = realRun, osName: string = hostOs()): Promise<Health> {
  if (osName !== 'darwin') {
    return {healthy: false, reasons: [`host is ${osName}; iOS simulators need macOS with Xcode`], facts: {}};
  }
  const out = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
  let booted: {udid: string; name: string}[] = [];
  try {
    booted = Object.values(
      (JSON.parse(out.stdout).devices ?? {}) as Record<string, {udid: string; name: string}[]>,
    ).flat();
  } catch {
    return {
      healthy: false,
      reasons: ['xcrun simctl is not usable (install Xcode and its command line tools)'],
      facts: {},
    };
  }
  const facts = {bootedSimulators: booted.length};
  if (booted.length === 0) {
    return {healthy: false, reasons: ['no booted simulator (xcrun simctl boot <udid>)'], facts};
  }
  if (udid && !booted.some((b) => b.udid === udid)) {
    return {healthy: false, reasons: [`simulator ${udid} is not booted`], facts};
  }
  return {healthy: true, reasons: [], facts};
}

export interface Mcp {
  call(name: string, args?: Record<string, unknown>): Promise<{isError: boolean; text: string}>;
  close(): Promise<void>;
}

export async function startMcp(env: Record<string, string> = {}): Promise<Mcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'index.js')],
    cwd: ROOT,
    env: {...process.env, NO_UI: 'true', APPIUM_MCP_OTEL_ENABLED: 'false', ...env} as Record<string, string>,
    stderr: 'ignore',
  });
  const client = new Client({name: 'integration', version: '1'});
  await client.connect(transport);
  return {
    async call(name, args = {}) {
      const r = await client.callTool({name, arguments: args}, undefined, {
        timeout: Number(process.env.INTEGRATION_CALL_TIMEOUT_MS ?? 360_000),
      });
      const content = (r.content ?? []) as {type: string; text?: string}[];
      return {isError: !!r.isError, text: content.map((x) => x.text ?? '').join('\n')};
    },
    close: () => client.close(),
  };
}

export interface Evidence {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail: string;
  durationMs: number;
}

/** Writes a JSON record so a skipped or failed run still leaves evidence of what was (not) tested. */
export function writeRecord(file: string, payload: unknown): string {
  mkdirSync(RESULTS_DIR, {recursive: true});
  const path = join(RESULTS_DIR, file);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

export const ENABLED = process.env.RUN_DEVICE_TESTS === '1';
