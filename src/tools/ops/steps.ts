import {z} from 'zod';

export const stepSchema = z.discriminatedUnion('do', [
  z.object({do: z.literal('tap'), locator: z.string(), waitSec: z.number().min(0).max(60).optional()}),
  z.object({
    do: z.literal('type'),
    locator: z.string(),
    text: z.string(),
    waitSec: z.number().min(0).max(60).optional(),
  }),
  z.object({
    do: z.literal('wait'),
    locator: z.string(),
    until: z.enum(['present', 'gone']).optional(),
    timeoutSec: z.number().min(1).max(120).optional(),
  }),
  z.object({do: z.literal('read'), locator: z.string(), waitSec: z.number().min(0).max(60).optional()}),
  z.object({do: z.literal('back')}),
  z.object({do: z.literal('pause'), ms: z.number().int().min(50).max(5000)}),
]);
export type Step = z.infer<typeof stepSchema>;

/** Replaces typed text with a placeholder when the target looks like a secret field, so recordings never store passwords. */
export function redactStep(step: Step): Step {
  if (step.do === 'type' && /pass(word)?|pwd|secret|token|otp|pin\b|cvv/i.test(step.locator)) {
    return {...step, text: '${SECRET}'};
  }
  return step;
}

export const recordings = new Map<string, Step[]>();
export const recKey = (sessionId?: string) => sessionId ?? 'active';

/** Called by appium_batch after each successful run so steps can be saved. */
export function noteExecutedSteps(sessionId: string | undefined, steps: Step[]): void {
  const k = recKey(sessionId);
  const cur = recordings.get(k);
  if (cur) {
    cur.push(...steps.map(redactStep));
  }
}

/** Renders recorded steps as Java page-object style calls for the user's own framework. Execution is not involved. */
export function toJava(name: string, steps: Step[]): string {
  const q = (s: string) => JSON.stringify(s);
  const loc = (l: string) => {
    const i = l.indexOf('=');
    const k = l.slice(0, i);
    const v = l.slice(i + 1);
    if (k === 'id') {
      return `AppiumBy.id(${q(v)})`;
    }
    if (k === 'desc') {
      return `AppiumBy.accessibilityId(${q(v)})`;
    }
    if (k === 'text') {
      return `AppiumBy.xpath(${q(`//*[@text=${v.includes("'") ? `"${v}"` : `'${v}'`}]`)})`;
    }
    if (k === 'uia') {
      return `AppiumBy.androidUIAutomator(${q(v)})`;
    }
    if (k === 'pred') {
      return `AppiumBy.iOSNsPredicateString(${q(v)})`;
    }
    return `By.xpath(${q(v)})`;
  };
  const body = steps.map((s) => {
    switch (s.do) {
      case 'tap':
        return `        wait.until(ExpectedConditions.elementToBeClickable(${loc(s.locator)})).click();`;
      case 'type':
        return `        wait.until(ExpectedConditions.visibilityOfElementLocated(${loc(s.locator)})).sendKeys(${s.text === '${SECRET}' ? 'System.getenv("SECRET")' : q(s.text)});`;
      case 'wait':
        return s.until === 'gone'
          ? `        wait.until(ExpectedConditions.invisibilityOfElementLocated(${loc(s.locator)}));`
          : `        wait.until(ExpectedConditions.visibilityOfElementLocated(${loc(s.locator)}));`;
      case 'read':
        return `        String value = wait.until(ExpectedConditions.visibilityOfElementLocated(${loc(s.locator)})).getText();`;
      case 'back':
        return '        driver.navigate().back();';
      case 'pause':
        return `        // pause ${s.ms}ms omitted: use an explicit wait instead`;
    }
  });
  const method = name.replace(/[^A-Za-z0-9]/g, '_');
  return `public void ${method}() {\n        WebDriverWait wait = new WebDriverWait(driver, Duration.ofSeconds(15));\n${body.join('\n')}\n    }`;
}
