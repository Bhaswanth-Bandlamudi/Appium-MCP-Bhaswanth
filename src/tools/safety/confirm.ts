import {randomBytes} from 'node:crypto';

import type {ContentResult} from 'fastmcp';

import {errorResult} from '../tool-response.js';
import {trustedModeCovers} from './policy.js';
import type {DestructiveOp} from './policy.js';

const TTL_MS = 120_000;
const MAX_PENDING = 50;

interface Pending {
  scope: string;
  expires: number;
}

const pending = new Map<string, Pending>();

function prune(now: number): void {
  for (const [k, v] of pending) {
    if (v.expires <= now) {
      pending.delete(k);
    }
  }
  while (pending.size > MAX_PENDING) {
    pending.delete(pending.keys().next().value as string);
  }
}

/**
 * Two-step guard for destructive operations. Enabled by default.
 *
 * First call (no token): nothing is changed; the result states what would be destroyed and carries a
 * single-use token bound to this operation, target and session. The call proceeds only when repeated
 * with that token within two minutes. A token for one target cannot authorise another.
 *
 * Trusted automation mode (see policy.ts) skips the round trip only for operations and app ids that
 * were listed explicitly in the environment.
 *
 * Returns undefined when the action may proceed.
 */
export function requireConfirmation(
  op: DestructiveOp,
  target: string,
  sessionId: string | undefined,
  consequence: string,
  confirmToken: string | undefined,
  now = Date.now(),
): ContentResult | undefined {
  if (trustedModeCovers(op, target)) {
    return undefined;
  }
  prune(now);
  const scope = `${op}|${target}|${sessionId ?? 'active'}`;
  if (confirmToken) {
    const p = pending.get(confirmToken);
    if (p && p.scope === scope && p.expires > now) {
      pending.delete(confirmToken);
      return undefined;
    }
    return errorResult(
      `confirmToken is invalid, expired, already used, or issued for a different operation or target. Call ${op} again without a token to get a new one.`,
    );
  }
  const token = randomBytes(6).toString('hex');
  pending.set(token, {scope, expires: now + TTL_MS});
  return errorResult(
    `CONFIRMATION REQUIRED (destructive): ${op} on "${target}". ${consequence} ` +
      `Nothing was changed. If the user has approved this, repeat the same call with confirmToken="${token}" (valid 2 minutes, single use).`,
  );
}

const truthy = (v: unknown): boolean =>
  v === true || (typeof v === 'string' && ['true', '1', 'yes'].includes(v.trim().toLowerCase()));

/**
 * `fullReset` uninstalls the app and wipes its data when a session starts, so it is destructive even though
 * it is only a capability. Checks the vendor-prefixed, bare and `appium:options` forms, and string booleans.
 */
export function capabilitiesRequestFullReset(caps: Record<string, unknown> | undefined): boolean {
  if (!caps) {
    return false;
  }
  const opts = (caps['appium:options'] ?? {}) as Record<string, unknown>;
  return [caps['appium:fullReset'], caps.fullReset, opts.fullReset].some(truthy);
}

/** The app a capability set targets, used as the confirmation and trusted-mode target. */
export function capabilityAppTarget(caps: Record<string, unknown> | undefined): string {
  const opts = (caps?.['appium:options'] ?? {}) as Record<string, unknown>;
  const pick = (k: string): unknown => caps?.[`appium:${k}`] ?? caps?.[k] ?? opts[k];
  const v = pick('appPackage') ?? pick('bundleId') ?? pick('app');
  return typeof v === 'string' && v ? v : 'unspecified-app';
}

/** Test helper. */
export function _resetPending(): void {
  pending.clear();
}
