import type {ProviderId, ProviderStatus} from './types.js';

export interface Creds {
  user: string;
  key: string;
}

export interface CloudEnv {
  id: Exclude<ProviderId, 'local-android' | 'local-ios'>;
  label: string;
  userVar: string;
  keyVar: string;
}

export const CLOUD_ENV: Record<CloudEnv['id'], CloudEnv> = {
  lambdatest: {
    id: 'lambdatest',
    label: 'LambdaTest App Automate',
    userVar: 'LAMBDATEST_USERNAME',
    keyVar: 'LAMBDATEST_ACCESS_KEY',
  },
  browserstack: {
    id: 'browserstack',
    label: 'BrowserStack App Automate',
    userVar: 'BROWSERSTACK_USERNAME',
    keyVar: 'BROWSERSTACK_ACCESS_KEY',
  },
  saucelabs: {id: 'saucelabs', label: 'Sauce Labs', userVar: 'SAUCE_USERNAME', keyVar: 'SAUCE_ACCESS_KEY'},
  kobiton: {id: 'kobiton', label: 'Kobiton', userVar: 'KOBITON_USERNAME', keyVar: 'KOBITON_API_KEY'},
};

/** Reads credentials from the environment only. Returns undefined unless both are non-empty. */
export function readCreds(id: CloudEnv['id'], env: NodeJS.ProcessEnv = process.env): Creds | undefined {
  const c = CLOUD_ENV[id];
  const user = env[c.userVar]?.trim();
  const key = env[c.keyVar]?.trim();
  return user && key ? {user, key} : undefined;
}

/** Names of the missing variables, never values. */
export function missingVars(id: CloudEnv['id'], env: NodeJS.ProcessEnv = process.env): string[] {
  const c = CLOUD_ENV[id];
  return [c.userVar, c.keyVar].filter((v) => !env[v]?.trim());
}

export function cloudStatus(
  id: CloudEnv['id'],
  endpoint: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProviderStatus {
  const missing = missingVars(id, env);
  return {
    id,
    label: CLOUD_ENV[id].label,
    kind: 'cloud',
    configured: missing.length === 0,
    missing,
    supported: true,
    endpoint,
  };
}

/** Region keys must come from a fixed list so an env value can never redirect credentials to another host. */
export function pickRegion<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = raw?.trim().toLowerCase();
  return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback;
}

/** Keys that must never be supplied through extraCapabilities, because they would carry or override credentials. */
const FORBIDDEN_CAP_KEYS = new Set([
  'username',
  'accesskey',
  'access_key',
  'key',
  'secret',
  'password',
  'apikey',
  'api_key',
  'token',
]);

export function assertNoCredentialCaps(caps: Record<string, unknown> | undefined): void {
  const walk = (o: unknown, path: string): void => {
    if (!o || typeof o !== 'object') {
      return;
    }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const bare = k.split(':').pop()?.toLowerCase() ?? k.toLowerCase();
      if (FORBIDDEN_CAP_KEYS.has(bare)) {
        throw new Error(
          `extraCapabilities must not contain credentials (${path}${k}). Set them through environment variables.`,
        );
      }
      walk(v, `${path}${k}.`);
    }
  };
  walk(caps, '');
}
