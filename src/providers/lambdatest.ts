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
 * LambdaTest (now branded TestMu AI) App Automate. Endpoints and capability names come from
 * testmuai.com/support/docs, read 2026-11-05. Not live-verified: no credentials were available.
 *
 * Deliberately NOT implemented because the docs read did not show them: session status/stop REST calls,
 * session logs/video/screenshot REST calls, and the `lt:options` vendor block (the pages show LambdaTest
 * capabilities as top-level keys). Sessions are ended by deleting the WebDriver session, and results are
 * viewed in the LambdaTest dashboard.
 */
const HUB = 'https://mobile-hub.lambdatest.com/wd/hub';
const MANUAL_API = 'https://manual-api.lambdatest.com';
const MOBILE_API = 'https://mobile-api.lambdatest.com';
const REGIONS = ['us', 'eu', 'ap'] as const;

export class LambdaTestProvider implements DeviceProvider {
  readonly id = 'lambdatest' as const;
  readonly label = 'LambdaTest App Automate';
  readonly kind = 'cloud' as const;

  status(): ProviderStatus {
    return cloudStatus('lambdatest', HUB);
  }

  private creds() {
    const c = readCreds('lambdatest');
    if (!c) {
      throw new ProviderError(
        'LambdaTest is not configured: set LAMBDATEST_USERNAME and LAMBDATEST_ACCESS_KEY',
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
      const c = await requestJson<{max_concurrency?: number; running?: number; queued?: number; max_queue?: number}>({
        url: `${MOBILE_API}/mobile-automation/api/v1/org/concurrency`,
        auth: this.creds(),
        timeoutMs: 15_000,
      });
      return {
        ok: true,
        findings: [
          'credentials accepted',
          `concurrency: running ${c?.running ?? '?'} of ${c?.max_concurrency ?? '?'}, queued ${c?.queued ?? '?'}`,
        ],
        nextSteps: [],
      };
    } catch (err) {
      const e = err as ProviderError;
      return {
        ok: false,
        findings: [e.message],
        nextSteps:
          e.code === 'auth'
            ? ['Verify LAMBDATEST_USERNAME and LAMBDATEST_ACCESS_KEY (Profile > Account Settings).']
            : ['Check network access to mobile-api.lambdatest.com (proxy or firewall).'],
      };
    }
  }

  async listDevices(query: DeviceQuery): Promise<DeviceListResult> {
    const region = (REGIONS as readonly string[]).includes(process.env.LAMBDATEST_REGION ?? '')
      ? process.env.LAMBDATEST_REGION
      : 'us';
    const raw = await requestJson<unknown>({
      url: `${MOBILE_API}/mobile-automation/api/v1/list?region=${region}`,
      auth: this.creds(),
    });
    return mapLambdaTestDevices(raw, query);
  }

  buildSession(request: SessionRequest): BuiltSession {
    const auth = this.creds();
    assertNoCredentialCaps(request.extraCapabilities);
    if (request.app && !/^lt:\/\/[A-Za-z0-9_]+$/.test(request.app)) {
      throw new ProviderError('app must be an lt:// reference (use appium_provider_upload_app to get one)', 'invalid');
    }
    if (request.tunnel?.enabled && !request.tunnel.name) {
      throw new ProviderError(
        'tunnel.name is required: this server never starts or guesses a shared tunnel',
        'invalid',
      );
    }
    // Credentials are inserted by the connect layer as WebDriver client user/key, not as capabilities.
    const caps: Record<string, unknown> = {
      platformName: request.platform === 'ios' ? 'iOS' : 'Android',
      ...(request.device?.name ? {deviceName: request.device.name} : {}),
      ...(request.device?.osVersion ? {platformVersion: request.device.osVersion} : {}),
      isRealMobile: true,
      ...(request.app ? {app: request.app} : {}),
      ...(request.build ? {build: request.build} : {}),
      ...(request.name ? {name: request.name} : {}),
      ...(request.tunnel?.enabled ? {tunnel: true, tunnelName: request.tunnel.name} : {}),
      ...request.extraCapabilities,
    };
    return {hubUrl: HUB, auth, capabilities: caps};
  }

  async uploadApp(path: string): Promise<UploadResult> {
    const bytes = await readFile(path);
    const name = basename(path);
    const form = new FormData();
    form.append('appFile', new Blob([bytes]), name);
    form.append('name', name);
    const res = await requestJson<Record<string, unknown>>({
      method: 'POST',
      url: `${MANUAL_API}/app/upload/realDevice`,
      auth: this.creds(),
      form,
      timeoutMs: 600_000,
    });
    // The docs show the value as "lt://APP..." but do not name the JSON key; accept the first lt:// string.
    const ref = Object.values(res ?? {}).find((v): v is string => typeof v === 'string' && v.startsWith('lt://'));
    if (!ref) {
      throw new ProviderError('upload response did not contain an lt:// reference', 'http');
    }
    return {appRef: ref, detail: name};
  }
}

/** Pure mapping. Field names are read defensively because the list response shape was not shown in the docs. */
export function mapLambdaTestDevices(raw: unknown, query: DeviceQuery): DeviceListResult {
  const root = raw as {platforms?: Record<string, unknown>} | unknown[] | undefined;
  const flat: Record<string, unknown>[] = [];
  const collect = (v: unknown, os?: string): void => {
    if (Array.isArray(v)) {
      for (const x of v) {
        collect(x, os);
      }
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if ('deviceName' in o || 'name' in o) {
        flat.push({...o, __os: os});
      } else {
        for (const [k, c] of Object.entries(o)) {
          collect(c, /android/i.test(k) ? 'android' : /ios/i.test(k) ? 'ios' : os);
        }
      }
    }
  };
  collect(root);
  let out: DeviceInfo[] = flat.map((d) => {
    const platformStr = String(d.platform ?? d.os ?? d.__os ?? '').toLowerCase();
    const platform = platformStr.includes('ios') ? ('ios' as const) : ('android' as const);
    const name = String(d.deviceName ?? d.name ?? '');
    return {
      provider: 'lambdatest' as const,
      platform,
      id: name,
      name,
      osVersion: d.platformVersion ? String(d.platformVersion) : d.version ? String(d.version) : undefined,
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
    out = out.filter((d) => d.osVersion?.startsWith(query.osVersion as string));
  }
  const limit = query.limit ?? 25;
  return {
    devices: out.slice(0, limit),
    truncated: out.length > limit,
    total: out.length,
    note: 'LambdaTest does not report per-device availability in this list.',
  };
}
