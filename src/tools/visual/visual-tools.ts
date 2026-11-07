import {imageUtil} from '@appium/support';
import type {ContentResult, FastMCP} from 'fastmcp';
import {z} from 'zod';

import {getPageSource, getScreenshot} from '../../command.js';
import type {DriverInstance} from '../../session-store.js';
import {parseScreen} from '../intel/screen-model.js';
import {errorResult, resolveDriver, textResult, toolErrorMessage} from '../tool-response.js';
import {diffImages, layoutIssues} from './visual-diff.js';
import type {Raw} from './visual-diff.js';

const MAX_BASELINES = 6;
const baselines = new Map<string, Map<string, Raw>>();

async function shot(driver: DriverInstance, width: number): Promise<Raw> {
  const b64 = await getScreenshot(driver);
  const sharp = imageUtil.requireSharp();
  // Downscale before comparing: cheaper and absorbs sub-pixel anti-aliasing noise.
  const {data, info} = await sharp(Buffer.from(b64, 'base64'))
    .resize({width})
    .removeAlpha()
    .raw()
    .toBuffer({resolveWithObject: true});
  return {data: new Uint8Array(data), width: info.width, height: info.height, channels: info.channels};
}

const schema = z.object({
  action: z
    .enum(['baseline', 'compare', 'layout'])
    .describe(
      'baseline: store the current screen as `name`. compare: diff the live screen against baseline `name` and report changed regions. layout: check the live UI tree for overlapping and clipped elements.',
    ),
  name: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .optional()
    .describe('Baseline name (baseline/compare).'),
  width: z.number().int().min(120).max(720).optional().describe('Comparison width in px (default 360).'),
  tolerance: z.number().int().min(0).max(255).optional().describe('Per-channel colour tolerance (default 24).'),
  sessionId: z.string().optional().describe('Session ID; defaults to the active session.'),
});

export default function visualTools(server: FastMCP): void {
  server.addTool({
    name: 'appium_visual_check',
    description:
      'Visual regression helper. baseline+compare report the screen regions that changed (x,y,w,h and % of pixels) instead of returning images; layout reports overlapping or clipped elements from the UI tree. Baselines are in memory per session (max 6). Dynamic content such as clocks or ads will show as changes.',
    parameters: schema,
    annotations: {readOnlyHint: false, openWorldHint: false},
    execute: async (args: z.infer<typeof schema>): Promise<ContentResult> => {
      const r = await resolveDriver(args.sessionId);
      if (!r.ok) {
        return r.result;
      }
      try {
        if (args.action === 'layout') {
          const issues = layoutIssues(parseScreen(await getPageSource(r.driver)));
          return textResult(JSON.stringify({count: issues.length, issues}));
        }
        if (!args.name) {
          return errorResult('name is required for baseline/compare');
        }
        const key = args.sessionId ?? 'active';
        let store = baselines.get(key);
        if (!store) {
          baselines.set(key, (store = new Map()));
        }
        const img = await shot(r.driver, args.width ?? 360);
        if (args.action === 'baseline') {
          if (store.size >= MAX_BASELINES && !store.has(args.name)) {
            store.delete(store.keys().next().value as string);
          }
          store.set(args.name, img);
          return textResult(JSON.stringify({saved: args.name, size: `${img.width}x${img.height}`}));
        }
        const base = store.get(args.name);
        if (!base) {
          return errorResult(`No baseline '${args.name}'. Saved: ${[...store.keys()].join(', ') || 'none'}`);
        }
        const d = diffImages(base, img, {channelTolerance: args.tolerance});
        return textResult(
          JSON.stringify({
            ...d,
            unit: `px at width ${img.width}`,
            verdict:
              d.changedPct === 0
                ? 'identical within tolerance'
                : d.sameSize
                  ? 'changed'
                  : 'different dimensions (orientation or device changed)',
          }),
        );
      } catch (err) {
        return errorResult(`visual_check failed: ${toolErrorMessage(err)}`);
      }
    },
  });
}
