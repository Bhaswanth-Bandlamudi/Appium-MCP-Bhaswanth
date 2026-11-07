import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';

import {assertNoCredentialCaps, cloudStatus, pickRegion, readCreds} from './config.js';
import {requestJson} from './http.js';
import type {
  BuiltSession,
  CheckResult,
  DeviceInfo,
  DeviceListResult,
  DeviceProvider,
  DeviceQuery,
  DeviceStatus,
  ProviderStatus,
  SessionRequest,
  UploadResult,
} from './types.js';
import {ProviderError} from './types.js';

/**
 * Sauce Labs. Facts used here come from docs.saucelabs.com (data-center endpoints, real-device Appium,
 * storage API, RDC API) read on 2026-11-05. Not live-verified: no Sauce credentials were available.
 */
const REGIONS = ['us-west-1', 'us-east-4', 'eu-central-1', 'asia-south-2'] as const;
type Region = (typeof REGIONS)[number];

const hub = (r: Region) => `https://ondemand.${r}.saucelabs.com/wd/hub`;
const api = (r: Region) => `https://api.${r}.saucelabs.com`;

const RDC_STATE: Record<string, DeviceStatus> = {
  AVAILABLE: 'available',
  IN_USE: 'busy',
  CLEANING: 'busy',
  REBOOTING: 'busy',
  MAINTENANCE: 'offline',
  OFFLINE: 'offline',
};

export class SauceLabsProvider implements DeviceProvider {
  readonly id = 'saucelabs' as const;
  readonly label = 'Sauce Labs';
  readonly kind = 'cloud' as const;

  private region(): Region {
    return pickRegion(process.env.SAUCE_REGION, REGIONS, 'us-west-1');
  }

  status(): ProviderStatus {
    return cloudStatus('saucelabs', hub(this.region()));
  }

  private creds() {
    const c = readCreds('saucelabs');
    if (!c) {
      throw new ProviderError(
        'Sauce Labs is not configured: set SAUCE_USERNAME and SAUCE_ACCESS_KEY',
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
    const r = this.region();
    try {
      await requestJson({url: `${api(r)}/v1/rdc/devices/status`, auth: this.creds(), timeoutMs: 15_000});
      return {ok: true, findings: [`credentials accepted by ${api(r)}`, `region ${r}`], nextSteps: []};
    } catch (err) {
      const e = err as ProviderError;
      return {
        ok: false,
        findings: [e.message],
        nextSteps:
          e.code === 'auth'
            ? ['Verify SAUCE_USERNAME and SAUCE_ACCESS_KEY, and that SAUCE_REGION matches your account data center.']
            : ['Check network access to api.' + r + '.saucelabs.com (proxy or firewall).'],
      };
    }
  }

  async listDevices(query: DeviceQuery): Promise<DeviceListResult> {
    const r = this.region();
    const auth = this.creds();
    const [devices, states] = await Promise.all([
      requestJson<unknown>({url: `${api(r)}/v1/rdc/devices`, auth}),
      requestJson<unknown>({url: `${api(r)}/v1/rdc/devices/status`, auth}).catch(() => undefined),
    ]);
    return mapSauceDevices(devices, states, query);
  }

  buildSession(request: SessionRequest): BuiltSession {
    const auth = this.creds();
    assertNoCredentialCaps(request.extraCapabilities);
    const sauce: Record<string, unknown> = {username: auth.user, accessKey: auth.key};
    if (request.build) {
      sauce.build = request.build;
    }
    if (request.name) {
      sauce.name = request.name;
    }
    if (request.tunnel?.enabled) {
      if (!request.tunnel.name) {
        throw new ProviderError(
          'tunnel.name is required: this server never starts or guesses a shared tunnel',
          'invalid',
        );
      }
      sauce.tunnelName = request.tunnel.name;
    }
    const caps: Record<string, unknown> = {
      platformName: request.platform === 'ios' ? 'iOS' : 'Android',
      'appium:automationName': request.platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
      ...(request.device?.name ? {'appium:deviceName': request.device.name} : {}),
      ...(request.device?.osVersion ? {'appium:platformVersion': request.device.osVersion} : {}),
      ...(request.app ? {'appium:app': request.app} : {}),
      ...request.extraCapabilities,
      'sauce:options': {...sauce, ...(request.extraCapabilities?.['sauce:options'] as object | undefined)},
    };
    // The credentials live in capabilities for Sauce, so this block is held only inside the WebDriver
    // client for the session request; the stored session metadata is scrubbed by the connect layer.
    return {hubUrl: hub(this.region()), capabilities: caps};
  }

  async uploadApp(path: string): Promise<UploadResult> {
    const auth = this.creds();
    const name = basename(path);
    const bytes = await readFile(path);
    const form = new FormData();
    form.append('payload', new Blob([bytes]), name);
    form.append('name', name);
    const res = await requestJson<{item?: {id?: string; name?: string}}>({
      method: 'POST',
      url: `${api(this.region())}/v1/storage/upload`,
      auth,
      form,
      timeoutMs: 600_000,
    });
    return {appRef: `storage:filename=${res.item?.name ?? name}`, detail: res.item?.id};
  }

  async setSessionStatus(sessionId: string, passed: boolean): Promise<void> {
    await requestJson({
      method: 'PUT',
      url: `${api(this.region())}/v1/rdc/jobs/${encodeURIComponent(sessionId)}`,
      auth: this.creds(),
      body: {passed},
    });
  }

  async sessionDetails(sessionId: string): Promise<Record<string, unknown>> {
    const j = await requestJson<Record<string, unknown>>({
      url: `${api(this.region())}/v1/rdc/jobs/${encodeURIComponent(sessionId)}`,
      auth: this.creds(),
    });
    const pick = ['id', 'status', 'consolidated_status', 'name', 'build', 'os', 'os_version', 'device_name', 'error'];
    return Object.fromEntries(pick.filter((k) => k in j).map((k) => [k, j[k]]));
  }
}

/** Pure mapping so it can be tested without a network. Field names are read defensively because the response shape was not fully visible in the docs. */
export function mapSauceDevices(devicesRaw: unknown, statesRaw: unknown, query: DeviceQuery): DeviceListResult {
  const list = (
    Array.isArray(devicesRaw) ? devicesRaw : ((devicesRaw as {entities?: unknown[]})?.entities ?? [])
  ) as Record<string, unknown>[];
  const stateList = (
    Array.isArray(statesRaw) ? statesRaw : ((statesRaw as {devices?: unknown[]})?.devices ?? [])
  ) as Record<string, unknown>[];
  const stateById = new Map(
    stateList.map((s) => [String(s.descriptor ?? s.id ?? ''), String(s.state ?? s.status ?? '')]),
  );
  let out: DeviceInfo[] = list.map((d) => {
    const id = String(d.descriptor ?? d.id ?? d.name ?? '');
    const os = String(d.os ?? d.platform ?? '').toLowerCase();
    return {
      provider: 'saucelabs' as const,
      platform: os.includes('ios') ? ('ios' as const) : ('android' as const),
      id,
      name: String(d.name ?? id),
      model: d.modelNumber ? String(d.modelNumber) : undefined,
      osVersion: d.osVersion ? String(d.osVersion) : undefined,
      kind: 'cloud-real' as const,
      status: RDC_STATE[stateById.get(id)?.toUpperCase() ?? ''] ?? 'unknown',
    };
  });
  if (query.platform) {
    out = out.filter((d) => d.platform === query.platform);
  }
  if (query.name) {
    const w = query.name.toLowerCase();
    out = out.filter((d) => `${d.name} ${d.id}`.toLowerCase().includes(w));
  }
  if (query.osVersion) {
    out = out.filter((d) => d.osVersion?.startsWith(query.osVersion as string));
  }
  out.sort((a, b) => Number(b.status === 'available') - Number(a.status === 'available'));
  const limit = query.limit ?? 25;
  return {devices: out.slice(0, limit), truncated: out.length > limit, total: out.length};
}
