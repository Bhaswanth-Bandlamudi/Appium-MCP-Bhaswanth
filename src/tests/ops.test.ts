import {describe, expect, test} from '@jest/globals';

import {noteExecutedSteps, recordings, redactStep, stepSchema, toJava} from '../tools/ops/steps.js';

describe('workflow steps', () => {
  test('secret-looking fields are redacted in recordings', () => {
    expect(redactStep({do: 'type', locator: 'id=app:id/password', text: 'hunter2'})).toEqual({
      do: 'type',
      locator: 'id=app:id/password',
      text: '${SECRET}',
    });
    expect(redactStep({do: 'type', locator: 'id=app:id/email', text: 'a@b.com'}).do).toBe('type');
    expect((redactStep({do: 'type', locator: 'id=app:id/email', text: 'a@b.com'}) as {text: string}).text).toBe(
      'a@b.com',
    );
  });
  test('recording captures only while started, and redacts', () => {
    recordings.delete('t');
    noteExecutedSteps('t', [{do: 'tap', locator: 'text=A'}]);
    expect(recordings.has('t')).toBe(false);
    recordings.set('t', []);
    noteExecutedSteps('t', [{do: 'type', locator: 'id=x:id/pwd', text: 'pw'}, {do: 'back'}]);
    expect(recordings.get('t')).toEqual([{do: 'type', locator: 'id=x:id/pwd', text: '${SECRET}'}, {do: 'back'}]);
  });
  test('a saved file with an unknown step type is rejected by the schema', () => {
    expect(stepSchema.safeParse({do: 'shell', command: 'rm -rf /'}).success).toBe(false);
  });
  test('java export uses explicit waits and never embeds a secret', () => {
    const java = toJava('login flow', [
      {do: 'type', locator: 'id=a:id/password', text: '${SECRET}'},
      {do: 'tap', locator: "text=It's ok"},
      {do: 'pause', ms: 500},
    ]);
    expect(java).toContain('public void login_flow()');
    expect(java).toContain('System.getenv("SECRET")');
    expect(java).toContain('elementToBeClickable');
    expect(java).not.toMatch(/Thread\.sleep/);
  });
});
