import type {ContentResult, FastMCP} from 'fastmcp';
import {z} from 'zod';

import {back, elementClick, findElement, findElements, getElementText, getPageSource, setValue} from '../../command.js';
import {getPlatformName, PLATFORM} from '../../session-store.js';
import type {DriverInstance} from '../../session-store.js';
import {noteExecutedSteps, stepSchema} from '../ops/steps.js';
import type {Step} from '../ops/steps.js';
import {errorResult, readWebElementId, resolveDriver, textResult, toolErrorMessage} from '../tool-response.js';
import {compactPageSource, diffLines, formatNode, parseLocator} from './compact-screen.js';

const lastScreen = new Map<string, string[]>();

const sessionKey = (sessionId?: string) => sessionId ?? 'active';

function isAndroid(driver: DriverInstance): boolean {
  return getPlatformName(driver) !== PLATFORM.ios;
}

async function countMatches(driver: DriverInstance, loc: string): Promise<{count: number; ids: string[]}> {
  const {strategy, selector} = parseLocator(loc, isAndroid(driver));
  const found = (await findElements(driver, strategy, selector)) as unknown[];
  const list = Array.isArray(found) ? found : [];
  return {count: list.length, ids: list.map((e) => readWebElementId(e)).filter((x): x is string => !!x)};
}

async function waitFor(
  driver: DriverInstance,
  loc: string,
  timeoutMs: number,
  mode: 'present' | 'gone',
): Promise<{ok: boolean; count: number; waitedMs: number}> {
  const start = Date.now();
  for (;;) {
    let count: number;
    try {
      count = (await countMatches(driver, loc)).count;
    } catch {
      count = 0;
    }
    if ((mode === 'present' && count > 0) || (mode === 'gone' && count === 0)) {
      return {ok: true, count, waitedMs: Date.now() - start};
    }
    if (Date.now() - start >= timeoutMs) {
      return {ok: false, count, waitedMs: Date.now() - start};
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function observe(driver: DriverInstance, sessionId: string | undefined, o: ObserveOpts): Promise<string> {
  const source = await getPageSource(driver);
  const nodes = compactPageSource(source, {includeText: o.includeText, limit: o.limit});
  const lines = nodes.map(formatNode);
  const key = sessionKey(sessionId);
  const prev = lastScreen.get(key);
  lastScreen.set(key, lines);
  if (o.diff && prev) {
    const d = diffLines(prev, lines);
    return [
      `diff: +${d.added.length} -${d.removed.length} =${d.unchanged}`,
      ...d.added.map((l) => `+ ${l}`),
      ...d.removed.map((l) => `- ${l}`),
    ].join('\n');
  }
  return [`${lines.length} nodes (c=clickable k=checked e=disabled f=focused s=scrollable p=password)`, ...lines].join(
    '\n',
  );
}

interface ObserveOpts {
  includeText?: boolean;
  limit?: number;
  diff?: boolean;
}

const sessionIdField = z.string().optional().describe('Session ID; defaults to the active session.');

const INTERRUPT_BUTTONS = [
  'android:id/button2',
  'com.android.permissioncontroller:id/permission_deny_button',
  'com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button',
  'com.android.permissioncontroller:id/permission_allow_foreground_only_button',
  'com.android.packageinstaller:id/permission_deny_button',
];

export interface RunResult {
  lines: string[];
  failed: boolean;
  /** number of steps that completed successfully, in order */
  executed: number;
}

/** Shared by appium_batch and appium_workflow replay so both behave identically. */
export async function runSteps(
  driver: DriverInstance,
  steps: readonly Step[],
  stopOnError: boolean,
): Promise<RunResult> {
  const results: string[] = [];
  let failed = false;
  let executed = 0;
  for (const [i, step] of steps.entries()) {
    const tag = `${i + 1}.${step.do}`;
    try {
      if (step.do === 'back') {
        await back(driver);
        results.push(`${tag} ok`);
      } else if (step.do === 'pause') {
        await new Promise((r) => setTimeout(r, step.ms));
        results.push(`${tag} ok`);
      } else if (step.do === 'wait') {
        const r = await waitFor(driver, step.locator, (step.timeoutSec ?? 15) * 1000, step.until ?? 'present');
        if (!r.ok) {
          throw new Error(`timeout ${r.waitedMs}ms for ${step.locator}`);
        }
        results.push(`${tag} ok ${r.waitedMs}ms`);
      } else {
        const w = await waitFor(driver, step.locator, (step.waitSec ?? 10) * 1000, 'present');
        if (!w.ok) {
          throw new Error(`not found: ${step.locator}`);
        }
        const {strategy, selector} = parseLocator(step.locator, isAndroid(driver));
        const id = readWebElementId(await findElement(driver, strategy, selector));
        if (!id) {
          throw new Error(`no element id for ${step.locator}`);
        }
        if (step.do === 'tap') {
          await elementClick(driver, id);
          results.push(`${tag} ok${w.count > 1 ? ` (warn: ${w.count} matches, used first)` : ''}`);
        } else if (step.do === 'type') {
          await setValue(driver, id, step.text === '${SECRET}' ? (process.env.APPIUM_MCP_SECRET ?? '') : step.text);
          results.push(`${tag} ok`);
        } else {
          results.push(`${tag} ${JSON.stringify(await getElementText(driver, id))}`);
        }
      }
      executed++;
    } catch (err) {
      results.push(`${tag} FAIL ${toolErrorMessage(err)}`);
      failed = true;
      if (stopOnError) {
        break;
      }
    }
  }
  return {lines: results, failed, executed};
}

export default function efficientTools(server: FastMCP): void {
  // ---- appium_observe -------------------------------------------------
  const observeSchema = z.object({
    diff: z.boolean().optional().describe('Return only changes since the last observe (default false).'),
    includeText: z.boolean().optional().describe('Include text of non-clickable nodes (default true).'),
    limit: z.number().int().min(1).max(300).optional().describe('Max nodes (default 80).'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_observe',
    description:
      'Compact one-line-per-element view of the current screen (class, id, desc, text, flags, center). Far cheaper than page source or generate_locators. Use diff=true after an action.',
    parameters: observeSchema,
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (args: z.infer<typeof observeSchema>): Promise<ContentResult> => {
      const resolved = await resolveDriver(args.sessionId);
      if (!resolved.ok) {
        return resolved.result;
      }
      try {
        return textResult(await observe(resolved.driver, args.sessionId, args));
      } catch (err) {
        return errorResult(`observe failed: ${toolErrorMessage(err)}`);
      }
    },
  });

  // ---- appium_wait_for ------------------------------------------------
  const waitSchema = z.object({
    locator: z.string().describe('id=..., desc=..., text=..., xpath=..., uia=... or pred=...'),
    until: z.enum(['present', 'gone']).optional().describe('Default present.'),
    timeoutSec: z.number().min(1).max(120).optional().describe('Default 15.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_wait_for',
    description: 'Poll until a locator is present (or gone). Use instead of retrying find_element after navigation.',
    parameters: waitSchema,
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (args: z.infer<typeof waitSchema>): Promise<ContentResult> => {
      const resolved = await resolveDriver(args.sessionId);
      if (!resolved.ok) {
        return resolved.result;
      }
      try {
        const r = await waitFor(resolved.driver, args.locator, (args.timeoutSec ?? 15) * 1000, args.until ?? 'present');
        return r.ok
          ? textResult(`ok ${args.until ?? 'present'} matches=${r.count} waited=${r.waitedMs}ms`)
          : errorResult(`timeout after ${r.waitedMs}ms; matches=${r.count}`);
      } catch (err) {
        return errorResult(`wait_for failed: ${toolErrorMessage(err)}`);
      }
    },
  });

  // ---- appium_verify_locator -----------------------------------------
  const verifySchema = z.object({
    locators: z.array(z.string()).min(1).max(30).describe('Locators to check, same grammar as wait_for.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_verify_locator',
    description:
      'Count matches for each locator on the live screen. Only a count of exactly 1 is safe to put in test code; >1 is ambiguous, 0 is absent.',
    parameters: verifySchema,
    annotations: {readOnlyHint: true, openWorldHint: false},
    execute: async (args: z.infer<typeof verifySchema>): Promise<ContentResult> => {
      const resolved = await resolveDriver(args.sessionId);
      if (!resolved.ok) {
        return resolved.result;
      }
      const lines: string[] = [];
      for (const loc of args.locators) {
        try {
          const {count} = await countMatches(resolved.driver, loc);
          lines.push(`${count === 1 ? 'UNIQUE' : count === 0 ? 'ABSENT' : 'AMBIGUOUS'} (${count}) ${loc}`);
        } catch (err) {
          lines.push(`ERROR ${loc}: ${toolErrorMessage(err)}`);
        }
      }
      return textResult(lines.join('\n'));
    },
  });

  // ---- appium_dismiss_interrupts -------------------------------------
  const dismissSchema = z.object({
    extraLocators: z.array(z.string()).max(10).optional().describe('Extra locators to tap when present.'),
    maxRounds: z.number().int().min(1).max(10).optional().describe('Default 4.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_dismiss_interrupts',
    description:
      'Loop-dismiss native popups (permission deny, Android alert negative button e.g. passkey NOT NOW) plus any extra locators, until none remain.',
    parameters: dismissSchema,
    annotations: {readOnlyHint: false, openWorldHint: false},
    execute: async (args: z.infer<typeof dismissSchema>): Promise<ContentResult> => {
      const resolved = await resolveDriver(args.sessionId);
      if (!resolved.ok) {
        return resolved.result;
      }
      const {driver} = resolved;
      const targets = [
        ...(isAndroid(driver) ? INTERRUPT_BUTTONS.map((b) => `id=${b}`) : []),
        ...(args.extraLocators ?? []),
      ];
      const dismissed: string[] = [];
      for (let round = 0; round < (args.maxRounds ?? 4); round++) {
        let any = false;
        for (const loc of targets) {
          try {
            const {strategy, selector} = parseLocator(loc, isAndroid(driver));
            const found = (await findElements(driver, strategy, selector)) as unknown[];
            const id = Array.isArray(found) ? readWebElementId(found[0]) : undefined;
            if (id) {
              await elementClick(driver, id);
              dismissed.push(loc);
              any = true;
            }
          } catch {
            // popup vanished between find and click
          }
        }
        if (!any) {
          break;
        }
      }
      return textResult(dismissed.length ? `dismissed: ${dismissed.join(', ')}` : 'none present');
    },
  });

  // ---- appium_batch ---------------------------------------------------
  const batchSchema = z.object({
    steps: z.array(stepSchema).min(1).max(25),
    observeAfter: z.enum(['none', 'diff', 'full']).optional().describe('Screen summary after the batch. Default diff.'),
    stopOnError: z.boolean().optional().describe('Default true.'),
    sessionId: sessionIdField,
  });
  server.addTool({
    name: 'appium_batch',
    description:
      'Run up to 25 steps (tap, type, wait, read, back, pause) in ONE call and return per-step results plus a compact screen summary. Locators: id=, desc=, text=, xpath=, uia=, pred=. Taps/types wait up to 10s for the element by default.',
    parameters: batchSchema,
    annotations: {readOnlyHint: false, openWorldHint: false},
    execute: async (args: z.infer<typeof batchSchema>): Promise<ContentResult> => {
      const resolved = await resolveDriver(args.sessionId);
      if (!resolved.ok) {
        return resolved.result;
      }
      const {driver} = resolved;
      const run = await runSteps(driver, args.steps, args.stopOnError ?? true);
      const results = run.lines;
      const failed = run.failed;
      noteExecutedSteps(args.sessionId, args.steps.slice(0, run.executed));
      const mode = args.observeAfter ?? 'diff';
      if (mode !== 'none') {
        try {
          results.push('--- screen ---');
          results.push(await observe(driver, args.sessionId, {diff: mode === 'diff', limit: 60}));
        } catch (err) {
          results.push(`observe failed: ${toolErrorMessage(err)}`);
        }
      }
      const out = textResult(results.join('\n'));
      return failed ? {...out, isError: true} : out;
    },
  });
}
