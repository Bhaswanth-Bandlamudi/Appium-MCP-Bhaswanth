import type {ContentResult, FastMCP} from 'fastmcp';
import {z} from 'zod';

import {getSessionId, getSessionInfo, listSessions} from '../session-store.js';
import {requireConfirmation} from '../tools/safety/confirm.js';
import {errorResult, textResult, toolErrorMessage} from '../tools/tool-response.js';
import {readCreds} from './config.js';
import {connectCloudSession} from './connect.js';
import {scrubSecrets} from './http.js';
import {getProvider, listProviders, PROVIDER_IDS, providerOfSession} from './registry.js';
import type {DeviceInfo, DeviceProvider, ProviderId} from './types.js';
import {ProviderError} from './types.js';

const providerField = z.enum(PROVIDER_IDS).describe('Provider id from appium_provider_list.');
const json = (v: unknown): ContentResult => textResult(JSON.stringify(v));

function secretsFor(p: DeviceProvider): string[] {
  if (p.kind !== 'cloud') {
    return [];
  }
  const c = readCreds(p.id as Exclude<ProviderId, 'local-android' | 'local-ios'>);
  return c ? [c.user, c.key] : [];
}

function fail(p: DeviceProvider | undefined, err: unknown): ContentResult {
  const secrets = p ? secretsFor(p) : [];
  if (err instanceof ProviderError) {
    return errorResult(JSON.stringify({error: err.code, message: scrubSecrets(err.message, secrets)}));
  }
  return errorResult(scrubSecrets(toolErrorMessage(err), secrets));
}

const compactDevice = (d: DeviceInfo) =>
  [d.provider, d.platform, d.id, d.name !== d.id ? d.name : '', d.osVersion ?? '', d.kind, d.status, d.note ?? ''].join(
    '|',
  );

export default function providerTools(server: FastMCP): void {
  // ---- appium_provider_list ---------------------------------------------
  server.addTool({
    name: 'appium_provider_list',
    description:
      'List device providers (local Android, local iOS, LambdaTest, BrowserStack, Sauce Labs, Kobiton) with whether each is configured, which environment variables are missing (names only), and whether this host can run it. Never returns credentials. Call first to choose where to run.',
    parameters: z.object({}),
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (): Promise<ContentResult> => json({providers: listProviders().map((p) => p.status())}),
  });

  // ---- appium_provider_devices ------------------------------------------
  const devSchema = z.object({
    provider: providerField,
    platform: z.enum(['android', 'ios']).optional(),
    name: z.string().max(60).optional().describe('Case-insensitive substring of device name.'),
    osVersion: z.string().max(20).optional().describe('OS version prefix, e.g. 14 or 17.2.'),
    limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
    verbosity: z
      .enum(['minimal', 'standard'])
      .optional()
      .describe('minimal: one pipe-separated line per device (provider|platform|id|name|os|kind|status|note).'),
  });
  server.addTool({
    name: 'appium_provider_devices',
    description:
      'Discover devices on one provider: adb devices and defined AVDs (including offline/unauthorized, with fixes), iOS simulators (macOS), or the cloud catalogue. Cloud lists can be long; filter with platform/name/osVersion. Availability is reported only where the provider exposes it.',
    parameters: devSchema,
    annotations: {readOnlyHint: true, openWorldHint: true},
    execute: async (args: z.infer<typeof devSchema>): Promise<ContentResult> => {
      const p = getProvider(args.provider);
      if (!p) {
        return errorResult(`Unknown provider '${args.provider}'.`);
      }
      const st = p.status();
      if (!st.supported) {
        return errorResult(JSON.stringify({error: 'unsupported', message: st.unsupportedReason}));
      }
      if (p.kind === 'cloud' && !st.configured) {
        return errorResult(JSON.stringify({error: 'not-configured', missing: st.missing}));
      }
      try {
        const r = await p.listDevices(args);
        if (args.verbosity === 'minimal') {
          return textResult(
            [
              `${r.devices.length}/${r.total}${r.truncated ? ' (truncated)' : ''}`,
              ...r.devices.map(compactDevice),
              ...(r.note ? [`note: ${r.note}`] : []),
            ].join('\n'),
          );
        }
        return json(r);
      } catch (err) {
        return fail(p, err);
      }
    },
  });

  // ---- appium_provider_check --------------------------------------------
  const checkSchema = z.object({provider: providerField});
  server.addTool({
    name: 'appium_provider_check',
    description:
      'Diagnose connectivity for one provider: local adb/xcrun presence and device states with fixes, or for a cloud provider whether the credentials are accepted (a harmless authenticated GET). Returns findings and next steps. Never prints credentials.',
    parameters: checkSchema,
    annotations: {readOnlyHint: true, openWorldHint: true},
    execute: async (args: z.infer<typeof checkSchema>): Promise<ContentResult> => {
      const p = getProvider(args.provider);
      if (!p) {
        return errorResult(`Unknown provider '${args.provider}'.`);
      }
      try {
        return json({provider: p.id, ...(await p.check())});
      } catch (err) {
        return fail(p, err);
      }
    },
  });

  // ---- appium_provider_upload_app ---------------------------------------
  const upSchema = z.object({
    provider: z
      .enum(['lambdatest', 'browserstack', 'saucelabs'])
      .describe('Providers with a verified upload endpoint.'),
    path: z.string().min(1).max(500).describe('Local .apk/.aab/.ipa path on the machine running this MCP server.'),
    confirmToken: z.string().optional(),
  });
  server.addTool({
    name: 'appium_provider_upload_app',
    description:
      'Upload a local app file to a cloud provider and return the provider reference to use as `app` (lt://..., bs://..., storage:filename=...). Sends the file contents to a third party, so the first call returns a confirmation token. Only .apk, .aab, .xapk and .ipa files are accepted.',
    parameters: upSchema,
    annotations: {readOnlyHint: false, openWorldHint: true},
    execute: async (args: z.infer<typeof upSchema>): Promise<ContentResult> => {
      const p = getProvider(args.provider);
      if (!p?.uploadApp) {
        return errorResult(`Provider '${args.provider}' has no verified upload API in this server.`);
      }
      if (!/\.(apk|aab|xapk|ipa)$/i.test(args.path)) {
        return errorResult('Only .apk, .aab, .xapk and .ipa files can be uploaded.');
      }
      const st = p.status();
      if (!st.configured) {
        return errorResult(JSON.stringify({error: 'not-configured', missing: st.missing}));
      }
      const blocked = requireConfirmation(
        'provider.upload',
        `${args.provider}:${args.path}`,
        undefined,
        `This uploads the file to ${p.label} (a third party).`,
        args.confirmToken,
      );
      if (blocked) {
        return blocked;
      }
      try {
        return json(await p.uploadApp(args.path));
      } catch (err) {
        return fail(p, err);
      }
    },
  });

  // ---- appium_provider_session ------------------------------------------
  const sessSchema = z.object({
    provider: z
      .enum(['lambdatest', 'browserstack', 'saucelabs', 'kobiton'])
      .describe('Cloud provider. Local sessions use select_device + appium_session_management.'),
    platform: z.enum(['android', 'ios']),
    deviceName: z.string().max(80).optional(),
    osVersion: z.string().max(20).optional(),
    app: z
      .string()
      .max(300)
      .optional()
      .describe('Provider app reference (lt://, bs://, storage:filename=, kobiton-store:) or https URL.'),
    build: z.string().max(80).optional(),
    name: z.string().max(120).optional().describe('Session name shown in the provider dashboard.'),
    tunnelName: z
      .string()
      .max(80)
      .optional()
      .describe('Existing tunnel to use. This server never starts, stops or guesses a tunnel.'),
    extraCapabilities: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Merged last. Credentials are rejected here.'),
  });
  server.addTool({
    name: 'appium_provider_session',
    description:
      'Create a session on a cloud provider using environment credentials and make it active, so all appium_* tools then act on it. Existing sessions are not closed. Returns session id, provider and hub (no credentials). End it with appium_session_management action=delete, or appium_provider_finish to also record pass/fail where supported.',
    parameters: sessSchema,
    annotations: {readOnlyHint: false, openWorldHint: true},
    execute: async (args: z.infer<typeof sessSchema>): Promise<ContentResult> => {
      const p = getProvider(args.provider);
      if (!p?.buildSession) {
        return errorResult(`Provider '${args.provider}' cannot create sessions.`);
      }
      const st = p.status();
      if (!st.configured) {
        return errorResult(JSON.stringify({error: 'not-configured', missing: st.missing}));
      }
      try {
        const built = p.buildSession({
          platform: args.platform,
          device: {name: args.deviceName, osVersion: args.osVersion},
          app: args.app,
          build: args.build,
          name: args.name,
          tunnel: args.tunnelName ? {enabled: true, name: args.tunnelName} : undefined,
          extraCapabilities: args.extraCapabilities,
        });
        const s = await connectCloudSession(p, built);
        return json({...s, active: true, openSessions: listSessions().length});
      } catch (err) {
        return fail(p, err);
      }
    },
  });

  // ---- appium_session_overview ------------------------------------------
  server.addTool({
    name: 'appium_session_overview',
    description:
      'List every open session with its provider (local or cloud), platform, device, ownership and which one is ACTIVE. Tools that omit sessionId act on the active session, and creating a cloud session makes it active, so check this before acting when more than one session is open. Never returns credentials or hub URLs with userinfo.',
    parameters: z.object({}),
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (): Promise<ContentResult> => {
      const active = getSessionId();
      const rows = listSessions().map((s) => ({
        sessionId: s.sessionId,
        active: s.sessionId === active,
        provider: providerOfSession(s.sessionId) ?? (s.ownership === 'attached' ? 'attached' : 'local'),
        platform: s.platform,
        device: s.deviceName,
        ownership: s.ownership,
        context: s.currentContext,
      }));
      return json({
        count: rows.length,
        activeSessionId: active,
        sessions: rows,
        hint: rows.length > 1 ? 'pass sessionId explicitly to avoid acting on the wrong session' : undefined,
      });
    },
  });

  // ---- appium_provider_finish -------------------------------------------
  const finSchema = z.object({
    sessionId: z.string().optional().describe('Defaults to the active session.'),
    passed: z
      .boolean()
      .optional()
      .describe('Record pass/fail on the provider where an API is verified (BrowserStack, Sauce Labs).'),
    reason: z.string().max(250).optional(),
  });
  server.addTool({
    name: 'appium_provider_finish',
    description:
      'Show provider-side details for a cloud session and optionally record pass/fail (BrowserStack and Sauce Labs only; LambdaTest and Kobiton have no verified status API here). Acts only through the provider that created the session. Does not delete the session.',
    parameters: finSchema,
    annotations: {readOnlyHint: false, openWorldHint: true},
    execute: async (args: z.infer<typeof finSchema>): Promise<ContentResult> => {
      const info = getSessionInfo(args.sessionId);
      if (!info) {
        return errorResult('No such session.');
      }
      const owner = providerOfSession(info.sessionId);
      const p = owner ? getProvider(owner) : undefined;
      if (!p) {
        return errorResult(
          `Session ${info.sessionId} was not created by a cloud provider through appium_provider_session.`,
        );
      }
      const out: Record<string, unknown> = {provider: p.id, sessionId: info.sessionId};
      try {
        if (args.passed !== undefined) {
          if (!p.setSessionStatus) {
            out.status = 'not recorded: no verified status API for this provider';
          } else {
            await p.setSessionStatus(info.sessionId, args.passed, args.reason);
            out.status = args.passed ? 'passed recorded' : 'failed recorded';
          }
        }
        if (p.sessionDetails) {
          out.details = await p.sessionDetails(info.sessionId);
        }
        return json(out);
      } catch (err) {
        return fail(p, err);
      }
    },
  });
}
