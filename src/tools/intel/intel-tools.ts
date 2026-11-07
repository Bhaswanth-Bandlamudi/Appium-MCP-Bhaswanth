import type {ContentResult, FastMCP} from 'fastmcp';
import {z} from 'zod';

import {execute, getPageSource, queryAppState} from '../../command.js';
import {getPlatformName, PLATFORM} from '../../session-store.js';
import type {DriverInstance} from '../../session-store.js';
import {errorResult, resolveDriver, textResult, toolErrorMessage} from '../tool-response.js';
import {diagnose, generateScenarios, parseLogcat} from './diagnostics.js';
import type {LogFindings} from './diagnostics.js';
import {analyzeScreen, auditAccessibility, diffScreens, findNodes, locatorCandidates} from './engines.js';
import {centerOf, labelOf, parseScreen, shortClass} from './screen-model.js';
import type {Screen} from './screen-model.js';

type Verbosity = 'minimal' | 'standard' | 'detailed';
const verbosityField = z
  .enum(['minimal', 'standard', 'detailed'])
  .optional()
  .describe('Output size. Default standard.');
const sessionIdField = z.string().optional().describe('Session ID; defaults to the active session.');

const MAX_SNAPSHOTS = 8;
const snapshots = new Map<string, Map<string, Screen>>();

function snapStore(sessionId?: string): Map<string, Screen> {
  const k = sessionId ?? 'active';
  let m = snapshots.get(k);
  if (!m) {
    m = new Map();
    snapshots.set(k, m);
  }
  return m;
}

async function capture(driver: DriverInstance): Promise<Screen> {
  return parseScreen(await getPageSource(driver));
}

const json = (v: unknown): ContentResult => textResult(JSON.stringify(v));

async function guarded(sessionId: string | undefined, fn: (d: DriverInstance) => Promise<ContentResult>) {
  const r = await resolveDriver(sessionId);
  if (!r.ok) {
    return r.result;
  }
  try {
    return await fn(r.driver);
  } catch (err) {
    return errorResult(toolErrorMessage(err));
  }
}

async function readLogcat(driver: DriverInstance): Promise<string | undefined> {
  const d = driver as unknown as {getLog?: (t: string) => Promise<unknown>; getLogs?: (t: string) => Promise<unknown>};
  for (const fn of [d.getLog, d.getLogs]) {
    if (typeof fn !== 'function') {
      continue;
    }
    try {
      const entries = (await fn.call(driver, 'logcat')) as {message?: string}[] | string;
      if (typeof entries === 'string') {
        return entries;
      }
      if (Array.isArray(entries)) {
        return entries.map((e) => (typeof e === 'string' ? e : (e.message ?? ''))).join('\n');
      }
    } catch {
      // log type unsupported on this driver/session
    }
  }
  return undefined;
}

export default function intelTools(server: FastMCP): void {
  // ---- appium_screen_intel ---------------------------------------------
  const screenSchema = z.object({
    verbosity: verbosityField,
    snapshot: z.string().max(40).optional().describe('Also save this screen under a name for appium_ui_diff.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_screen_intel',
    description:
      'Classify the current screen (form, list, dialog, login...) and summarise inputs, buttons, navigation, keyboard/dialog state, below-the-fold content and suggested next actions. One call replaces page source + several finds.',
    parameters: screenSchema,
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (args: z.infer<typeof screenSchema>) =>
      guarded(args.sessionId, async (driver) => {
        const screen = await capture(driver);
        if (args.snapshot) {
          const store = snapStore(args.sessionId);
          if (store.size >= MAX_SNAPSHOTS && !store.has(args.snapshot)) {
            store.delete(store.keys().next().value as string);
          }
          store.set(args.snapshot, screen);
        }
        const a = analyzeScreen(screen);
        const v: Verbosity = args.verbosity ?? 'standard';
        if (v === 'minimal') {
          return json({
            type: a.screenType,
            dialog: a.dialog,
            keyboard: a.keyboard,
            inputs: a.inputs.length,
            buttons: a.buttons.slice(0, 6),
            notes: a.notes,
          });
        }
        if (v === 'standard') {
          return json(a);
        }
        const clickable = screen.nodes
          .filter((n) => n.visible && n.clickable)
          .slice(0, 60)
          .map((n) => ({t: shortClass(n.cls), id: n.id, label: labelOf(n), xy: centerOf(n)}));
        return json({...a, clickable});
      }),
  });

  // ---- appium_locator_intel --------------------------------------------
  const locSchema = z.object({
    text: z.string().optional().describe('Text, content-desc or id fragment of the target (case-insensitive).'),
    id: z.string().optional().describe('Resource-id fragment.'),
    clickable: z.boolean().optional(),
    input: z.boolean().optional().describe('Only input fields.'),
    includeHidden: z.boolean().optional().describe('Also consider off-screen/hidden nodes.'),
    limit: z.number().int().min(1).max(10).optional().describe('Max targets (default 3).'),
    verbosity: verbosityField,
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_locator_intel',
    description:
      'Find target element(s) by description and return validated locator candidates, each with live match count (1 = unique), a 0-100 stability score and warnings (value-dependent ids, positional xpath, hidden target). Recommended locator is first. Counts come from the current screen, so re-verify after navigation.',
    parameters: locSchema,
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (args: z.infer<typeof locSchema>) =>
      guarded(args.sessionId, async (driver) => {
        if (!args.text && !args.id && !args.clickable && !args.input) {
          return errorResult('Provide text, id, clickable or input.');
        }
        const screen = await capture(driver);
        const nodes = findNodes(screen, args, args.includeHidden).slice(0, args.limit ?? 3);
        if (!nodes.length) {
          return json({found: 0, hint: 'nothing matches on the current screen; try includeHidden=true or scroll'});
        }
        const v: Verbosity = args.verbosity ?? 'standard';
        return json({
          found: nodes.length,
          targets: nodes.map((n) => {
            const c = locatorCandidates(screen, n);
            const best = c[0];
            return {
              element: `${shortClass(n.cls)} "${labelOf(n)}"${n.visible ? '' : ' (hidden)'}`,
              recommended: best
                ? {locator: best.short, matches: best.matches, score: best.score, notes: best.notes}
                : null,
              alternatives:
                v === 'minimal'
                  ? undefined
                  : c
                      .slice(1, v === 'detailed' ? 6 : 3)
                      .map((x) => ({locator: x.short, matches: x.matches, score: x.score, notes: x.notes})),
              safeToUse: !!best && best.matches === 1 && best.score >= 50,
            };
          }),
        });
      }),
  });

  // ---- appium_ui_diff ---------------------------------------------------
  const diffSchema = z.object({
    from: z.string().describe('Snapshot name saved earlier (appium_screen_intel snapshot=...).'),
    to: z.string().optional().describe('Second snapshot name; omit to compare against the live screen.'),
    limit: z.number().int().min(1).max(100).optional().describe('Max items per category (default 25).'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_ui_diff',
    description:
      'Diff two UI states: added/removed elements, changed text, changed enabled/checked/focused state, moved elements. Compares a saved snapshot to another snapshot or the live screen.',
    parameters: diffSchema,
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (args: z.infer<typeof diffSchema>) =>
      guarded(args.sessionId, async (driver) => {
        const store = snapStore(args.sessionId);
        const a = store.get(args.from);
        if (!a) {
          return errorResult(`No snapshot '${args.from}'. Saved: ${[...store.keys()].join(', ') || 'none'}`);
        }
        const b = args.to ? store.get(args.to) : await capture(driver);
        if (!b) {
          return errorResult(`No snapshot '${args.to}'.`);
        }
        return json(diffScreens(a, b, args.limit ?? 25));
      }),
  });

  // ---- appium_a11y_audit -----------------------------------------------
  const a11ySchema = z.object({
    minTargetPx: z
      .number()
      .int()
      .min(0)
      .max(400)
      .optional()
      .describe('Flag clickable targets smaller than this many pixels (48dp = 48*density px). Default off.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_a11y_audit',
    description:
      'Static accessibility audit of the current screen from the UI tree: unlabeled controls, image buttons without content-desc, inputs without labels, duplicate accessible names, optional small touch targets. Does not run TalkBack/VoiceOver, so it finds likely issues only.',
    parameters: a11ySchema,
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (args: z.infer<typeof a11ySchema>) =>
      guarded(args.sessionId, async (driver) => {
        const issues = auditAccessibility(await capture(driver), args.minTargetPx ?? 0);
        return json({
          count: issues.length,
          high: issues.filter((i) => i.severity === 'high').length,
          issues: issues.slice(0, 40),
        });
      }),
  });

  // ---- appium_scenarios -------------------------------------------------
  const scenSchema = z.object({
    requirement: z
      .string()
      .max(500)
      .optional()
      .describe('Optional requirement text; expected results stay TO CONFIRM unless you supply rules.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_scenarios',
    description:
      'Generate positive, negative, boundary and exploratory test scenarios from the elements actually on the current screen. Expected results that depend on business rules are marked TO CONFIRM rather than invented.',
    parameters: scenSchema,
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (args: z.infer<typeof scenSchema>) =>
      guarded(args.sessionId, async (driver) => json(generateScenarios(await capture(driver), args.requirement))),
  });

  // ---- appium_diagnose --------------------------------------------------
  const diagSchema = z.object({
    error: z.string().max(1000).optional().describe('The error message from the failed step.'),
    locator: z.string().optional().describe('Locator that failed (id=..., text=...).'),
    appId: z.string().optional().describe('Package / bundle id, enables crash correlation and app-state check.'),
    includeLogs: z.boolean().optional().describe('Read logcat (Android) for crashes/ANR/network errors. Default true.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_diagnose',
    description:
      'Failure intelligence: after a step fails, checks session liveness, app state, current screen (dialog, keyboard, hidden/ambiguous/disabled target) and logcat crash/ANR/network signals, then returns evidence, likely causes with confidence, next steps and safe recovery. Read-only; never retries or changes state.',
    parameters: diagSchema,
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (args: z.infer<typeof diagSchema>) => {
      const r = await resolveDriver(args.sessionId);
      if (!r.ok) {
        return r.result;
      }
      const driver = r.driver;
      let sessionAlive = true;
      let screen: Screen | undefined;
      try {
        screen = await capture(driver);
      } catch {
        sessionAlive = false;
      }
      let appState: number | undefined;
      if (sessionAlive && args.appId) {
        try {
          appState = await queryAppState(driver, args.appId);
        } catch {
          // state query unsupported
        }
      }
      let logs: LogFindings | undefined;
      let logNote: string | undefined;
      if (sessionAlive && (args.includeLogs ?? true) && getPlatformName(driver) !== PLATFORM.ios) {
        const raw = await readLogcat(driver);
        if (raw) {
          logs = parseLogcat(raw, args.appId);
        } else {
          logNote = 'logcat not readable in this session';
        }
      }
      const d = diagnose({error: args.error, locator: args.locator, screen, logs, appState, sessionAlive});
      return json(logNote ? {...d, evidence: [...d.evidence, logNote]} : d);
    },
  });

  // ---- appium_scroll_until ---------------------------------------------
  const scrollSchema = z.object({
    locator: z.string().describe('Target: id=..., text=..., desc=... Stops when it is visible.'),
    direction: z.enum(['down', 'up']).optional().describe('Default down.'),
    maxScrolls: z.number().int().min(1).max(30).optional().describe('Default 10.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_scroll_until',
    description:
      'Scroll the screen until the target is visible, stopping early when the page stops changing (end of list). Reports scrolls used and whether it was found. State-changing only in scroll position.',
    parameters: scrollSchema,
    annotations: {readOnlyHint: false, openWorldHint: false},
    execute: async (args: z.infer<typeof scrollSchema>) =>
      guarded(args.sessionId, async (driver) => {
        const kind = args.locator.split('=')[0];
        const value = args.locator.slice(kind.length + 1);
        if (!['id', 'text', 'desc'].includes(kind) || !value) {
          return errorResult('locator must be id=..., text=... or desc=...');
        }
        const query = kind === 'id' ? {id: value} : {text: value};
        const android = getPlatformName(driver) !== PLATFORM.ios;
        const dir = args.direction ?? 'down';
        let prevSig = '';
        for (let i = 0; i <= (args.maxScrolls ?? 10); i++) {
          const screen = await capture(driver);
          const hit = findNodes(screen, query).find((n) =>
            kind === 'id' ? n.id === value : kind === 'text' ? n.text === value : n.desc === value,
          );
          if (hit) {
            return json({
              found: true,
              scrolls: i,
              element: `${shortClass(hit.cls)} "${labelOf(hit)}"`,
              xy: centerOf(hit),
            });
          }
          const sig = screen.nodes
            .filter((n) => n.visible)
            .map((n) => `${n.id}|${n.text}`)
            .join(';');
          if (sig === prevSig) {
            return json({
              found: false,
              scrolls: i,
              reason: 'screen stopped changing (end of content or nothing scrollable)',
            });
          }
          prevSig = sig;
          if (i === (args.maxScrolls ?? 10)) {
            break;
          }
          const w = screen.width || 1000;
          const h = screen.height || 2000;
          if (android) {
            await execute(driver, 'mobile: scrollGesture', {
              left: Math.round(w * 0.1),
              top: Math.round(h * 0.25),
              width: Math.round(w * 0.8),
              height: Math.round(h * 0.5),
              direction: dir,
              percent: 0.7,
            });
          } else {
            await execute(driver, 'mobile: swipe', {direction: dir === 'down' ? 'up' : 'down'});
          }
        }
        return json({found: false, scrolls: args.maxScrolls ?? 10, reason: 'maxScrolls reached'});
      }),
  });
}
