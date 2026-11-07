import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import type {ContentResult, FastMCP} from 'fastmcp';
import {z} from 'zod';

import {
  activateApp,
  back,
  elementClick,
  execute,
  findElement,
  findElements,
  getPageSource,
  getScreenshot,
} from '../../command.js';
import type {DriverInstance} from '../../session-store.js';
import {getPlatformName, getSessionInfo, PLATFORM} from '../../session-store.js';
import {resolveScreenshotDir} from '../../utils/paths.js';
import {parseLocator} from '../efficient/compact-screen.js';
import {parseScreen} from '../intel/screen-model.js';
import {recoverSession} from '../ops/recover-session.js';
import {readWebElementId, resolveDriver, textResult, toolErrorMessage} from '../tool-response.js';
import {runExploration} from './engine.js';
import type {ExploreDevice} from './engine.js';
import {DEFAULT_DENY} from './explorer.js';

const schema = z.object({
  appId: z
    .string()
    .max(200)
    .describe('Package or bundle id. Exploration is confined to this app; leaving it is detected and undone.'),
  goal: z.string().max(200).describe('What you are exploring for. Recorded in the report only.'),
  maxSteps: z.number().int().min(1).max(60).optional().describe('Maximum taps (default 15).'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe('Maximum navigation depth from the start screen (default 3).'),
  maxScreens: z.number().int().min(1).max(40).optional().describe('Maximum distinct screens to record (default 15).'),
  maxScreenshots: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe('Screenshots kept as evidence (default 6; 0 disables).'),
  allowRecovery: z
    .boolean()
    .optional()
    .describe(
      'If the session dies, replace it (bounded, never resets data) and continue with the visited-screen history kept. Default true.',
    ),
  denyWords: z
    .array(z.string().max(30))
    .max(40)
    .optional()
    .describe('Extra words that must never be tapped, added to the built-in list.'),
  allowOnly: z
    .array(z.string().max(30))
    .max(40)
    .optional()
    .describe('If set, only labels containing one of these words are tapped.'),
  sessionId: z.string().optional().describe('Session ID; defaults to the active session.'),
});

const ANDROID_DISMISS = [
  'android:id/aerr_wait',
  'android:id/button2',
  'com.android.permissioncontroller:id/permission_deny_button',
  'com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button',
  'com.android.permissioncontroller:id/permission_allow_foreground_only_button',
  'com.android.packageinstaller:id/permission_deny_button',
];

export function deviceFor(sessionId: string, opts: {allowRecovery: boolean; evidenceDir: string}): ExploreDevice {
  let current = sessionId;
  const d = (): DriverInstance => {
    const i = getSessionInfo(current);
    if (!i) {
      throw new Error(`session ${current} is gone`);
    }
    return i.driver;
  };
  const isAndroid = () => getPlatformName(d()) !== PLATFORM.ios;
  return {
    async foreground() {
      try {
        if (!isAndroid()) {
          return ((await execute(d(), 'mobile: activeAppInfo', {})) as {bundleId?: string}).bundleId;
        }
        return String(await execute(d(), 'mobile: getCurrentPackage', {}));
      } catch (err) {
        if (/invalid session|no such|not running|terminated|instrumentation/i.test(String((err as Error).message))) {
          throw err;
        }
        return undefined;
      }
    },
    async snapshot() {
      return parseScreen(await getPageSource(d()));
    },
    async tap(c) {
      const {strategy, selector} = parseLocator(c.locator, isAndroid());
      const found = (await findElements(d(), strategy, selector)) as unknown[];
      const id = Array.isArray(found) ? readWebElementId(found[0]) : undefined;
      if (!id) {
        return 'missing';
      }
      await elementClick(d(), id);
      return 'tapped';
    },
    async back() {
      await back(d());
    },
    async activate(appId) {
      await activateApp(d(), appId);
    },
    async dismissOverlay() {
      if (!isAndroid()) {
        try {
          await execute(d(), 'mobile: dismissAlert', {});
          return true;
        } catch {
          return false;
        }
      }
      for (const id of ANDROID_DISMISS) {
        try {
          const found = (await findElement(d(), 'id', id)) as unknown;
          const el = readWebElementId(found);
          if (el) {
            await elementClick(d(), el);
            return true;
          }
        } catch {
          // not present
        }
      }
      return false;
    },
    async screenshot(label) {
      await mkdir(opts.evidenceDir, {recursive: true});
      const b64 = await getScreenshot(d());
      const file = join(
        opts.evidenceDir,
        `explore_${Date.now()}_${label.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30)}.png`,
      );
      await writeFile(file, Buffer.from(b64, 'base64'));
      return file;
    },
    async recover() {
      if (!opts.allowRecovery) {
        return {ok: false, detail: 'recovery is disabled for this run (allowRecovery=false)'};
      }
      const rep = await recoverSession({sessionId: current, recover: true});
      if (rep.result === 'recovered' && rep.newSessionId) {
        current = rep.newSessionId;
        return {
          ok: true,
          detail: `${rep.failure.kind}; new session ${rep.newSessionId}; app restored: ${rep.appRestored}`,
        };
      }
      return {ok: false, detail: `${rep.result}: ${rep.reason ?? rep.failure.kind}`};
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export default function exploreTools(server: FastMCP): void {
  server.addTool({
    name: 'appium_explore',
    description:
      'Bounded, safety-gated exploration of one app. Taps unseen labelled controls breadth-first (never inputs, never anything matching the deny list: delete, pay, bid, submit, log out...), detects leaving the app and relaunches it, clears permission and ANR dialogs, keeps visited-screen history, and returns a structured report: status (explored | app-boundary | safety | device-failure | limits | error), screens, unexplored controls, safety-skipped controls, boundary-crossing controls, action history and screenshots. State-changing: use a test account or environment.',
    parameters: schema,
    annotations: {readOnlyHint: false, openWorldHint: false},
    execute: async (args: z.infer<typeof schema>): Promise<ContentResult> => {
      const r = await resolveDriver(args.sessionId);
      if (!r.ok) {
        return textResult(
          JSON.stringify({
            status: 'device-failure',
            detail: String((r.result.content[0] as {text?: string}).text ?? 'no active session').slice(0, 200),
            counts: {taps: 0, screens: 0},
            screens: [],
          }),
        );
      }
      const sid = args.sessionId ?? (await import('../../session-store.js')).getSessionId();
      if (!sid) {
        return textResult(
          JSON.stringify({
            status: 'device-failure',
            detail: 'no active session',
            counts: {taps: 0, screens: 0},
            screens: [],
          }),
        );
      }
      try {
        const device = deviceFor(sid, {
          allowRecovery: args.allowRecovery !== false,
          evidenceDir: resolveScreenshotDir(),
        });
        const report = await runExploration(device, {
          appId: args.appId,
          maxSteps: args.maxSteps ?? 15,
          maxDepth: args.maxDepth ?? 3,
          maxScreens: args.maxScreens ?? 15,
          maxScreenshots: args.maxScreenshots ?? 6,
          maxRecoveries: args.allowRecovery === false ? 0 : 2,
          settleMs: 700,
          returnPolls: 6,
          deny: [...DEFAULT_DENY, ...(args.denyWords ?? [])],
          allowOnly: args.allowOnly,
        });
        return textResult(
          JSON.stringify({
            goal: args.goal,
            ...report,
            note: 'Coverage is what safe taps could reach within the limits; restricted and untried controls were not tested.',
          }),
        );
      } catch (err) {
        return textResult(
          JSON.stringify({
            status: 'error',
            detail: toolErrorMessage(err).slice(0, 200),
            counts: {taps: 0, screens: 0},
            screens: [],
          }),
        );
      }
    },
  });
}
