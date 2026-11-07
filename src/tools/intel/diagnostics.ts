import {analyzeScreen, findNodes} from './engines.js';
import type {Screen} from './screen-model.js';

export interface LogFindings {
  crashes: {process: string; exception: string; line: string}[];
  anrs: string[];
  fatalCount: number;
  networkErrors: string[];
  permissionDenials: string[];
}

const redact = (s: string) =>
  s
    .replace(/(authorization|bearer|token|password|passwd|secret|api[-_]?key)(["'=:\s]+)[^\s"',&]+/gi, '$1$2***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***');

/** Pulls crash, ANR and network signals out of raw logcat text. Pure; never returns raw logs. */
export function parseLogcat(raw: string, appId?: string): LogFindings {
  const lines = raw.split(/\r?\n/);
  const f: LogFindings = {crashes: [], anrs: [], fatalCount: 0, networkErrors: [], permissionDenials: []};
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/FATAL EXCEPTION/.test(l)) {
      f.fatalCount++;
      const proc = lines.slice(i, i + 4).find((x) => /Process: /.test(x));
      const exc = lines.slice(i + 1, i + 8).find((x) => /(Exception|Error)\b/.test(x)) ?? '';
      const process = proc?.split('Process: ')[1]?.split(',')[0] ?? 'unknown';
      if (!appId || process === appId || l.includes(appId)) {
        f.crashes.push({
          process,
          exception: redact(exc.replace(/^.*?E\s+\S+\s*:\s*/, '').trim()).slice(0, 200),
          line: redact(l).slice(0, 160),
        });
      }
    } else if (/ANR in /.test(l)) {
      if (!appId || l.includes(appId)) {
        f.anrs.push(redact(l.replace(/^.*ANR in /, 'ANR in ')).slice(0, 200));
      }
    } else if (
      /UnknownHostException|SocketTimeoutException|ConnectException|SSLHandshakeException|ERR_INTERNET_DISCONNECTED|Unable to resolve host/.test(
        l,
      )
    ) {
      if (f.networkErrors.length < 5) {
        f.networkErrors.push(redact(l.replace(/^.*?[EW]\s+\S+\s*:\s*/, '')).slice(0, 160));
      }
    } else if (/Permission Denial|SecurityException.*permission|requires android\.permission/.test(l)) {
      if (f.permissionDenials.length < 5) {
        f.permissionDenials.push(redact(l).slice(0, 160));
      }
    }
  }
  f.crashes = f.crashes.slice(0, 5);
  f.anrs = f.anrs.slice(0, 5);
  return f;
}

export interface Diagnosis {
  observed: string;
  evidence: string[];
  likelyCauses: {cause: string; confidence: 'high' | 'medium' | 'low'}[];
  nextSteps: string[];
  safeRecovery: string[];
}

export interface DiagnoseInput {
  error?: string;
  locator?: string;
  screen?: Screen;
  logs?: LogFindings;
  appState?: number;
  sessionAlive: boolean;
}

/** Rule-based: every cause cites the evidence that triggered it; nothing is asserted without a signal. */
export function diagnose(i: DiagnoseInput): Diagnosis {
  const ev: string[] = [];
  const causes: Diagnosis['likelyCauses'] = [];
  const steps: string[] = [];
  const rec: string[] = [];
  const err = i.error ?? '';

  if (!i.sessionAlive) {
    ev.push('session did not respond to a lightweight command');
    causes.push({cause: 'Appium session is dead or the driver instrumentation crashed', confidence: 'high'});
    rec.push('delete the session and create a new one (noReset=true to keep app data)');
    steps.push('check device with `adb devices`; force-stop io.appium.uiautomator2.server(.test) if recreating hangs');
  }
  if (i.appState !== undefined) {
    const names: Record<number, string> = {
      0: 'not installed',
      1: 'not running',
      2: 'suspended',
      3: 'background',
      4: 'foreground',
    };
    ev.push(`app state: ${names[i.appState] ?? i.appState}`);
    if (i.appState <= 1 && i.sessionAlive) {
      causes.push({
        cause: 'application is not running (crashed, killed or never launched)',
        confidence: i.logs?.crashes.length ? 'high' : 'medium',
      });
      rec.push('relaunch with appium_app_lifecycle action=activate');
    } else if (i.appState === 3) {
      causes.push({cause: 'app is in background; another app or the launcher is in front', confidence: 'high'});
      rec.push('bring the app to foreground');
    }
  }
  if (i.logs?.crashes.length) {
    ev.push(`${i.logs.crashes.length} fatal exception(s): ${i.logs.crashes[0].exception || i.logs.crashes[0].process}`);
    causes.push({cause: 'app crash (FATAL EXCEPTION in app process)', confidence: 'high'});
    steps.push('attach the crash exception and the steps preceding it to the defect');
  }
  if (i.logs?.anrs.length) {
    ev.push(i.logs.anrs[0]);
    causes.push({cause: 'application not responding (ANR)', confidence: 'high'});
  }
  if (i.logs?.networkErrors.length) {
    ev.push(`network errors in log: ${i.logs.networkErrors[0]}`);
    causes.push({cause: 'backend or connectivity failure may have blocked the screen', confidence: 'medium'});
    steps.push('check device connectivity and the environment URL before retrying');
  }
  if (i.screen) {
    const a = analyzeScreen(i.screen);
    ev.push(`screen: ${a.screenType}, ${a.inputs.length} inputs, ${a.buttons.length} buttons`);
    if (a.dialog) {
      causes.push({cause: 'a dialog/permission prompt is covering the target', confidence: 'high'});
      rec.push('appium_dismiss_interrupts, then retry the step');
    }
    if (a.keyboard) {
      causes.push({
        cause: 'soft keyboard may be covering the target (a tap lands on a key, not the button)',
        confidence: 'medium',
      });
      rec.push('hide keyboard (appium_mobile_keyboard) before tapping near the bottom');
    }
    if (i.locator) {
      const text = i.locator.replace(/^(id|desc|text)=/, '');
      const hits = findNodes(i.screen, {text}, true);
      if (hits.length === 0) {
        ev.push(`no node on the current screen contains "${text}"`);
        causes.push({
          cause: 'target is not on this screen (wrong screen, still loading, or locator changed)',
          confidence: 'medium',
        });
        steps.push('appium_observe to see what is on screen, then appium_locator_intel to rebuild the locator');
      } else if (hits.every((h) => !h.visible)) {
        ev.push(`${hits.length} matching node(s) exist but none are visible`);
        causes.push({cause: 'target exists off-screen or hidden: scroll first', confidence: 'high'});
        rec.push('appium_scroll_until with the same locator');
      } else if (hits.filter((h) => h.visible).length > 1) {
        ev.push(`${hits.filter((h) => h.visible).length} visible matches`);
        causes.push({
          cause: 'locator is ambiguous: the first match may not be the intended element',
          confidence: 'high',
        });
        steps.push('appium_locator_intel on the intended element for a unique locator');
      } else if (!hits[0].enabled) {
        ev.push('target is disabled');
        causes.push({
          cause: 'target present but disabled (precondition not met, e.g. a required field is empty)',
          confidence: 'high',
        });
      }
    }
    if (a.hiddenBelow) {
      ev.push(`${a.hiddenBelow} nodes below the fold`);
    }
  }
  if (/stale|StaleElement/i.test(err)) {
    ev.push('error mentions stale element');
    causes.push({
      cause: 'element was re-rendered after it was found; the cached element id is obsolete',
      confidence: 'high',
    });
    rec.push('re-find the element by locator right before acting (appium_batch does this)');
  }
  if (/timeout|timed out/i.test(err) && !causes.length) {
    causes.push({cause: 'operation exceeded its timeout; no further signal collected', confidence: 'low'});
  }
  if (/no such element|NoSuchElement|could not be located/i.test(err)) {
    ev.push('error: no such element');
  }
  if (/not interactable|ElementNotInteractable|click intercepted/i.test(err)) {
    ev.push('error: element not interactable / click intercepted');
    causes.push({cause: 'another view is on top, or the element is not visible/enabled', confidence: 'medium'});
  }
  if (!causes.length) {
    causes.push({cause: 'no root cause identifiable from the evidence collected', confidence: 'low'});
    steps.push('take a screenshot and compare with appium_ui_diff against a known-good snapshot');
  }
  return {
    observed: err ? err.slice(0, 200) : 'no error text supplied',
    evidence: ev,
    likelyCauses: causes,
    nextSteps: steps,
    safeRecovery: rec,
  };
}

// ───────────────────────── Scenario generation ─────────────────────────

export interface Scenario {
  type: 'positive' | 'negative' | 'boundary' | 'exploratory';
  title: string;
  steps: string[];
  expected: string;
  basis: string;
}

/**
 * Observation-driven scenarios. Expected results that depend on business rules are
 * marked "TO CONFIRM" instead of being invented.
 */
export function generateScenarios(screen: Screen, requirement?: string): Scenario[] {
  const a = analyzeScreen(screen);
  const out: Scenario[] = [];
  const push = (s: Scenario) => out.push(s);
  const TBC = 'TO CONFIRM against requirements';
  const inputs = screen.nodes.filter((n) => n.visible && /EditText|TextField|SearchField|AutoComplete/.test(n.cls));

  for (const n of inputs) {
    const name = n.desc ?? n.text ?? n.id?.split('/').pop() ?? 'input';
    const basis = `input "${name}" observed (${n.id ?? n.cls})`;
    push({
      type: 'positive',
      title: `Enter a valid value in ${name}`,
      steps: [`focus ${name}`, 'type a valid value'],
      expected: `value accepted; ${TBC}`,
      basis,
    });
    push({
      type: 'negative',
      title: `Leave ${name} empty and submit`,
      steps: [`clear ${name}`, 'tap the primary action'],
      expected: `validation behaviour: ${TBC}`,
      basis,
    });
    push({
      type: 'boundary',
      title: `Very long value in ${name}`,
      steps: [`type 256+ characters in ${name}`],
      expected: `limit/truncation behaviour: ${TBC}`,
      basis,
    });
    push({
      type: 'negative',
      title: `Special characters and whitespace in ${name}`,
      steps: [`type "  <>'\\"&%  " in ${name}`],
      expected: `input handled without crash: ${TBC}`,
      basis,
    });
    if (n.password) {
      push({
        type: 'negative',
        title: `${name} is masked`,
        steps: [`type text in ${name}`],
        expected: 'characters are not shown in clear text',
        basis: 'password flag observed',
      });
    }
  }
  for (const b of a.buttons.slice(0, 8)) {
    push({
      type: 'positive',
      title: `Tap "${b}"`,
      steps: [`tap "${b}"`],
      expected: `navigates or acts; ${TBC}`,
      basis: `clickable "${b}" observed`,
    });
  }
  if (a.scrollRegions) {
    push({
      type: 'exploratory',
      title: 'Scroll to the end of the list',
      steps: ['scroll down until content stops changing'],
      expected: `no crash, no duplicate rows, end state reasonable: ${TBC}`,
      basis: 'scrollable container observed',
    });
  }
  push({
    type: 'exploratory',
    title: 'Rotate device and return',
    steps: ['rotate to landscape', 'rotate back'],
    expected: 'screen state preserved, no crash',
    basis: 'generic mobile check',
  });
  push({
    type: 'exploratory',
    title: 'Background and foreground the app',
    steps: ['send app to background 10s', 'bring to foreground'],
    expected: `state preserved or sensible reload: ${TBC}`,
    basis: 'generic mobile check',
  });
  push({
    type: 'negative',
    title: 'Network off while on this screen',
    steps: ['disable network', 'perform the primary action'],
    expected: `clear offline message, no crash: ${TBC}`,
    basis: 'generic mobile check',
  });
  if (requirement) {
    out.forEach((s) => (s.basis += `; requirement supplied: "${requirement.slice(0, 80)}"`));
  }
  return out;
}
