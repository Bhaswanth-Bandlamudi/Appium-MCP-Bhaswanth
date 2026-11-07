#!/usr/bin/env node
/**
 * Token benchmark: upstream appium-mcp v1.99.3 (baseline) vs this build.
 *
 * Measures (1) the fixed cost of tool definitions under several configurations and (2) the context cost of
 * representative tool calls and workflows (call arguments + results).
 *
 * Tokenizer:
 *   - ANTHROPIC_API_KEY set  -> Anthropic's token-counting endpoint (free, rate limited). These are Claude counts,
 *     "exact" in the sense the API reports them, and still described by Anthropic as an estimate.
 *   - otherwise              -> js-tiktoken o200k_base. That is an OpenAI encoding: a PROXY, not Claude token counts.
 *     It is labelled as such in every line of output. If js-tiktoken is missing the script stops and says how to install it.
 * Character counts are printed for orientation only and are never presented as tokens.
 *
 * Usage:
 *   npm run bench:tokens                     offline: reads the stored fixtures, measures current definitions live from dist/
 *   npm run bench:tokens -- --proxy          force the proxy tokenizer even if a key is set
 *   npm run bench:tokens -- --model <id>     Claude model used for the API counts (default: claude-sonnet-5-5, or BENCH_MODEL)
 *   npm run bench:tokens -- --capture        re-capture fixtures from a device (needs adb device, both builds; see src/tests/integration/README.md)
 *   npm run bench:tokens -- --baseline-dir <dir>   built upstream checkout for --capture and live baseline definitions
 *
 * Nothing secret is printed: the key is read from the environment and sent only to api.anthropic.com; tool outputs are
 * measured, not echoed, and the fixtures are sanitized at capture time.
 */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = join(ROOT, 'src', 'tests', 'fixtures', 'bench', 'captured.json');
const OUT_DIR = join(ROOT, 'benchmark-results');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const MODEL = opt('model', process.env.BENCH_MODEL ?? 'claude-sonnet-5-5');
const API_VERSION = process.env.BENCH_ANTHROPIC_VERSION ?? '2026-10-21';

// ───────────────────────────── tokenizers ─────────────────────────────

async function makeCounter() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key && !flag('proxy')) {
    const cache = new Map();
    const post = async (body) => {
      const h = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      if (cache.has(h)) {
        return cache.get(h);
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
          method: 'POST',
          headers: {'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json'},
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        const text = await res.text();
        if (!res.ok) {
          // The body is an API error object; the key is never part of it. Still bound the length.
          throw new Error(`count_tokens HTTP ${res.status}: ${text.slice(0, 240)}`);
        }
        const n = JSON.parse(text).input_tokens;
        cache.set(h, n);
        return n;
      }
      throw new Error('count_tokens: retries exhausted');
    };
    const base = await post({model: MODEL, messages: [{role: 'user', content: 'x'}]});
    return {
      kind: 'anthropic-api',
      label: `Anthropic count_tokens, model ${MODEL}, anthropic-version ${API_VERSION}`,
      exact: true,
      async text(s) {
        return (await post({model: MODEL, messages: [{role: 'user', content: s || ' '}]})) - base;
      },
      async tools(defs) {
        return (
          (await post({
            model: MODEL,
            tools: defs.map((d) => ({name: d.name, description: d.description ?? '', input_schema: d.inputSchema})),
            messages: [{role: 'user', content: 'x'}],
          })) - base
        );
      },
    };
  }
  let enc;
  try {
    const mod = await import('js-tiktoken');
    enc = mod.getEncoding('o200k_base');
  } catch {
    console.error(
      'No ANTHROPIC_API_KEY and js-tiktoken is not installed.\n' +
        'Install the proxy tokenizer without touching package.json:  npm install --no-save js-tiktoken\n' +
        'or set ANTHROPIC_API_KEY to use the official token-counting API.',
    );
    process.exit(2);
  }
  return {
    kind: 'proxy',
    label: 'PROXY: js-tiktoken o200k_base (an OpenAI encoding; NOT Claude token counts)',
    exact: false,
    async text(s) {
      return enc.encode(s || ' ').length;
    },
    async tools(defs) {
      return enc.encode(
        JSON.stringify(
          defs.map((d) => ({name: d.name, description: d.description ?? '', input_schema: d.inputSchema})),
        ),
      ).length;
    },
  };
}

// ───────────────────────────── MCP helpers ─────────────────────────────

async function connect(dir, env = {}) {
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport} = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const e = {...process.env, NO_UI: 'true', APPIUM_MCP_OTEL_ENABLED: 'false', ...env};
  if (env.APPIUM_MCP_TOOL_GROUPS === undefined) {
    delete e.APPIUM_MCP_TOOL_GROUPS;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dir, 'dist', 'index.js')],
    cwd: dir,
    env: e,
    stderr: 'ignore',
  });
  const client = new Client({name: 'token-benchmark', version: '1'});
  await client.connect(transport);
  return {
    client,
    async tools() {
      return (await client.listTools()).tools;
    },
    async call(name, args = {}) {
      const r = await client.callTool({name, arguments: args}, undefined, {timeout: 240_000});
      const text = (r.content ?? []).map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n');
      return {isError: !!r.isError, text};
    },
    close: () => client.close(),
  };
}

const sanitize = (s) =>
  s
    .replace(/("androidId"\s*:\s*")[^"]*(")/g, '$1REDACTED$2')
    .replace(/("carrierName"\s*:\s*")[^"]*(")/g, '$1REDACTED$2')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, 'SESSION-ID')
    .replace(/(elementId ')[^']+(')/g, '$1ELEMENT-ID$2');

const adbBin = () => {
  const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  return home ? join(home, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb';
};
const adb = (...args) =>
  new Promise((res) =>
    execFile(adbBin(), args, {timeout: 20_000, windowsHide: true}, (_e, out) => res(String(out ?? ''))),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── cases ─────────────────────────────

const SETTINGS = 'com.android.settings';
const NET = "//*[@text='Network & internet']";

/**
 * A call is {name, args} or a function of the results so far. `base` runs on upstream v1.99.3, `cur` on this build.
 * Equivalent means: the same question answered with the tools each version offers.
 */
const CASES = [
  {
    id: 'page-source',
    cat: 'page source',
    title: 'Read the current screen',
    base: [{name: 'appium_get_page_source', args: {}}],
    cur: [{name: 'appium_get_page_source', args: {mode: 'compact'}}],
  },
  {
    id: 'locators-all',
    cat: 'element discovery',
    title: 'List locator candidates for the screen',
    base: [{name: 'generate_locators', args: {}}],
    cur: [{name: 'generate_locators', args: {limit: 10}}],
  },
  {
    id: 'locator-target',
    cat: 'element discovery',
    title: 'Find the "Network" row and get a usable locator',
    base: [{name: 'appium_find_elements', args: {strategy: 'xpath', selector: NET}}],
    cur: [{name: 'appium_locator_intel', args: {text: 'Network'}}],
    note: 'current output also carries uniqueness and a stability score; upstream returns only the element',
  },
  {
    id: 'device-info',
    cat: 'device information',
    title: 'Device information',
    base: [{name: 'appium_mobile_device_info', args: {action: 'info'}}],
    cur: [{name: 'appium_mobile_device_info', args: {action: 'info', verbosity: 'minimal'}}],
  },
  {
    id: 'session-info',
    cat: 'session information',
    title: 'List open sessions',
    base: [{name: 'appium_session_management', args: {action: 'list'}}],
    cur: [{name: 'appium_session_overview', args: {}}],
    note: 'current adds provider, active flag as data; it is not smaller by design',
  },
  {
    id: 'apps-all',
    cat: 'application list',
    title: 'List installed apps (all)',
    base: [{name: 'appium_app_lifecycle', args: {action: 'list'}}],
    cur: [{name: 'appium_app_lifecycle', args: {action: 'list'}}],
  },
  {
    id: 'apps-filter',
    cat: 'application list',
    title: 'Is a settings app installed? (targeted)',
    base: [{name: 'appium_app_lifecycle', args: {action: 'list'}}],
    cur: [{name: 'appium_app_lifecycle', args: {action: 'list', filter: 'settings'}}],
  },
  {
    id: 'permissions',
    cat: 'permissions',
    title: 'Check camera permission',
    base: [{name: 'appium_mobile_permissions', args: {action: 'get'}}],
    cur: [{name: 'appium_mobile_permissions', args: {action: 'get', grep: 'CAMERA'}}],
  },
  {
    id: 'error-element',
    cat: 'error response',
    title: 'Element not found',
    base: [{name: 'appium_find_element', args: {strategy: 'id', selector: 'nope:id/x'}}],
    cur: [{name: 'appium_find_element', args: {strategy: 'id', selector: 'nope:id/x'}}],
    note: 'unchanged code path',
  },
  {
    id: 'diagnose',
    cat: 'logs / diagnostics',
    title: 'Why did the step fail? (logs, screen, app state)',
    base: null,
    cur: [{name: 'appium_diagnose', args: {error: 'NoSuchElementException', locator: 'text=ZZZ', appId: SETTINGS}}],
    note: 'upstream has no log or diagnosis tool, so there is no baseline to compare; reported as an absolute cost only',
  },
  {
    id: 'wf-understand',
    cat: 'workflow',
    title: 'Workflow: understand the screen before acting',
    wf: true,
    base: [{name: 'appium_get_page_source', args: {}}],
    cur: [{name: 'appium_screen_intel', args: {}}],
  },
  {
    id: 'wf-open-row',
    cat: 'workflow',
    title: 'Workflow: open a row and confirm the next screen',
    wf: true,
    navigates: true,
    base: [
      {name: 'appium_find_element', args: {strategy: 'xpath', selector: NET}},
      (ctx) => ({
        name: 'appium_gesture',
        args: {
          action: 'tap',
          elementUUID: /elementId '([^']+)'/.exec(ctx.last('appium_find_element').text)?.[1] ?? 'missing',
        },
      }),
      {name: 'appium_get_page_source', args: {}},
    ],
    cur: [
      {
        name: 'appium_batch',
        args: {
          steps: [
            {do: 'tap', locator: 'text=Network & internet'},
            {do: 'wait', locator: 'text=Internet'},
          ],
          observeAfter: 'diff',
        },
      },
    ],
  },
  {
    id: 'wf-verify-locators',
    cat: 'workflow',
    title: 'Workflow: check whether two locators are unique',
    wf: true,
    base: [
      {name: 'appium_find_elements', args: {strategy: 'xpath', selector: NET}},
      {name: 'appium_find_elements', args: {strategy: 'xpath', selector: "//*[@text='Connected devices']"}},
    ],
    cur: [{name: 'appium_verify_locator', args: {locators: ['text=Network & internet', 'text=Connected devices']}}],
  },
];

async function runCalls(srv, calls) {
  // `raw` keeps the unsanitized text so a later call can use an earlier result (an element id); only `result` is stored.
  const ctx = {results: [], raw: [], last: (n) => ctx.raw.filter((r) => r.name === n).pop()};
  for (const c of calls) {
    const spec = typeof c === 'function' ? c(ctx) : c;
    const r = await srv.call(spec.name, spec.args);
    ctx.raw.push({name: spec.name, text: r.text});
    ctx.results.push({
      name: spec.name,
      args: spec.args.elementUUID ? {...spec.args, elementUUID: 'ELEMENT-ID'} : spec.args,
      result: {isError: r.isError, text: sanitize(r.text)},
    });
  }
  return ctx.results;
}

async function capture() {
  const baselineDir = resolve(opt('baseline-dir', join(ROOT, '.baseline')));
  if (!existsSync(join(baselineDir, 'dist', 'index.js'))) {
    console.error(
      `Baseline build not found at ${baselineDir}. Create one: git archive v1.99.3 | tar -x -C <dir>, then build it (see src/tests/integration/README.md).`,
    );
    process.exit(2);
  }
  if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
    console.error('dist/ is missing: run npm run build first.');
    process.exit(2);
  }
  const devices = (await adb('devices')).split(/\r?\n/).filter((l) => /\tdevice$/.test(l));
  if (devices.length !== 1) {
    console.error(`Need exactly one adb device in state "device"; found ${devices.length}.`);
    process.exit(2);
  }
  const caps = JSON.stringify({
    'appium:app': null,
    'appium:appPackage': SETTINGS,
    'appium:appActivity': '.Settings',
    'appium:noReset': true,
    'appium:autoLaunch': false,
    'appium:uiautomator2ServerLaunchTimeout': 120000,
    'appium:adbExecTimeout': 60000,
  });
  const home = async () => {
    await adb('shell', 'am', 'force-stop', SETTINGS);
    await adb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS');
    await sleep(6000);
  };
  const out = {
    meta: {},
    baselineTools: [],
    cases: CASES.map((c) => ({
      id: c.id,
      cat: c.cat,
      title: c.title,
      wf: !!c.wf,
      note: c.note ?? null,
      base: null,
      cur: null,
    })),
  };
  const androidVersion = (await adb('shell', 'getprop', 'ro.build.version.release')).trim();
  for (const side of ['base', 'cur']) {
    const srv = await connect(side === 'base' ? baselineDir : ROOT, {APPIUM_MCP_TOOL_GROUPS: 'all'});
    try {
      if (side === 'base') {
        out.baselineTools = (await srv.tools()).map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema,
        }));
      }
      await home();
      await srv.call('select_device', {platform: 'android'});
      const created = await srv.call('appium_session_management', {
        action: 'create',
        platform: 'android',
        capabilities: caps,
      });
      if (created.isError) {
        throw new Error(`session creation failed on ${side}: ${created.text.slice(0, 200)}`);
      }
      for (const [i, c] of CASES.entries()) {
        const calls = c[side];
        if (!calls) {
          continue;
        }
        if (c.navigates) {
          await home();
        }
        out.cases[i][side] = await runCalls(srv, calls);
        if (c.navigates) {
          await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
          await sleep(2500);
        }
      }
      await srv.call('appium_session_management', {action: 'delete'});
    } finally {
      await srv.close();
    }
  }
  out.meta = {
    captured: new Date().toISOString(),
    baseline: 'upstream appium-mcp v1.99.3 (commit 154ff11)',
    device: `Android ${androidVersion} emulator or device, app com.android.settings`,
    note: 'Outputs are sanitized: session ids, element ids, androidId and carrierName are replaced. Page content is the stock Settings app.',
  };
  mkdirSync(join(ROOT, 'src', 'tests', 'fixtures', 'bench'), {recursive: true});
  writeFileSync(FIXTURE, JSON.stringify(out));
  console.log(`captured ${out.cases.length} cases -> ${FIXTURE}`);
}

// ───────────────────────────── information-loss checks ─────────────────────────────

/** Recall of what an agent needs from a page source: readable strings and clickable controls. */
function pageSourceLoss(fullXml, compactText) {
  const decode = (s) =>
    s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  const grab = (re) => [...fullXml.matchAll(re)].map((m) => decode(m[1]).trim()).filter(Boolean);
  const strings = [...new Set([...grab(/\btext="([^"]*)"/g), ...grab(/\bcontent-desc="([^"]*)"/g)])].filter(
    (s) => s.length > 1,
  );
  const found = strings.filter((s) => compactText.includes(s.length > 60 ? s.slice(0, 60) : s));
  const clickable = (fullXml.match(/clickable="true"/g) ?? []).length;
  const compactClickable = (compactText.match(/\[[a-z]*c[a-z]*\]/g) ?? []).length;
  const ids = [...new Set(grab(/\bresource-id="([^"]*)"/g))];
  const idsKept = ids.filter((s) => compactText.includes(s.length > 200 ? s.slice(0, 200) : s));
  return `readable strings kept ${found.length}/${strings.length}; clickable controls ${compactClickable} listed vs ${clickable} in XML (compact folds a clickable row into its labelled child); ids kept ${idsKept.length}/${ids.length} (ids on non-actionable layout containers are dropped); bounds and hierarchy depth are not kept`;
}

function lossNote(id, base, cur) {
  if (!base || !cur) {
    return '';
  }
  const b = base[0]?.result?.text ?? '';
  const c = cur[0]?.result?.text ?? '';
  switch (id) {
    case 'page-source':
      return pageSourceLoss(b, c);
    case 'locators-all': {
      const m = /"truncated":"(\d+) of (\d+)/.exec(c);
      return m
        ? `shows ${m[1]} of ${m[2]} candidates by design (limit); the rest are one call away`
        : 'all candidates shown';
    }
    case 'device-info': {
      try {
        const bk = Object.keys(JSON.parse(b));
        const ck = Object.keys(JSON.parse(c));
        return `drops fields: ${bk.filter((k) => !ck.includes(k)).join(', ') || 'none'}; per-network detail reduced to type/state/available`;
      } catch {
        return '';
      }
    }
    case 'apps-filter':
      return 'only matching apps are returned, by design; the question asked needs nothing else';
    case 'permissions':
      return 'only matching permission names are returned, by design';
    case 'locator-target':
      return 'returns the matched element with candidates instead of every attribute of the raw element';
    case 'wf-understand':
      return 'a summary (screen type, inputs, buttons, notes) replaces the full tree; it cannot answer questions about elements it did not list';
    case 'wf-open-row':
      return 'returns a diff (+/- lines) of the screen after the action instead of the whole new page source';
    default:
      return '';
  }
}

// ───────────────────────────── report ─────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => String(n).padStart(7);
const pct = (a, b) => (a === 0 ? 'n/a' : `${(((a - b) / a) * 100).toFixed(1)}%`);

async function measureResults(counter, results) {
  let tokens = 0;
  let chars = 0;
  for (const r of results) {
    const callText = `${r.name} ${JSON.stringify(r.args)}`;
    tokens += (await counter.text(callText)) + (await counter.text(r.result.text));
    chars += callText.length + r.result.text.length;
  }
  return {tokens, chars, calls: results.length};
}

async function report() {
  const counter = await makeCounter();
  console.log(`Tokenizer: ${counter.label}`);
  if (!counter.exact) {
    console.log(
      'WARNING: proxy tokenizer. Treat counts as indicative of relative savings, not as Claude token counts.\n',
    );
  }
  if (!existsSync(FIXTURE)) {
    console.error(`Fixtures missing: ${FIXTURE}. Run with --capture on a device first.`);
    process.exit(2);
  }
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  console.log(`Fixtures: captured ${fx.meta.captured}; baseline = ${fx.meta.baseline}; ${fx.meta.device}\n`);
  const result = {
    tokenizer: counter.label,
    exact: counter.exact,
    fixtureCaptured: fx.meta.captured,
    definitions: [],
    cases: [],
    workflows: [],
  };

  // 1. tool definitions
  if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
    console.error('dist/ is missing: run npm run build first.');
    process.exit(2);
  }
  const baseDefs = await counter.tools(fx.baselineTools);
  const configs = [
    ['current: default (unset)', undefined],
    ['current: default,qa', 'default,qa'],
    ['current: default,providers', 'default,providers'],
    ['current: all', 'all'],
    ['current: core,observe,interact', 'core,observe,interact'],
  ];
  console.log('1. Tool definitions sent at the start of every session');
  console.log(`${pad('configuration', 36)}${pad('tools', 7)}${pad('tokens', 9)}${pad('vs upstream', 14)}`);
  console.log(
    `${pad('upstream v1.99.3', 36)}${pad(fx.baselineTools.length, 7)}${pad(baseDefs, 9)}${pad('baseline', 14)}`,
  );
  result.definitions.push({name: 'upstream', tools: fx.baselineTools.length, tokens: baseDefs});
  for (const [label, groups] of configs) {
    const srv = await connect(ROOT, {APPIUM_MCP_TOOL_GROUPS: groups});
    const tools = (await srv.tools()).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    }));
    await srv.close();
    const t = await counter.tools(tools);
    const delta = t - baseDefs;
    console.log(
      `${pad(label, 36)}${pad(tools.length, 7)}${pad(t, 9)}${pad(`${delta >= 0 ? '+' : ''}${delta} (${delta >= 0 ? '+' : '-'}${Math.abs((delta / baseDefs) * 100).toFixed(1)}%)`, 14)}`,
    );
    result.definitions.push({name: label, tools: tools.length, tokens: t, delta});
  }

  // 2. responses and workflows
  console.log('\n2. Context cost of calls (call arguments + result), baseline vs current');
  console.log(
    `${pad('case', 44)}${pad('base', 9)}${pad('current', 9)}${pad('saved', 9)}${pad('%', 8)}info kept / lost`,
  );
  for (const c of fx.cases) {
    if (!c.cur) {
      continue;
    }
    const cur = await measureResults(counter, c.cur);
    if (!c.base) {
      console.log(
        `${pad(c.title.slice(0, 43), 44)}${pad('-', 9)}${pad(cur.tokens, 9)}${pad('-', 9)}${pad('-', 8)}no upstream equivalent (absolute cost only)`,
      );
      result.cases.push({id: c.id, title: c.title, current: cur.tokens, baseline: null});
      continue;
    }
    const base = await measureResults(counter, c.base);
    const saved = base.tokens - cur.tokens;
    const loss = [lossNote(c.id, c.base, c.cur), c.note].filter(Boolean).join(' | ');
    console.log(
      `${pad(c.title.slice(0, 43), 44)}${pad(base.tokens, 9)}${pad(cur.tokens, 9)}${pad(saved, 9)}${pad(pct(base.tokens, cur.tokens), 8)}${loss}`,
    );
    (c.wf ? result.workflows : result.cases).push({
      id: c.id,
      title: c.title,
      baseline: base.tokens,
      current: cur.tokens,
      saved,
      percent: pct(base.tokens, cur.tokens),
      baselineCalls: base.calls,
      currentCalls: cur.calls,
      loss,
    });
  }

  // 3. one-session estimate
  const wf = result.workflows;
  if (wf.length) {
    const b = wf.reduce((s, x) => s + x.baseline, 0);
    const c = wf.reduce((s, x) => s + x.current, 0);
    const defDelta = result.definitions[1].tokens - baseDefs;
    console.log(
      `\n3. Three representative workflows together: baseline ${b}, current ${c}, saved ${b - c} (${pct(b, c)})`,
    );
    console.log(
      `   Definition overhead of the default set vs upstream: ${defDelta >= 0 ? '+' : ''}${defDelta}. Net for one pass through all three workflows: ${b - c - defDelta} tokens (${b - c - defDelta >= 0 ? 'saved' : 'extra'}). Repeating workflows amortises the fixed overhead.`,
    );
    result.workflowTotals = {baseline: b, current: c, definitionDelta: defDelta, net: b - c - defDelta};
  }
  mkdirSync(OUT_DIR, {recursive: true});
  const file = join(OUT_DIR, `token-benchmark-${counter.kind}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`\nresults written to ${file}`);
  console.log(`Tokenizer used: ${counter.label}${counter.exact ? '' : ' (proxy: not Claude counts)'}`);
}

if (flag('capture')) {
  await capture();
} else {
  await report();
}
