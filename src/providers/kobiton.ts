import {assertNoCredentialCaps, cloudStatus, readCreds} from './config.js';
import type {
  BuiltSession,
  CheckResult,
  DeviceListResult,
  DeviceProvider,
  DeviceQuery,
  ProviderStatus,
  SessionRequest,
} from './types.js';
import {ProviderError} from './types.js';

/**
 * Kobiton. PARTIALLY verified: docs.kobiton.com documents the `kobiton:` capability prefix, the
 * `appium:username` / `appium:accessKey` capabilities, `kobiton-store:<id>` app references and device
 * selection by `deviceName`. The hub URL, an app-upload endpoint, a device-list API and a session
 * status API were NOT confirmed on a fetched page, so:
 *   - the hub URL must be supplied by the operator in KOBITON_HUB_URL (no default is guessed),
 *   - no REST calls (device list, upload, status) are made.
 * Not live-verified: no Kobiton credentials were available.
 */
function hubFromEnv(): string | undefined {
  const raw = process.env.KOBITON_HUB_URL?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) {
      return undefined;
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export class KobitonProvider implements DeviceProvider {
  readonly id = 'kobiton' as const;
  readonly label = 'Kobiton (partial: operator-supplied hub URL, no REST calls)';
  readonly kind = 'cloud' as const;

  status(): ProviderStatus {
    const base = cloudStatus('kobiton', hubFromEnv());
    if (!hubFromEnv()) {
      return {
        ...base,
        configured: false,
        missing: [
          ...base.missing,
          'KOBITON_HUB_URL (https URL without credentials; see Kobiton docs for your account)',
        ],
      };
    }
    return base;
  }

  async check(): Promise<CheckResult> {
    const st = this.status();
    if (!st.configured) {
      return {
        ok: false,
        findings: [`missing: ${st.missing.join(', ')}`],
        nextSteps: ['Set the variables above. This server does not guess the Kobiton hub URL.'],
      };
    }
    return {
      ok: true,
      findings: [
        'configuration present',
        'credentials NOT validated: no verified Kobiton REST endpoint to check them against',
      ],
      nextSteps: ['Create a session; a rejected key will fail there.'],
    };
  }

  async listDevices(_query: DeviceQuery): Promise<DeviceListResult> {
    return {
      devices: [],
      truncated: false,
      total: 0,
      note: 'Kobiton device listing is not implemented (no verified API). Pass deviceName (wildcards allowed per Kobiton docs) to appium_provider_session.',
    };
  }

  buildSession(request: SessionRequest): BuiltSession {
    const auth = this.creds();
    assertNoCredentialCaps(request.extraCapabilities);
    const hub = hubFromEnv();
    if (!hub) {
      throw new ProviderError('KOBITON_HUB_URL is not set or is not a plain https URL', 'not-configured');
    }
    if (request.app && !/^(kobiton-store:[A-Za-z0-9_-]+|https:\/\/\S+)$/.test(request.app)) {
      throw new ProviderError('app must be kobiton-store:<id> or an https URL', 'invalid');
    }
    if (request.tunnel?.enabled) {
      throw new ProviderError(
        'Kobiton tunnel settings are not verified in this server; configure the tunnel outside it',
        'unsupported',
      );
    }
    const caps: Record<string, unknown> = {
      platformName: request.platform === 'ios' ? 'iOS' : 'Android',
      ...(request.device?.name ? {'appium:deviceName': request.device.name} : {}),
      ...(request.device?.osVersion ? {'appium:platformVersion': request.device.osVersion} : {}),
      ...(request.app ? {'appium:app': request.app} : {}),
      ...(request.name ? {'kobiton:sessionName': request.name} : {}),
      ...request.extraCapabilities,
      // Per docs.kobiton.com available-capabilities; carried only on the session request.
      'appium:username': auth.user,
      'appium:accessKey': auth.key,
    };
    return {hubUrl: hub, capabilities: caps};
  }

  private creds() {
    const c = readCreds('kobiton');
    if (!c) {
      throw new ProviderError('Kobiton is not configured: set KOBITON_USERNAME and KOBITON_API_KEY', 'not-configured');
    }
    return c;
  }
}
