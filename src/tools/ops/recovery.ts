export type FailureKind =
  | 'healthy'
  | 'no-device'
  | 'device-unauthorized'
  | 'device-offline'
  | 'appium-server-unreachable'
  | 'driver-crashed'
  | 'session-expired'
  | 'app-not-running'
  | 'app-in-background'
  | 'app-unresponsive'
  | 'wda-failure'
  | 'unknown';

export interface Evidence {
  /** Did a lightweight session command succeed? */
  sessionResponds: boolean;
  /** Error text from the failed probe, if any. */
  probeError?: string;
  platform: 'android' | 'ios';
  remote: boolean;
  /** adb state of this session's device: 'device' | 'offline' | 'unauthorized' | 'absent' | undefined when not checked. */
  deviceState?: string;
  /** App state from queryAppState: 0 none, 1 not running, 2 suspended, 3 background, 4 foreground. */
  appState?: number;
  /** Foreground package differs from the app under test. */
  foregroundPackage?: string;
  /** A "not responding" dialog is on screen. */
  anrDialog?: boolean;
  /** Remote Appium /status reachable. Only meaningful for remote sessions. */
  serverReachable?: boolean;
}

export interface Classification {
  kind: FailureKind;
  /** Plain-language signals that produced the classification. */
  signals: string[];
  /** Whether replacing the session is a sensible response to this failure. */
  recoverable: boolean;
  /** What a person has to fix first when recovery cannot help. */
  blocker?: string;
}

/**
 * Pure classification of what is actually wrong. Order matters: the most fundamental failure
 * (no device, no server) is reported before symptoms that follow from it.
 */
export function classifyFailure(e: Evidence): Classification {
  const s: string[] = [];
  if (e.deviceState === 'absent') {
    return {
      kind: 'no-device',
      signals: ['the device is not listed by adb'],
      recoverable: false,
      blocker: 'reconnect the device or start the emulator',
    };
  }
  if (e.deviceState === 'unauthorized') {
    return {
      kind: 'device-unauthorized',
      signals: ['adb reports the device as unauthorized'],
      recoverable: false,
      blocker: 'accept the USB debugging prompt on the device',
    };
  }
  if (e.deviceState === 'offline') {
    return {
      kind: 'device-offline',
      signals: ['adb reports the device as offline'],
      recoverable: false,
      blocker: 'reconnect the device or run adb kill-server then adb start-server',
    };
  }
  if (e.remote && e.serverReachable === false) {
    return {
      kind: 'appium-server-unreachable',
      signals: ['the remote Appium server did not answer /status'],
      recoverable: false,
      blocker: 'start or reach the Appium server (check network, tunnel and URL)',
    };
  }
  if (e.sessionResponds) {
    if (e.anrDialog) {
      return {
        kind: 'app-unresponsive',
        signals: ['a "not responding" dialog is on screen'],
        recoverable: false,
        blocker: 'dismiss the dialog (appium_dismiss_interrupts) or restart the app; a new session would not clear it',
      };
    }
    if (e.appState !== undefined && e.appState <= 1) {
      return {
        kind: 'app-not-running',
        signals: [`app state ${e.appState}: not running`],
        recoverable: false,
        blocker: 'launch the app (appium_app_lifecycle activate); the session itself is healthy',
      };
    }
    if (e.appState === 3 || e.appState === 2 || (e.foregroundPackage && e.appState !== 4)) {
      return {
        kind: 'app-in-background',
        signals: [`app is in the background${e.foregroundPackage ? ` (foreground: ${e.foregroundPackage})` : ''}`],
        recoverable: false,
        blocker: 'bring the app to the front (appium_app_lifecycle activate); the session itself is healthy',
      };
    }
    return {kind: 'healthy', signals: ['the session answered a page-source request'], recoverable: false};
  }
  const err = e.probeError ?? '';
  if (
    /invalid session|no such (driver|session)|session (is )?(not|has) (found|started|terminated|ended)|(terminated|ended) or not started|NoSuchDriver|timed out waiting|new command timeout|session.*(expired|timeout)/i.test(
      err,
    )
  ) {
    s.push(`probe error: ${err.slice(0, 100)}`);
    return {kind: 'session-expired', signals: s, recoverable: true};
  }
  if (e.platform === 'ios' && /WebDriverAgent|WDA|xcodebuild|wda/i.test(err)) {
    s.push(`probe error mentions WebDriverAgent: ${err.slice(0, 100)}`);
    return {kind: 'wda-failure', signals: s, recoverable: true};
  }
  if (
    /instrumentation|UiAutomator2|uiautomator2|server.*(crash|died|not running)|socket hang up|cannot be proxied|ECONNRESET|ECONNREFUSED/i.test(
      err,
    )
  ) {
    s.push(`probe error: ${err.slice(0, 100)}`);
    return {kind: e.platform === 'ios' ? 'wda-failure' : 'driver-crashed', signals: s, recoverable: true};
  }
  s.push(err ? `probe error: ${err.slice(0, 100)}` : 'the session did not respond');
  return {kind: 'unknown', signals: s, recoverable: true};
}

export interface RecoveryLimits {
  /** Attempts per session lineage inside the window. */
  maxAttempts: number;
  windowMs: number;
}

export const DEFAULT_LIMITS: RecoveryLimits = {maxAttempts: 2, windowMs: 10 * 60_000};

/**
 * Bounded retry ledger. The key is a session lineage (the original session id is carried to the
 * replacement), so a flapping device cannot trigger an endless create-delete loop.
 */
export class RecoveryLedger {
  private readonly attempts = new Map<string, number[]>();
  constructor(private readonly limits: RecoveryLimits = DEFAULT_LIMITS) {}

  allow(lineage: string, now = Date.now()): {allowed: boolean; used: number; max: number} {
    const recent = (this.attempts.get(lineage) ?? []).filter((t) => now - t < this.limits.windowMs);
    this.attempts.set(lineage, recent);
    return {allowed: recent.length < this.limits.maxAttempts, used: recent.length, max: this.limits.maxAttempts};
  }
  record(lineage: string, now = Date.now()): void {
    const recent = (this.attempts.get(lineage) ?? []).filter((t) => now - t < this.limits.windowMs);
    recent.push(now);
    this.attempts.set(lineage, recent);
  }
  /** Carries the attempt history across to the replacement session id. */
  rekey(from: string, to: string): void {
    const a = this.attempts.get(from);
    if (a) {
      this.attempts.set(to, a);
      this.attempts.delete(from);
    }
  }
  reset(): void {
    this.attempts.clear();
  }
}

export interface RecoveryReport {
  originalSession: string;
  failure: Classification;
  attempted: boolean;
  result: 'not-needed' | 'recovered' | 'failed' | 'refused';
  reason?: string;
  newSessionId?: string;
  appRestored?: 'yes' | 'no' | 'not-attempted' | 'unknown';
  attempts?: {used: number; max: number};
  limitations: string[];
}

/** Capabilities to reuse. A replacement must never reset app data, whatever the original asked for. */
export function safeReplacementCapabilities(caps: Record<string, unknown>): {
  caps: Record<string, unknown>;
  stripped: string[];
} {
  const out: Record<string, unknown> = {...caps};
  const stripped: string[] = [];
  for (const k of ['appium:fullReset', 'fullReset']) {
    if (k in out) {
      delete out[k];
      stripped.push(k);
    }
  }
  const opts = out['appium:options'];
  if (opts && typeof opts === 'object' && 'fullReset' in (opts as Record<string, unknown>)) {
    const {fullReset: _f, ...rest} = opts as Record<string, unknown>;
    out['appium:options'] = rest;
    stripped.push('appium:options.fullReset');
  }
  return {caps: out, stripped};
}
