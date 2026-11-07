import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

import type {ContentResult, FastMCP} from 'fastmcp';
import {z} from 'zod';

import {execute} from '../../command.js';
import {getPlatformName, getSessionInfo, PLATFORM} from '../../session-store.js';
import {errorResult, resolveDriver, textResult, toolErrorMessage} from '../tool-response.js';
import {recoverSession} from './recover-session.js';
import {recordings, recKey, stepSchema, toJava} from './steps.js';

const sessionIdField = z.string().optional().describe('Session ID; defaults to the active session.');
const json = (v: unknown): ContentResult => textResult(JSON.stringify(v));

// ───────────────────────── workflow recording ─────────────────────────

const NAME = /^[A-Za-z0-9_-]{1,60}$/;
const workflowDir = () => resolve(process.env.APPIUM_MCP_WORKFLOWS_DIR ?? join(tmpdir(), 'appium-mcp-workflows'));

export default function opsTools(server: FastMCP): void {
  // ---- appium_session_health -------------------------------------------
  const healthSchema = z.object({
    recover: z
      .boolean()
      .optional()
      .describe(
        'If the session is dead, delete it and create a new one with the same platform and capabilities. Default false (report only).',
      ),
    appId: z
      .string()
      .max(200)
      .optional()
      .describe('App to check and restore (defaults to the session capability appPackage/bundleId).'),
    detail: z.boolean().optional().describe('Return the full report even when healthy.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_session_health',
    description:
      'Diagnose a session: device state (adb), Appium server (remote), session liveness, app state and foreground, ANR dialog. Returns the failure kind with signals and whether replacing the session would help. With recover=true and only for a recoverable failure (dead session or driver), replaces the session once, bounded to 2 attempts per 10 minutes, never touches other sessions, never resets app data, relaunches the app and verifies the new session. Cloud and attached sessions are not replaced.',
    parameters: healthSchema,
    annotations: {readOnlyHint: false, openWorldHint: false},
    execute: async (args: z.infer<typeof healthSchema>): Promise<ContentResult> => {
      const info = getSessionInfo(args.sessionId);
      if (!info) {
        return resolveDriver(args.sessionId).then((r) => (r.ok ? errorResult('No such session.') : r.result));
      }
      try {
        const rep = await recoverSession({
          sessionId: info.sessionId,
          recover: args.recover === true,
          appId: args.appId,
        });
        const quick = rep.failure.kind === 'healthy';
        if (quick && !args.detail) {
          return json({alive: true, kind: 'healthy'});
        }
        return json(rep);
      } catch (err) {
        return errorResult(`session health check failed: ${toolErrorMessage(err)}`);
      }
    },
  });

  // ---- appium_workflow --------------------------------------------------
  const wfSchema = z.object({
    action: z
      .enum(['start', 'stop', 'list', 'show', 'replay', 'export_java'])
      .describe(
        'start: begin recording steps run through appium_batch. stop: save as name. list/show: saved workflows. replay: run a saved workflow. export_java: render as Java for your own framework (nothing is executed or written outside the workflows folder).',
      ),
    name: z.string().regex(NAME).optional().describe('Workflow name (letters, digits, - and _).'),
    stopOnError: z.boolean().optional().describe('Replay only; default true.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_workflow',
    description:
      'Record appium_batch steps into a named workflow, replay it later in one call, or export it as Java. Typed text for password/secret/otp fields is replaced by ${SECRET} in recordings. Replay uses the same step vocabulary as appium_batch only.',
    parameters: wfSchema,
    annotations: {readOnlyHint: false, openWorldHint: false},
    execute: async (args: z.infer<typeof wfSchema>): Promise<ContentResult> => {
      const dir = workflowDir();
      const file = (n: string) => join(dir, `${n}.json`);
      try {
        if (args.action === 'start') {
          recordings.set(recKey(args.sessionId), []);
          return textResult(
            'Recording. Steps run through appium_batch are captured; call action=stop with a name to save.',
          );
        }
        if (args.action === 'stop') {
          if (!args.name) {
            return errorResult('name is required');
          }
          const steps = recordings.get(recKey(args.sessionId));
          if (!steps) {
            return errorResult('Not recording. Call action=start first.');
          }
          await mkdir(dir, {recursive: true});
          await writeFile(file(args.name), JSON.stringify({name: args.name, steps}, null, 1), {
            encoding: 'utf8',
            mode: 0o600,
          });
          recordings.delete(recKey(args.sessionId));
          return json({saved: args.name, steps: steps.length, dir});
        }
        if (args.action === 'list') {
          const {readdir} = await import('node:fs/promises');
          const names = (await readdir(dir).catch(() => [] as string[]))
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5));
          return json({workflows: names, dir});
        }
        if (!args.name) {
          return errorResult('name is required');
        }
        const parsed = JSON.parse(await readFile(file(args.name), 'utf8')) as {steps: unknown};
        const steps = z.array(stepSchema).parse(parsed.steps);
        if (args.action === 'show') {
          return json({name: args.name, steps});
        }
        if (args.action === 'export_java') {
          return textResult(toJava(args.name, steps));
        }
        // replay
        const r = await resolveDriver(args.sessionId);
        if (!r.ok) {
          return r.result;
        }
        const {runSteps} = await import('../efficient/efficient-tools.js');
        const out = await runSteps(r.driver, steps, args.stopOnError ?? true);
        return out.failed ? {...textResult(out.lines.join('\n')), isError: true} : textResult(out.lines.join('\n'));
      } catch (err) {
        return errorResult(`workflow ${args.action} failed: ${toolErrorMessage(err)}`);
      }
    },
  });

  // ---- appium_network_check --------------------------------------------
  const netSchema = z.object({
    host: z
      .string()
      .regex(/^[A-Za-z0-9.-]{1,253}$/)
      .optional()
      .describe('Optional hostname to resolve from the device (e.g. your API host). No URL, no path.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_network_check',
    description:
      'Android: report device connectivity (airplane mode, Wi-Fi/mobile data state, active network, proxy, private DNS) and optionally whether a host resolves from the device, with a plain-language verdict. Read-only. iOS is not supported. Does not inspect traffic or bypass pinning.',
    parameters: netSchema,
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (args: z.infer<typeof netSchema>): Promise<ContentResult> => {
      const r = await resolveDriver(args.sessionId);
      if (!r.ok) {
        return r.result;
      }
      if (getPlatformName(r.driver) === PLATFORM.ios) {
        return errorResult('appium_network_check supports Android only.');
      }
      try {
        const info = (await execute(r.driver, 'mobile: getConnectivity', {
          services: ['wifi', 'data', 'airplaneMode'],
        }).catch(() => undefined)) as {wifi?: boolean; data?: boolean; airplaneMode?: boolean} | undefined;
        const verdict: string[] = [];
        if (info) {
          if (info.airplaneMode) {
            verdict.push('airplane mode is ON: no network at all');
          } else if (!info.wifi && !info.data) {
            verdict.push('Wi-Fi and mobile data are both off');
          } else {
            verdict.push(`connectivity: wifi=${!!info.wifi} data=${!!info.data}`);
          }
        } else {
          verdict.push('connectivity services not readable in this session');
        }
        let resolves: boolean | undefined;
        if (args.host) {
          try {
            const out = String(
              await execute(r.driver, 'mobile: shell', {command: 'ping', args: ['-c', '1', '-W', '3', args.host]}),
            );
            resolves = /1 received|bytes from/.test(out);
            if (!resolves && /unknown host|Unreachable|unreachable/i.test(out)) {
              verdict.push(`device cannot reach ${args.host}`);
            }
          } catch (err) {
            verdict.push(
              `host check unavailable (mobile: shell needs the adb_shell server feature): ${toolErrorMessage(err).slice(0, 80)}`,
            );
          }
        }
        return json({...info, ...(resolves === undefined ? {} : {hostReachable: resolves}), verdict});
      } catch (err) {
        return errorResult(toolErrorMessage(err));
      }
    },
  });
}
