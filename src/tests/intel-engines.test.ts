import {describe, expect, test} from '@jest/globals';

import {diagnose, generateScenarios, parseLogcat} from '../tools/intel/diagnostics.js';
import {analyzeScreen, auditAccessibility, diffScreens, findNodes, locatorCandidates} from '../tools/intel/engines.js';
import {parseScreen} from '../tools/intel/screen-model.js';

const login = `<hierarchy rotation="0">
<android.widget.FrameLayout bounds="[0,0][1080,2400]"><android.widget.FrameLayout bounds="[0,0][1080,2400]">
<android.widget.EditText resource-id="app:id/email" text="" clickable="true" bounds="[100,300][980,420]"/>
<android.widget.EditText resource-id="app:id/pwd" password="true" text="" clickable="true" bounds="[100,450][980,570]"/>
<android.widget.Button resource-id="app:id/signin" text="Sign in" clickable="true" bounds="[100,700][980,820]"/>
<android.widget.Button text="Sign in" clickable="true" bounds="[100,900][980,1000]"/>
<android.widget.ImageView clickable="true" bounds="[0,0][40,40]"/>
<android.widget.TextView resource-id="abc.textComponent.$357.50" text="$357.50" bounds="[0,1000][300,1100]"/>
<android.widget.Button text="Far below" clickable="true" bounds="[100,3000][980,3100]"/>
</android.widget.FrameLayout></android.widget.FrameLayout></hierarchy>`;

describe('screen model + locators', () => {
  const s = parseScreen(login);
  test('analysis', () => {
    const a = analyzeScreen(s);
    expect(a.screenType).toBe('login/credential form');
    expect(a.hiddenBelow).toBe(1);
    expect(a.inputs.some((i) => i.includes('[password]'))).toBe(true);
  });
  test('unique id beats ambiguous text; dynamic id is penalised', () => {
    const btn = findNodes(s, {id: 'signin'})[0];
    const c = locatorCandidates(s, btn);
    expect(c[0].short).toBe('id=app:id/signin');
    expect(c[0].matches).toBe(1);
    const text = c.find((x) => x.short === 'text=Sign in')!;
    expect(text.matches).toBe(2);
    expect(text.score).toBeLessThan(c[0].score);
    const price = findNodes(s, {text: '357'})[0];
    expect(locatorCandidates(s, price)[0].notes.join()).toMatch(/value-dependent/);
  });
  test('a11y flags unlabeled image control', () => {
    expect(
      auditAccessibility(s).some((i) => i.rule === 'unlabeled-control' || i.rule === 'image-control-no-label'),
    ).toBe(true);
  });
});

describe('diff', () => {
  test('added, text and state changes', () => {
    const a = parseScreen(login);
    const b = parseScreen(
      login
        .replace(
          'text="Sign in" clickable="true" bounds="[100,900]',
          'text="Log in" clickable="true" bounds="[100,900]',
        )
        .replace(
          '</android.widget.FrameLayout></android.widget.FrameLayout></hierarchy>',
          '<android.widget.TextView text="Error!" bounds="[0,1200][100,1300]"/></android.widget.FrameLayout></android.widget.FrameLayout></hierarchy>',
        ),
    );
    const d = diffScreens(a, b);
    expect(d.added.some((x) => x.includes('Error!'))).toBe(true);
    expect(d.textChanged.join()).toMatch(/Sign in.*Log in/);
  });
});

describe('diagnostics', () => {
  const logcat = `E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: Process: com.copart.membermobile, PID: 123
E AndroidRuntime: java.lang.NullPointerException: token=abc123secret
W System: ANR in com.copart.membermobile (x)
W Net: java.net.UnknownHostException: Unable to resolve host "api.example.com"`;
  test('logcat parsing is scoped and redacted', () => {
    const f = parseLogcat(logcat, 'com.copart.membermobile');
    expect(f.crashes).toHaveLength(1);
    expect(f.crashes[0].exception).not.toMatch(/abc123secret/);
    expect(f.anrs).toHaveLength(1);
    expect(f.networkErrors).toHaveLength(1);
    expect(parseLogcat(logcat, 'other.app').crashes).toHaveLength(0);
  });
  test('dead session is high confidence; no signal is low confidence', () => {
    expect(diagnose({sessionAlive: false}).likelyCauses[0].confidence).toBe('high');
    expect(diagnose({sessionAlive: true}).likelyCauses[0].confidence).toBe('low');
  });
  test('ambiguous and hidden targets are identified from the screen', () => {
    const s = parseScreen(login);
    expect(
      diagnose({sessionAlive: true, screen: s, locator: 'text=Sign in'})
        .likelyCauses.map((c) => c.cause)
        .join(),
    ).toMatch(/ambiguous/);
    expect(
      diagnose({sessionAlive: true, screen: s, locator: 'text=Far below'})
        .likelyCauses.map((c) => c.cause)
        .join(),
    ).toMatch(/off-screen/);
  });
  test('scenarios never invent expected results', () => {
    const sc = generateScenarios(parseScreen(login));
    expect(sc.some((x) => x.type === 'boundary')).toBe(true);
    expect(sc.filter((x) => x.type !== 'exploratory' || true).every((x) => x.basis.length > 0)).toBe(true);
    expect(sc.find((x) => x.title.startsWith('Leave'))!.expected).toMatch(/TO CONFIRM/);
  });
});
