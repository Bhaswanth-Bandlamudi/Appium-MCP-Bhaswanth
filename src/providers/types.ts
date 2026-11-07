export type ProviderId = 'local-android' | 'local-ios' | 'lambdatest' | 'browserstack' | 'saucelabs' | 'kobiton';

export type Platform = 'android' | 'ios';

export type DeviceStatus = 'available' | 'busy' | 'booted' | 'shutdown' | 'offline' | 'unauthorized' | 'unknown';

export interface DeviceInfo {
  provider: ProviderId;
  platform: Platform;
  /** Provider device identifier: adb serial, simulator UDID, or the cloud device name/id. */
  id: string;
  name: string;
  model?: string;
  osVersion?: string;
  kind: 'emulator' | 'simulator' | 'physical' | 'cloud-real' | 'cloud-virtual';
  status: DeviceStatus;
  note?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  kind: 'local' | 'cloud';
  /** All required environment variables are present. Says nothing about whether they are valid. */
  configured: boolean;
  /** Names of missing environment variables. Never values. */
  missing: string[];
  /** false when this host cannot run the provider at all (for example local iOS on Windows). */
  supported: boolean;
  unsupportedReason?: string;
  /** Hub URL without credentials, when applicable. */
  endpoint?: string;
}

export interface CheckResult {
  ok: boolean;
  /** Plain-language findings, safe to show. */
  findings: string[];
  /** Concrete next steps when not ok. */
  nextSteps: string[];
}

export interface DeviceQuery {
  platform?: Platform;
  /** Case-insensitive substring of the device name/model. */
  name?: string;
  osVersion?: string;
  limit?: number;
}

export interface DeviceListResult {
  devices: DeviceInfo[];
  /** True when more devices exist than were returned. */
  truncated: boolean;
  total: number;
  note?: string;
}

export interface SessionRequest {
  platform: Platform;
  device?: {name?: string; osVersion?: string; id?: string};
  /** Provider app reference (for example bs://..., lt://..., storage:filename=...), a URL, or a local path (local providers only). */
  app?: string;
  build?: string;
  name?: string;
  tunnel?: {enabled: boolean; name?: string};
  /** Extra W3C capabilities merged last. Provider credentials are rejected here. */
  extraCapabilities?: Record<string, unknown>;
}

export interface BuiltSession {
  /** Hub URL with NO credentials in it. */
  hubUrl: string;
  /** Credentials are passed to the WebDriver client separately and never stored with the session. */
  auth?: {user: string; key: string};
  capabilities: Record<string, unknown>;
}

export interface UploadResult {
  appRef: string;
  /** Provider-reported file name/id, for display. */
  detail?: string;
}

export interface DeviceProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly kind: 'local' | 'cloud';
  status(): ProviderStatus;
  check(): Promise<CheckResult>;
  listDevices(query: DeviceQuery): Promise<DeviceListResult>;
  /** Cloud only. Local providers use the embedded Appium drivers and need no hub. */
  buildSession?(request: SessionRequest): BuiltSession;
  uploadApp?(path: string): Promise<UploadResult>;
  /** Cloud only: report pass/fail for a finished session. Optional because not every provider supports it. */
  setSessionStatus?(sessionId: string, passed: boolean, reason?: string): Promise<void>;
  /** Cloud only: provider-side details for a session id. */
  sessionDetails?(sessionId: string): Promise<Record<string, unknown>>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'not-configured' | 'unsupported' | 'auth' | 'http' | 'network' | 'invalid' | 'not-found',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
