import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';

import {assertNoCredentialCaps, cloudStatus, readCreds} from './config.js';
import {requestJson} from './http.js';
import type {
  BuiltSession,
  CheckResult,
  DeviceInfo,
  DeviceListResult,
  DeviceProvider,
  DeviceQuery,
  ProviderStatus,
  SessionRequest,
  UploadResult,
} from './types.js';
import {ProviderError} from './types.js';

/**
 * BrowserStack App Automate. Endpoints and capability names come from browserstack.com/docs and
 * browserstack.com/app-automate/capabilities, read 2026-11-05. Not live-verified: no credentials available.
 * The hub host `hub.browserstack.com` is the one shown on the official getting-started page; a second host
 * (hub-cloud) was seen only in a search snippet and is deliberately not used.
 */
const HUB = 'https://hub.browserstack.com/wd/hub';
const API = 'https://api-cloud.browserstack.com';
const APP_REF = /^(bs:\/\/[A-Za-z0-9]+|[A-Za-z0-9._-]{1,100})$/;

export class BrowserStackProvider implements DeviceProvider {
  readonly id = 'browserstack' as const;
  readonly label = 'BrowserStack App Automate';
  readonly kind = 'cloud' as const;

  status(): ProviderStatus {
    return cloudStatus('browserstack', HUB);
  }

  private creds() {
    const c = readCreds('browserstack');
    if (!c) {
      throw new ProviderError(
        'BrowserStack is not configured: set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY',
        'not-configured',
      );
    }
    return c;
  }

  async check(): Promise<CheckResult> {
    const st = this.status();
    if (!st.configured) {
      return {
        ok: false,
        findings: [`missing: ${st.missing.join(', ')}`],
        nextSteps: ['Export the variables listed above, then re-run this check.'],
      };
    }
    try {
      await requestJson({url: `${API}/app-automate/recent_apps?limit=1`, auth: this.creds(), timeoutMs: 15_000});
      return {ok: true, findings: ['credentials accepted by api-cloud.browserstack.com'], nextSteps: []};
    } catch (err) {
      const e = err as ProviderError;
      return {
        ok: false,
        findings: [e.message],
        nextSteps:
          e.code === 'auth'
            ? ['Verify BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY (Account > Settings).']
            : ['Check network access to api-cloud.browserstack.com (proxy or firewall).'],
      };
    }
  }

  async listDevices(query: DeviceQuery): Promise<DeviceListResult> {
    const raw = await requestJson<unknown>({url: `${API}/app-automate/devices.json`, auth: this.creds()});
    return mapBrowserStackDevices(raw, query);
  }

  buildSession(request: SessionRequest): BuiltSession {
    const auth = this.creds();
    assertNoCredentialCaps(request.extraCapabilities);
    if (request.app && !APP_REF.test(request.app) && !/^https?:\/\//.test(request.app)) {
      throw new ProviderError(
        'app must be a bs:// reference, a custom_id, or an https URL (use appium_provider_upload_app for local files)',
        'invalid',
      );
    }
    const bstack: Record<string, unknown> = {
      userName: auth.user,
      accessKey: auth.key,
      ...(request.build ? {buildName: request.build} : {}),
      ...(request.name ? {sessionName: request.name} : {}),
    };
    if (request.tunnel?.enabled) {
      bstack.local = true;
      if (request.tunnel.name) {
        bstack.localIdentifier = request.tunnel.name;
      }
    }
    const caps: Record<string, unknown> = {
      platformName: request.platform === 'ios' ? 'iOS' : 'Android',
      ...(request.device?.name ? {'appium:deviceName': request.device.name} : {}),
      ...(request.device?.osVersion ? {'appium:platformVersion': request.device.osVersion} : {}),
      ...(request.app ? {'appium:app': request.app} : {}),
      ...request.extraCapabilities,
      'bstack:options': {...bstack, ...(request.extraCapabilities?.['bstack:options'] as object | undefined)},
    };
    return {hubUrl: HUB, capabilities: caps};
  }

  async uploadApp(path: string): Promise<UploadResult> {
    const bytes = await readFile(path);
    const form = new FormData();
    form.append('file', new Blob([bytes]), basename(path));
    const res = await requestJson<{app_url?: string; custom_id?: string}>({
      method: 'POST',
      url: `${API}/app-automate/upload`,
      auth: this.creds(),
      form,
      timeoutMs: 600_000,
    });
    if (!res?.app_url) {
      throw new ProviderError('upload succeeded but the response had no app_url', 'http');
    }
    return {appRef: res.app_url, detail: res.custom_id};
  }

  async setSessionStatus(sessionId: string, passed: boolean, reason?: string): Promise<void> {
    await requestJson({
      method: 'PUT',
      url: `${API}/app-automate/sessions/${encodeURIComponent(sessionId)}.json`,
      auth: this.creds(),
      body: {status: passed ? 'passed' : 'failed', ...(reason ? {reason: reason.slice(0, 250)} : {})},
    });
  }

  async sessionDetails(sessionId: string): Promise<Record<string, unknown>> {
    const r = await requestJson<{automation_session?: Record<string, unknown>}>({
      url: `${API}/app-automate/sessions/${encodeURIComponent(sessionId)}.json`,
      auth: this.creds(),
    });
    const s = r.automation_session ?? {};
    const pick = [
      'status',
      'reason',
      'name',
      'build_name',
      'device',
      'os',
      'os_version',
      'duration',
      'video_url',
      'device_logs_url',
      'appium_logs_url',
    ];
    return Object.fromEntries(pick.filter((k) => k in s).map((k) => [k, s[k]]));
  }
}

/** Pure mapping. The list endpoint does not report whether a device is free, so status stays unknown. */
export function mapBrowserStackDevices(raw: unknown, query: DeviceQuery): DeviceListResult {
  const list = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
  let out: DeviceInfo[] = list.map((d) => {
    const os = String(d.os ?? '').toLowerCase();
    return {
      provider: 'browserstack' as const,
      platform: os === 'ios' ? ('ios' as const) : ('android' as const),
      id: `${String(d.device ?? '')}|${String(d.os_version ?? '')}`,
      name: String(d.device ?? ''),
      osVersion: d.os_version ? String(d.os_version) : undefined,
      kind: 'cloud-real' as const,
      status: 'unknown' as const,
    };
  });
  if (query.platform) {
    out = out.filter((d) => d.platform === query.platform);
  }
  if (query.name) {
    const w = query.name.toLowerCase();
    out = out.filter((d) => d.name.toLowerCase().includes(w));
  }
  if (query.osVersion) {
    out = out.filter((d) => d.osVersion === query.osVersion || d.osVersion?.startsWith(`${query.osVersion}.`));
  }
  const limit = query.limit ?? 25;
  return {
    devices: out.slice(0, limit),
    truncated: out.length > limit,
    total: out.length,
    note: 'BrowserStack does not report live availability in the device list; a session request can still queue.',
  };
}
