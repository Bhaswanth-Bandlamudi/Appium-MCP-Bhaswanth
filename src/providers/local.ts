import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {platform as osPlatform} from 'node:os';
import {join} from 'node:path';

import type {
  CheckResult,
  DeviceInfo,
  DeviceListResult,
  DeviceProvider,
  DeviceQuery,
  DeviceStatus,
  ProviderStatus,
} from './types.js';

const ADB_TIMEOUT_MS = 8_000;

export type Runner = (
  file: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<{stdout: string; code: number}>;

/**
 * Runs a binary with an argument array (never a shell string). Only used with the fixed, allowlisted
 * commands below; user-supplied values are validated before they reach an argument.
 */
export const defaultRunner: Runner = (file, args, timeoutMs = ADB_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], {timeout: timeoutMs, windowsHide: true, maxBuffer: 2_000_000}, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(err);
        return;
      }
      const code = err ? Number((err as {code?: number}).code ?? 1) : 0;
      resolve({stdout: String(stdout ?? ''), code});
    });
  });

let runner: Runner = defaultRunner;
export function setRunnerForTests(r: Runner): () => void {
  const prev = runner;
  runner = r;
  return () => {
    runner = prev;
  };
}

/** adb serials look like emulator-5554, 0123456789ABCDEF, 192.168.1.5:5555, adb-XXXX-YYYY._adb-tls-connect._tcp */
const SERIAL = /^[A-Za-z0-9._:-]{1,80}$/;
const AVD_NAME = /^[A-Za-z0-9._-]{1,80}$/;
export const isValidSerial = (s: string): boolean => SERIAL.test(s);
export const isValidAvd = (s: string): boolean => AVD_NAME.test(s);

export function adbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  if (home) {
    const p = join(home, 'platform-tools', osPlatform() === 'win32' ? 'adb.exe' : 'adb');
    if (existsSync(p)) {
      return p;
    }
  }
  return 'adb';
}

const STATE_MAP: Record<string, DeviceStatus> = {
  device: 'available',
  offline: 'offline',
  unauthorized: 'unauthorized',
  authorizing: 'unauthorized',
};

/** Parse `adb devices -l`. Pure. */
export function parseAdbDevices(out: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) {
      continue;
    }
    const m = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) {
      continue;
    }
    const [, serial, state, rest = ''] = m;
    const kv = Object.fromEntries([...rest.matchAll(/(\w+):(\S+)/g)].map((x) => [x[1], x[2]]));
    const emulator = serial.startsWith('emulator-');
    const status = STATE_MAP[state] ?? 'unknown';
    devices.push({
      provider: 'local-android',
      platform: 'android',
      id: serial,
      name: kv.model?.replace(/_/g, ' ') ?? kv.device ?? serial,
      model: kv.model?.replace(/_/g, ' '),
      kind: emulator ? 'emulator' : 'physical',
      status,
      ...(status === 'unauthorized'
        ? {note: 'Accept the "Allow USB debugging" prompt on the device, then run adb devices again.'}
        : status === 'offline'
          ? {note: 'Reconnect the device, or restart adb with: adb kill-server && adb start-server.'}
          : {}),
    });
  }
  return devices;
}

export function parseAvdList(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && isValidAvd(l) && !l.startsWith('INFO') && !l.includes(' '));
}

async function adb(args: readonly string[]): Promise<{stdout: string; code: number}> {
  return runner(adbPath(), args);
}

export class LocalAndroidProvider implements DeviceProvider {
  readonly id = 'local-android' as const;
  readonly label = 'Local Android (emulators and USB devices)';
  readonly kind = 'local' as const;

  status(): ProviderStatus {
    const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    return {
      id: this.id,
      label: this.label,
      kind: 'local',
      configured: true,
      missing: home ? [] : ['ANDROID_HOME (or ANDROID_SDK_ROOT) is not set; adb must then be on PATH'],
      supported: true,
    };
  }

  async check(): Promise<CheckResult> {
    const findings: string[] = [];
    const nextSteps: string[] = [];
    try {
      const v = await adb(['version']);
      findings.push(`adb found: ${v.stdout.split(/\r?\n/)[0]?.trim() || 'version unknown'}`);
    } catch {
      return {
        ok: false,
        findings: ['adb executable not found'],
        nextSteps: [
          'Install Android SDK platform-tools and set ANDROID_HOME (or ANDROID_SDK_ROOT), or add adb to PATH.',
        ],
      };
    }
    let devices: DeviceInfo[] = [];
    try {
      const r = await adb(['devices', '-l']);
      devices = parseAdbDevices(r.stdout);
    } catch {
      return {ok: false, findings, nextSteps: ['adb could not be run; check the path and permissions.']};
    }
    const ready = devices.filter((d) => d.status === 'available');
    findings.push(`${devices.length} device(s) listed, ${ready.length} ready`);
    for (const d of devices.filter((x) => x.status !== 'available')) {
      findings.push(`${d.id}: ${d.status}`);
      if (d.note) {
        nextSteps.push(`${d.id}: ${d.note}`);
      }
    }
    if (ready.length === 0 && devices.length === 0) {
      nextSteps.push(
        'Start an emulator (Android Studio Device Manager) or connect a device with USB debugging enabled.',
      );
    }
    return {ok: ready.length > 0, findings, nextSteps};
  }

  async listDevices(query: DeviceQuery): Promise<DeviceListResult> {
    if (query.platform && query.platform !== 'android') {
      return {devices: [], truncated: false, total: 0};
    }
    let out: {stdout: string};
    try {
      out = await adb(['devices', '-l']);
    } catch {
      return {
        devices: [],
        truncated: false,
        total: 0,
        note: 'adb not found: see appium_provider_check provider=local-android',
      };
    }
    let devices = parseAdbDevices(out.stdout);
    const wanted = query.name?.toLowerCase();
    if (wanted) {
      devices = devices.filter((d) => `${d.name} ${d.id}`.toLowerCase().includes(wanted));
    }
    // Enrich ready devices with the Android release; a failure only costs the field.
    for (const d of devices.filter((x) => x.status === 'available')) {
      try {
        const r = await adb(['-s', d.id, 'shell', 'getprop', 'ro.build.version.release']);
        const v = r.stdout.trim();
        if (/^[0-9][0-9.]*$/.test(v)) {
          d.osVersion = v;
        }
      } catch {
        // leave unset
      }
    }
    if (query.osVersion) {
      devices = devices.filter((d) => d.osVersion?.startsWith(query.osVersion as string));
    }
    const limit = query.limit ?? 25;
    let note: string | undefined;
    try {
      const avds = parseAvdList((await runner(emulatorPath(), ['-list-avds'])).stdout);
      const running = devices.filter((d) => d.kind === 'emulator').length;
      if (avds.length > running) {
        note = `Defined AVDs (not necessarily running): ${avds.slice(0, 8).join(', ')}`;
      }
    } catch {
      // emulator binary not present; ignore
    }
    return {
      devices: devices.slice(0, limit),
      truncated: devices.length > limit,
      total: devices.length,
      ...(note ? {note} : {}),
    };
  }
}

export function emulatorPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  if (home) {
    const p = join(home, 'emulator', osPlatform() === 'win32' ? 'emulator.exe' : 'emulator');
    if (existsSync(p)) {
      return p;
    }
  }
  return 'emulator';
}

/** Parse `xcrun simctl list devices -j`. Pure. */
export function parseSimctl(json: string): DeviceInfo[] {
  let parsed: {devices?: Record<string, {name: string; udid: string; state: string; isAvailable?: boolean}[]>};
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const out: DeviceInfo[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
    const m = /iOS-(\d+)-(\d+)/.exec(runtime);
    if (!m) {
      continue;
    }
    for (const d of list) {
      if (d.isAvailable === false) {
        continue;
      }
      out.push({
        provider: 'local-ios',
        platform: 'ios',
        id: d.udid,
        name: d.name,
        osVersion: `${m[1]}.${m[2]}`,
        kind: 'simulator',
        status: d.state === 'Booted' ? 'booted' : d.state === 'Shutdown' ? 'shutdown' : 'unknown',
      });
    }
  }
  return out;
}

export class LocalIosProvider implements DeviceProvider {
  readonly id = 'local-ios' as const;
  readonly label = 'Local iOS (simulators and devices; macOS only)';
  readonly kind = 'local' as const;

  private isMac(): boolean {
    return osPlatform() === 'darwin';
  }

  status(): ProviderStatus {
    const mac = this.isMac();
    return {
      id: this.id,
      label: this.label,
      kind: 'local',
      configured: mac,
      missing: [],
      supported: mac,
      ...(mac
        ? {}
        : {
            unsupportedReason: `Local iOS automation needs macOS with Xcode (this host is ${osPlatform()}). Use a cloud provider or a remote Appium server on a Mac instead.`,
          }),
    };
  }

  async check(): Promise<CheckResult> {
    if (!this.isMac()) {
      return {
        ok: false,
        findings: [`Host OS is ${osPlatform()}; Xcode and simulators are not available.`],
        nextSteps: [
          'Run the MCP on a Mac, point remoteServerUrl at an Appium server on a Mac, or use a cloud provider (see appium_provider_check).',
        ],
      };
    }
    try {
      const r = await runner('xcrun', ['simctl', 'list', 'devices', '-j']);
      const sims = parseSimctl(r.stdout);
      const booted = sims.filter((s) => s.status === 'booted').length;
      return {
        ok: sims.length > 0,
        findings: [`${sims.length} simulator(s), ${booted} booted`],
        nextSteps: sims.length ? [] : ['Install an iOS runtime in Xcode > Settings > Components.'],
      };
    } catch {
      return {ok: false, findings: ['xcrun not found'], nextSteps: ['Install Xcode and run: xcode-select --install']};
    }
  }

  async listDevices(query: DeviceQuery): Promise<DeviceListResult> {
    if (query.platform && query.platform !== 'ios') {
      return {devices: [], truncated: false, total: 0};
    }
    if (!this.isMac()) {
      return {devices: [], truncated: false, total: 0, note: this.status().unsupportedReason};
    }
    try {
      const r = await runner('xcrun', ['simctl', 'list', 'devices', '-j']);
      let sims = parseSimctl(r.stdout);
      const w = query.name?.toLowerCase();
      if (w) {
        sims = sims.filter((s) => s.name.toLowerCase().includes(w));
      }
      if (query.osVersion) {
        sims = sims.filter((s) => s.osVersion?.startsWith(query.osVersion as string));
      }
      sims.sort((a, b) => Number(b.status === 'booted') - Number(a.status === 'booted'));
      const limit = query.limit ?? 25;
      return {
        devices: sims.slice(0, limit),
        truncated: sims.length > limit,
        total: sims.length,
        note: 'Physical iPhones are not listed: they need Xcode/devicectl and are not enumerated here.',
      };
    } catch {
      return {devices: [], truncated: false, total: 0, note: 'xcrun not available'};
    }
  }
}
