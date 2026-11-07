import {ProviderError} from './types.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Test seam: replace the network layer. Returns a function that restores the real one. */
export function setFetchForTests(f: FetchLike): () => void {
  const prev = fetchImpl;
  fetchImpl = f;
  return () => {
    fetchImpl = prev;
  };
}

export function basicAuthHeader(user: string, key: string): string {
  return `Basic ${Buffer.from(`${user}:${key}`, 'utf8').toString('base64')}`;
}

/** Remove any secret value, the base64 of user:key, and URL userinfo from text bound for logs or tool output. */
export function scrubSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@');
  for (const s of secrets) {
    if (s && s.length >= 4) {
      out = out.split(s).join('[REDACTED]');
    }
  }
  return out;
}

export interface JsonRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  auth?: {user: string; key: string};
  body?: unknown;
  form?: FormData;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 2_000_000;

/**
 * One HTTP helper for every provider: timeout, basic auth, no redirects to other hosts carrying
 * the Authorization header (fetch drops it on cross-origin redirects), bounded body, scrubbed errors.
 */
export async function requestJson<T = unknown>(req: JsonRequest): Promise<T> {
  const secrets = [req.auth?.key, req.auth?.user];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {Accept: 'application/json', ...req.headers};
  if (req.auth) {
    headers.Authorization = basicAuthHeader(req.auth.user, req.auth.key);
  }
  let body: BodyInit | undefined;
  if (req.form) {
    body = req.form;
  } else if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body);
  }
  let res: Response;
  try {
    res = await fetchImpl(req.url, {method: req.method ?? 'GET', headers, body, signal: controller.signal});
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError';
    throw new ProviderError(
      scrubSecrets(
        aborted
          ? `request timed out after ${req.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : `network error: ${(err as Error)?.message ?? err}`,
        secrets,
      ),
      'network',
    );
  } finally {
    clearTimeout(timer);
  }
  const text = (await res.text()).slice(0, MAX_BODY_CHARS);
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(`authentication rejected (HTTP ${res.status}); check the username and access key`, 'auth');
  }
  if (res.status === 404) {
    throw new ProviderError('not found (HTTP 404)', 'not-found');
  }
  if (!res.ok) {
    throw new ProviderError(`HTTP ${res.status}: ${scrubSecrets(text, secrets).slice(0, 300)}`, 'http');
  }
  if (!text) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(`response was not JSON: ${scrubSecrets(text, secrets).slice(0, 120)}`, 'http');
  }
}
