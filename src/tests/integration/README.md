# Device integration tests

These tests drive the built MCP server against a real Android device or emulator (and, on a Mac, an iOS simulator). They are **not** part of `npm test`: unit tests never need a device, a network or cloud credentials.

| | Unit tests (`npm test`) | Device integration (`npm run test:integration*`) |
|---|---|---|
| Needs a device | no | yes |
| Needs cloud credentials | no | no |
| Runs in the default jest run | yes | no (`jest.config.js` ignores this folder) |
| Where | `src/tests/*.test.ts` | `src/tests/integration/*.integration.test.ts` |

The cloud providers are covered by mocked tests (`providers.test.ts`, `provider-session.test.ts`). **Those are not live provider validation.**

## Run

```
npm ci
npm run build                      # the suite starts dist/index.js
npm run test:integration:android   # or :ios on a Mac; or plain test:integration with INTEGRATION_PLATFORM
```

Before any scenario runs, a **health gate** checks the device. If it fails, every scenario is reported as *skipped* with the reason, nothing is claimed as passed, and a record is written to `integration-results/` (git-ignored). The gate requires:

- exactly one device in state `device` (or `ANDROID_SERIAL` set when several are attached),
- `sys.boot_completed` is `1`,
- no "Application Not Responding" dialog in front,
- at least 600 MB available inside the guest and 1500 MB free on the host.

A starved emulator produces input-dispatch ANRs and hangs, so a "pass" on one means little. Lowering the thresholds is possible (see below) but the record states that an override was used.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `INTEGRATION_PLATFORM` | `android` | `android` or `ios` |
| `RUN_DEVICE_TESTS` | set by the runner | the suite is skipped unless this is `1` |
| `ANDROID_SERIAL` | none | adb serial to use when more than one device is attached |
| `IOS_UDID` | none | simulator UDID (macOS) |
| `INTEGRATION_APP_ID` | `com.android.settings` / `com.apple.Preferences` | app under test (a stock app, so no APK is needed) |
| `INTEGRATION_APP_ACTIVITY` | `.Settings` | Android launch activity |
| `INTEGRATION_MIN_HOST_MB` | `1500` | health gate: free host memory |
| `INTEGRATION_MIN_GUEST_MB` | `600` | health gate: available guest memory (Android) |
| `INTEGRATION_LAUNCH_TIMEOUT_MS` | `120000` | UiAutomator2 server launch timeout |
| `INTEGRATION_CALL_TIMEOUT_MS` | `360000` | per-tool-call timeout |
| `INTEGRATION_RESULTS_DIR` | `./integration-results` | where evidence JSON is written |
| `ANDROID_HOME` | none | SDK location; `adb` must be reachable |

## What the suite checks

1. A session is created and `appium_session_overview` shows exactly one active session.
2. Page source, screenshot and `appium_screen_intel` work, and `mode=compact` is smaller than the full source.
3. An invalid locator and a missing element return errors, not crashes.
4. A destructive operation (`clear`) is blocked without a token and the app is untouched.
5. `appium_explore` **must actually explore**: status `explored` or `limits`, at least 3 screens and 3 taps, history longer than the tap count, no restricted control tapped, exactly one session afterwards and the app back in front. A run that stops after one screen, or for a device reason, **fails**.
6. `appium_explore` with a missing session returns a structured `device-failure`, never plain text.
7. Controls matching a deny word are never tapped.
8. `appium_session_health` reports `healthy` and creates no extra session.
9. Recovery: the UiAutomator2 server is killed; the report-only call diagnoses it and changes nothing; `recover=true` replaces the session exactly once on the same device, restores the app, and the device list is unchanged.
10. Exploration still works after recovery, starting from a relaunched app.
11. Recovery is bounded: repeated failures end in "recovery limit reached". This scenario is last because it leaves the session dead on purpose.

Android only: 9, 10, 11 (they kill the UiAutomator2 server).

## Android setup

1. Android SDK platform-tools and the emulator package; set `ANDROID_HOME`.
2. An emulator with at least 4 GB of RAM assigned and a host with at least 6 GB free, or a physical device with USB debugging authorised.
3. `adb devices` shows exactly one `device`.
4. Clear any "not responding" dialog and leave the home screen showing.

Headless emulator used for development:

```
emulator -avd <name> -no-window -no-audio -no-snapshot -gpu swiftshader_indirect -memory 2048 -cores 2
```

## iOS setup (macOS only)

Requires macOS, Xcode with an iOS simulator runtime, Xcode command line tools, and Node `^20.19`, `^22.12` or `>=24` (the XCUITest driver's requirement). The XCUITest driver and WebDriverAgent are installed by `npm ci` as dependencies of this package; no separate Appium server is needed.

```
scripts/ios-validate.sh                  # checks prerequisites, boots a simulator if needed, runs the suite
IOS_UDID=<udid> scripts/ios-validate.sh  # a specific simulator
```

The first session builds WebDriverAgent for the simulator and can take several minutes; if it times out set `INTEGRATION_LAUNCH_TIMEOUT_MS=300000`. The recovery scenarios are skipped on iOS (they target the Android driver process).

**Status: not executed.** No Mac was available when this was written, so iOS is implemented and reviewed but not validated. A green run of the script on a Mac is the evidence that is missing; attach `integration-results/integration-ios-*.json` when reporting it.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| All scenarios skipped, reason mentions host memory | host short of RAM | close applications, or lower `INTEGRATION_MIN_HOST_MB` knowing results are weaker |
| Skipped: "Application Not Responding" | emulator starved | restart it with more memory; do not run on it |
| `The instrumentation process cannot be initialized` | slow start | raise `INTEGRATION_LAUNCH_TIMEOUT_MS`; force-stop `io.appium.uiautomator2.server*` and retry |
| `MCP error -32001: Request timed out` | host or emulator too slow | raise `INTEGRATION_CALL_TIMEOUT_MS`; free memory |
| `Unknown tool: appium_...` | tool group not registered | the suite sets `APPIUM_MCP_TOOL_GROUPS=all`; if you call tools yourself, add `qa` or `providers` to the list |
| `dist/index.js not found` | not built | `npm run build` |

## Token benchmark fixtures

`npm run bench:tokens` reads `src/tests/fixtures/bench/captured.json`. To re-capture it from a device, build the upstream baseline once and run `npm run bench:tokens -- --capture --baseline-dir <dir>`:

```
mkdir ../appium-mcp-baseline
git archive 154ff11 | tar -x -C ../appium-mcp-baseline      # 154ff11 = upstream v1.99.3
cd ../appium-mcp-baseline && npm ci && npm run build && cd -
npm run bench:tokens -- --capture --baseline-dir ../appium-mcp-baseline
```

Fixtures are sanitised (session ids, element ids, `androidId`, `carrierName` replaced) and contain only stock-Settings content.
