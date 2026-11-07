import WebDriver from 'webdriver';

import log from '../logger.js';
import {setSession} from '../session-store.js';
import {getPortFromUrl, validateRemoteServerUrl} from '../utils/url.js';
import {withQuietWebDriverLogging} from '../utils/webdriver-client-options.js';
import {scrubSecrets} from './http.js';
import {rememberSession} from './registry.js';
import type {BuiltSession, DeviceProvider} from './types.js';

const SECRET_KEY = /^(username|accesskey|access_key|userName|key|secret|password|apikey|api_key|token)$/i;

/**
 * Copy of the capabilities that is safe to store, list, log or persist: every credential-looking key,
 * at any depth and with or without a vendor prefix, is replaced. The original is used only for the
 * session-creation request.
 */
export function scrubCapabilities(caps: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          SECRET_KEY.test(k.split(':').pop() ?? k) ? '[REDACTED]' : walk(x),
        ]),
      );
    }
    return v;
  };
  return walk(caps) as Record<string, unknown>;
}

export interface ConnectedSession {
  sessionId: string;
  provider: string;
  platform: string;
  hub: string;
}

/**
 * Creates a session on a cloud hub. Credentials are given to the WebDriver client only for this request
 * (via `user`/`key` or inside the capability block the provider built) and are never passed to setSession.
 * Existing sessions are not touched; the new session simply becomes active.
 */
export async function connectCloudSession(provider: DeviceProvider, built: BuiltSession): Promise<ConnectedSession> {
  validateRemoteServerUrl(built.hubUrl, process.env.REMOTE_SERVER_URL_ALLOW_REGEX);
  const url = new URL(built.hubUrl);
  const secrets = [built.auth?.key, built.auth?.user, ...collectSecrets(built.capabilities)];
  let client;
  try {
    client = await WebDriver.newSession(
      withQuietWebDriverLogging({
        protocol: url.protocol.replace(':', ''),
        hostname: url.hostname,
        port: getPortFromUrl(url),
        path: url.pathname,
        ...(built.auth ? {user: built.auth.user, key: built.auth.key} : {}),
        capabilities: built.capabilities,
        // A cloud hub is not a place to follow driver-supplied direct-connect hosts.
        enableDirectConnect: false,
      }),
    );
  } catch (err) {
    log.warn(`cloud session creation failed for ${provider.id}`);
    // No `cause`: the original error can carry the request and its credentials.
    // oxlint-disable-next-line preserve-caught-error
    throw new Error(scrubSecrets((err as Error)?.message ?? String(err), secrets));
  }
  const platform = String(built.capabilities.platformName ?? '');
  // Stored metadata and the persisted-session file get the scrubbed copy only.
  await setSession(
    client,
    client.sessionId,
    scrubCapabilities(built.capabilities),
    'owned',
    stripUserinfo(built.hubUrl),
  );
  rememberSession(client.sessionId, provider.id);
  return {sessionId: client.sessionId, provider: provider.id, platform, hub: stripUserinfo(built.hubUrl)};
}

function stripUserinfo(u: string): string {
  const x = new URL(u);
  x.username = '';
  x.password = '';
  return x.toString().replace(/\/$/, '');
}

function collectSecrets(caps: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY.test(k.split(':').pop() ?? k) && typeof x === 'string') {
          out.push(x);
        } else {
          walk(x);
        }
      }
    }
  };
  walk(caps);
  return out;
}
