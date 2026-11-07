# Architecture of the additions

Base: upstream appium-mcp 1.99.3 (FastMCP, TypeScript ESM). Everything below is additive. Upstream tool contracts are unchanged except two opt-in parameters and one safety gate (see CHANGELOG.md).

## Layout

```
src/tools/
  efficient/  compact-screen.ts   pure: page-source -> compact lines, diff, locator grammar
              efficient-tools.ts  observe, wait_for, verify_locator, dismiss_interrupts, batch; runSteps()
  intel/      screen-model.ts     pure: XML -> Screen model (Android + iOS trees), xpath count, helpers
              engines.ts          pure: locator scoring, screen analysis, UI diff, a11y audit
              diagnostics.ts      pure: logcat parsing + redaction, failure diagnosis, scenario generation
              intel-tools.ts      screen_intel, locator_intel, ui_diff, a11y_audit, scenarios, diagnose, scroll_until
  ops/        steps.ts            pure: step schema, secret redaction, recorder state, Java export
              recovery.ts         pure: failure classification, bounded retry ledger, safe replacement capabilities
              recover-session.ts  gathers evidence, classifies, replaces a session at most twice per 10 minutes
              ops-tools.ts        session_health, workflow, network_check
  visual/     visual-diff.ts      pure: grid pixel diff -> regions; layout overlap/clipping from the tree
              visual-tools.ts     appium_visual_check
  explore/    explorer.ts         pure: tap classifier (deny list), candidates, overlay detection
              engine.ts           pure: exploration state machine over an ExploreDevice (stop reasons, history, recovery hook)
              explore-tools.ts    appium_explore and the device adapter over the real driver
  safety/     policy.ts           risk class of every operation; trusted automation mode (strict, off by default)
              confirm.ts          single-use, target-bound confirmation tokens
src/providers/
  types.ts          DeviceProvider interface, DeviceInfo, ProviderError
  config.ts         credentials from env, fixed region lists, credential-key rejection
  http.ts           one HTTP helper: timeout, basic auth, bounded body, secret scrubbing
  local.ts          LocalAndroidProvider (adb), LocalIosProvider (simctl, macOS only); allowlisted runner
  lambdatest.ts  browserstack.ts  saucelabs.ts  kobiton.ts      cloud providers
  registry.ts       provider list; session id -> provider map
  connect.ts        cloud session creation; the session store only sees scrubbed capabilities
  provider-tools.ts appium_provider_* and appium_session_overview
src/tool-groups.ts                APPIUM_MCP_TOOL_GROUPS -> existing allowTools policy
```

## Provider layer

* **The core is provider-independent.** Once `appium_provider_session` registers a session in the shared session store, every existing tool works on it unchanged.
* **Credentials flow one way.** A provider reads them from the environment and hands them to the WebDriver client for the single session-creation request (client `user` and `key`, or the vendor options block that vendor requires). They are never given to `setSession`. The store, the listings and the persisted-session file see `scrubCapabilities(...)`, and the hub URL is stored without userinfo.
* **No host comes from user input.** Hubs are constants or fixed region lists. Kobiton's hub is operator-supplied and must be https without userinfo.
* **Isolation.** The registry maps session id to provider, and `appium_provider_finish` only talks to the provider that created the session. Creating a session never closes another. `appium_session_overview` shows which session is active, because tools that omit `sessionId` use it.
* **Local discovery** uses `execFile` with fixed argument arrays (`adb devices -l`, `adb -s <validated serial> shell getprop ...`, `emulator -list-avds`, `xcrun simctl list devices -j`). No shell string is built.
* **Honest capability model.** A provider implements only the optional methods it has a verified endpoint for, and the tools say "no verified API" instead of guessing.

## Data flow

Every new tool resolves the driver through upstream's `resolveDriver(sessionId)`, so session isolation, remote-session rehydration and error shapes are inherited. Read tools call `getPageSource`, parse once into a `Screen`, and run a pure engine over it. Only `appium_batch`, `appium_workflow` replay, `appium_dismiss_interrupts`, `appium_scroll_until`, `appium_explore` and `appium_session_health` with `recover=true` change device or session state.

## Design rules

1. **Pure core, thin tools.** Logic lives in modules with no driver import, so it is unit-testable without a device. Tool files only fetch data and format output.
2. **Uniqueness is measured, not assumed.** Locator candidates are counted against the captured tree; a candidate with zero matches scores 0.
3. **No silent healing.** Nothing substitutes a different element for a failed locator. `appium_batch` warns when it taps the first of several matches.
4. **State-changing actions are bounded.** Batch at most 25 steps, explore at most 40 taps and depth 6, snapshots at most 8, baselines at most 6, confirmation tokens expire in 2 minutes.
5. **Replay executes only the batch vocabulary.** Saved workflow files are re-validated with the same zod schema, so an unknown step type is rejected and a tampered file cannot run a shell command.
6. **Secrets stay out of recordings.** Typed text for locators that look like password, secret, otp, pin or cvv fields is stored as `${SECRET}` and resolved from `APPIUM_MCP_SECRET` at replay.
7. **Evidence before claims.** `appium_diagnose` ties every cause to a signal it observed and says "no root cause identifiable" otherwise.

## Exploration

`appium_explore` is a thin tool over `runExploration` (`explore/engine.ts`). The engine talks only to an `ExploreDevice` (foreground package, snapshot, tap, back, activate, dismiss dialog, screenshot, recover), so every stop reason is reproduced in unit tests with a simulated app, including a control that opens another package inside the app's own task.

* **App boundary.** After every tap the foreground package and the package that owns the page are both checked. Leaving the app is undone with Back first (a foreign activity can sit on top of the app's own task, where relaunching does nothing) and a relaunch second, polling for the transition to finish.
* **Screen identity** is a similarity over readable strings, not an exact hash, so lazily loaded rows do not create new screens.
* **Statuses:** `explored`, `limits` (actions, screens, depth, or an internal iteration ceiling), `app-boundary`, `safety` (everything available is restricted), `device-failure` (session, device or an uncleared dialog), `incomplete` (untried controls remain and the engine cannot get back to them), `error`. A run that ends early is never reported as `explored`.
* **Recovery.** A session-shaped failure triggers at most `maxRecoveries` replacements through the same code as `appium_session_health`. The visited-screen history lives in the engine and is kept.
* **Termination.** A per-screen loading wait, a stuck-Back detector and a global iteration ceiling bound every run.

## Session recovery

`appium_session_health` gathers evidence (adb device state, Appium `/status` for remote sessions, session liveness, app state and foreground, ANR dialog), classifies the failure (`ops/recovery.ts`), and replaces the session only when a new session would help (a dead session or driver). These are reported with what to fix instead of being "recovered": no, offline or unauthorized device; unreachable server; app not running; app in the background; ANR dialog.

Guard rails: owned local sessions only (cloud and attached sessions are never replaced); 2 attempts per session lineage per 10 minutes, and the budget follows the replacement session; `fullReset` is removed from the replacement capabilities; the previously active session stays active; exactly one new session must appear; the new session is verified before success is reported. In-app state (screen, form input, login) is not restored.

## Safety policy

`safety/policy.ts` classifies operations as read-only, reversible or destructive. Destructive operations (app uninstall, clear data, the `fullReset` capability, file push, provider app upload) need a confirmation token that is single-use, expires in two minutes, and is bound to the operation, target and session. Confirmation is on by default.

Trusted automation mode exists for controlled environments. It needs four variables (mode, an explicit operation list, an exact app list, a reason). It is never on by default, `all` and wildcards are rejected, any configuration error leaves confirmation on, and every bypass is logged. The earlier `APPIUM_MCP_ALLOW_DESTRUCTIVE` switch is rejected rather than honoured.

## Platform adapters

There is no separate adapter layer. `parseScreen` detects Android (`<hierarchy>`) and iOS (XCUITest) trees and normalises id, desc, text, rect and flags. Platform-specific actions branch on `getPlatformName`: scroll (`mobile: scrollGesture` vs `mobile: swipe`), logcat (Android only), dismiss built-ins (Android only), network check (Android only). The iOS branches are implemented from the documented tree format and are **not device-verified**.

## Extension points

* New tool: add a module under `src/tools/<area>/`, register it in `src/tools/index.ts`, add the name to `src/tests/tools/tool-names.test.ts`, and add it to a group in `src/tool-groups.ts`.
* New destructive action: add it to `OPERATION_RISK` in `safety/policy.ts` as `destructive`, then call `requireConfirmation(op, target, sessionId, consequence, args.confirmToken)` before executing. The type system only accepts classified destructive operations.
* New workflow step: extend `stepSchema` in `ops/steps.ts` and `runSteps` in `efficient/efficient-tools.ts`.

## Environment variables added

| Variable | Effect |
|---|---|
| `APPIUM_MCP_TOOL_GROUPS` | Unset = default set (the `qa` and `providers` groups are hidden); `all`; `default,qa`; or an exact list of groups |
| `APPIUM_MCP_TRUSTED_MODE`, `_OPS`, `_APPS`, `_REASON` | Trusted automation mode. Needs all four. Skips the confirmation only for the listed operations on the listed apps |
| `APPIUM_MCP_WORKFLOWS_DIR` | Where workflows are saved (default: temp dir) |
| `APPIUM_MCP_SECRET` | Value substituted for `${SECRET}` on replay |
