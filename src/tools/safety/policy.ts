import log from '../../logger.js';

export type RiskClass = 'read-only' | 'reversible' | 'destructive';

/**
 * Risk class of every operation that can change a device or session. The class is the contract:
 * destructive operations need confirmation unless trusted automation mode covers them.
 * Operations not listed are treated as 'reversible' only if they are explicitly listed as such,
 * so a new destructive operation must be added here to be reviewed.
 */
export const OPERATION_RISK = {
  'app.uninstall': 'destructive',
  'app.clear': 'destructive',
  'session.fullReset': 'destructive',
  'file.push': 'destructive',
  'provider.upload': 'destructive',
  'app.terminate': 'reversible',
  'app.install': 'reversible',
  'app.background': 'reversible',
  'app.activate': 'reversible',
  'permissions.update': 'reversible',
  'device.lock': 'reversible',
  'geolocation.set': 'reversible',
  'session.create': 'reversible',
  'session.delete': 'reversible',
  'app.list': 'read-only',
  'app.query': 'read-only',
  'file.pull': 'read-only',
  'permissions.get': 'read-only',
} as const satisfies Record<string, RiskClass>;

export type Operation = keyof typeof OPERATION_RISK;

export const riskOf = (op: Operation): RiskClass => OPERATION_RISK[op];

export type DestructiveOp = {[K in Operation]: (typeof OPERATION_RISK)[K] extends 'destructive' ? K : never}[Operation];

export interface TrustedMode {
  /** Operations that may skip the confirmation round-trip. */
  allowed: ReadonlySet<DestructiveOp>;
  /** Only these app ids (package or bundle ids) may be targeted. Required: an empty list allows nothing. */
  apps: readonly string[];
  /** Why it was enabled; logged on every use. */
  reason: string;
}

const DESTRUCTIVE_OPS = (Object.keys(OPERATION_RISK) as Operation[]).filter(
  (k) => OPERATION_RISK[k] === 'destructive',
) as DestructiveOp[];

export class TrustedModeConfigError extends Error {}

/**
 * Trusted automation mode, for controlled environments (a CI job on a throwaway emulator).
 * It is never on by default and needs ALL of:
 *   APPIUM_MCP_TRUSTED_MODE=on
 *   APPIUM_MCP_TRUSTED_OPS=<comma list of destructive operations>   (explicit; "all" is not accepted)
 *   APPIUM_MCP_TRUSTED_APPS=<comma list of app ids>                 (explicit; no wildcard)
 *   APPIUM_MCP_TRUSTED_REASON=<free text, 8+ chars>
 * Any mistake is a configuration error that leaves the mode OFF, never a looser mode.
 */
export function readTrustedMode(env: NodeJS.ProcessEnv = process.env): TrustedMode | undefined {
  const flag = env.APPIUM_MCP_TRUSTED_MODE?.trim().toLowerCase();
  const legacy = env.APPIUM_MCP_ALLOW_DESTRUCTIVE?.trim().toLowerCase();
  if (legacy === 'true' || legacy === '1') {
    throw new TrustedModeConfigError(
      'APPIUM_MCP_ALLOW_DESTRUCTIVE is no longer honoured because it disabled every safeguard at once. Use APPIUM_MCP_TRUSTED_MODE with explicit operations and apps (see TOOL_CATALOG.md).',
    );
  }
  if (!flag || flag === 'off' || flag === 'false' || flag === '0') {
    return undefined;
  }
  if (flag !== 'on') {
    throw new TrustedModeConfigError(`APPIUM_MCP_TRUSTED_MODE must be "on" or unset, got "${flag}".`);
  }
  const ops = (env.APPIUM_MCP_TRUSTED_OPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ops.length === 0) {
    throw new TrustedModeConfigError(`APPIUM_MCP_TRUSTED_OPS is required. Choose from: ${DESTRUCTIVE_OPS.join(', ')}.`);
  }
  const unknown = ops.filter((o) => !(DESTRUCTIVE_OPS as string[]).includes(o));
  if (unknown.length) {
    throw new TrustedModeConfigError(
      `APPIUM_MCP_TRUSTED_OPS has unknown or non-destructive operation(s): ${unknown.join(', ')}. Valid: ${DESTRUCTIVE_OPS.join(', ')}.`,
    );
  }
  const apps = (env.APPIUM_MCP_TRUSTED_APPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (apps.length === 0) {
    throw new TrustedModeConfigError(
      'APPIUM_MCP_TRUSTED_APPS is required (comma-separated app ids). Wildcards are not supported.',
    );
  }
  if (apps.some((a) => a === '*' || /[*?]/.test(a))) {
    throw new TrustedModeConfigError('APPIUM_MCP_TRUSTED_APPS must list exact app ids; wildcards are not supported.');
  }
  const reason = (env.APPIUM_MCP_TRUSTED_REASON ?? '').trim();
  if (reason.length < 8) {
    throw new TrustedModeConfigError(
      'APPIUM_MCP_TRUSTED_REASON is required (at least 8 characters) so the audit log says why.',
    );
  }
  return {allowed: new Set(ops as DestructiveOp[]), apps, reason};
}

let announced = false;

/**
 * True when trusted mode explicitly covers this operation on this target. A bad configuration is
 * logged once and treated as OFF: it can never widen what is allowed.
 */
export function trustedModeCovers(op: DestructiveOp, target: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let mode: TrustedMode | undefined;
  try {
    mode = readTrustedMode(env);
  } catch (err) {
    log.error(`Trusted automation mode ignored: ${(err as Error).message}`);
    return false;
  }
  if (!mode) {
    return false;
  }
  if (!announced) {
    announced = true;
    log.warn(
      `TRUSTED AUTOMATION MODE ACTIVE: ${[...mode.allowed].join(', ')} on [${mode.apps.join(', ')}]. Reason: ${mode.reason}`,
    );
  }
  const covered = mode.allowed.has(op) && mode.apps.includes(target);
  if (covered) {
    log.warn(`TRUSTED MODE bypassed confirmation: ${op} on ${target}`);
  }
  return covered;
}

/** Test helper. */
export function _resetAnnounced(): void {
  announced = false;
}

/** Text for startup logs and tool descriptions: what is guarded and how it is relaxed. Never a safeguard by itself. */
export function describePolicy(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const m = readTrustedMode(env);
    return m ? `trusted mode ON for ${[...m.allowed].join(', ')}` : 'confirmation required for destructive operations';
  } catch (err) {
    return `confirmation required (trusted mode configuration rejected: ${(err as Error).message})`;
  }
}
