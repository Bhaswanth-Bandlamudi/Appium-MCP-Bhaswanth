# New tools (added on top of upstream appium-mcp 1.99.3)

## Which tools are registered

Every registered tool's definition is sent to the model each session, so what is registered is a context cost. `APPIUM_MCP_TOOL_GROUPS` controls it:

| Setting | Registers |
|---|---|
| unset (default) | all upstream tools plus the core additions (groups `core`, `observe`, `interact`, `locators`, `device`, `advanced`, `ios`): 40 tools |
| `default,qa` | default plus `appium_scroll_until`, `appium_dismiss_interrupts`, `appium_ui_diff`, `appium_a11y_audit`, `appium_scenarios`, `appium_visual_check`, `appium_network_check`, `appium_explore`, `appium_workflow` |
| `default,providers` | default plus the `appium_provider_*` tools and `appium_session_overview` |
| `all` | every tool (56) |
| e.g. `core,observe` | exactly those groups |

A misspelt group name is an error at startup, never a silent omission. Tools outside any group (`appium_ai`, documentation and skills tools, plugin tools) keep their own feature flags.

## Safety: confirmation and trusted automation mode

Destructive operations need a `confirmToken`: `app.uninstall`, `app.clear`, `session.fullReset`, `file.push` (`appium_mobile_file push`) and `provider.upload` (`appium_provider_upload_app`). The first call changes nothing and returns a single-use token valid for two minutes and bound to the operation, target and session. Read-only and reversible operations are not affected. Confirmation is on by default.

Trusted automation mode is for controlled environments only, such as a CI job on a throwaway emulator. It is off unless all four variables are set and valid: `APPIUM_MCP_TRUSTED_MODE=on`, `APPIUM_MCP_TRUSTED_OPS` (an explicit list; `all` is rejected), `APPIUM_MCP_TRUSTED_APPS` (exact ids; wildcards are rejected), `APPIUM_MCP_TRUSTED_REASON` (at least 8 characters). It then skips the confirmation only for the listed operations on the listed apps, and logs each bypass. A mistake in any value leaves confirmation on. The earlier `APPIUM_MCP_ALLOW_DESTRUCTIVE` switch is no longer supported and is rejected with an error. A tool description is not a safeguard; the check is in code.

Upstream tools are documented in README.md. All tools below use the active session unless `sessionId` is given. Verified live on an Android emulator (see IMPLEMENTATION_STATUS.md). iOS paths are implemented from the XCUITest tree format and are **not device-verified**.

**Short locator grammar** (used by tools marked ✱): `id=<resource-id>`, `desc=<content-desc / accessibility id>`, `text=<exact text>`, `xpath=...`, `uia=...` (Android), `pred=...` (iOS).

| Tool | Class | Purpose | Key inputs | Output | Android / iOS |
|---|---|---|---|---|---|
| `appium_observe` | read-only | One line per on-screen element: class, id, desc, text, flags, centre point. `diff=true` returns only changes since the last observe | `diff`, `includeText`, `limit` | text lines | A ✓ / iOS unverified |
| `appium_wait_for` ✱ | read-only | Poll until a locator is present or gone | `locator`, `until`, `timeoutSec` | `ok ... waited=Nms` or error | A ✓ / iOS unverified |
| `appium_verify_locator` ✱ | read-only | Live match count per locator: UNIQUE / AMBIGUOUS / ABSENT | `locators[]` | one line each | A ✓ / iOS unverified |
| `appium_dismiss_interrupts` ✱ | state-changing (taps Deny / negative buttons only) | Loop-dismiss permission denials and Android alert negative buttons (e.g. passkey NOT NOW) plus extra locators | `extraLocators`, `maxRounds` | list dismissed | Android only for built-in list |
| `appium_batch` ✱ | state-changing | Up to 25 steps (tap, type, wait, read, back, pause) in one call with per-step results and a screen diff | `steps[]`, `observeAfter`, `stopOnError` | per-step lines + diff | A ✓ / iOS unverified |
| `appium_screen_intel` | read-only | Classify the screen, summarise inputs/buttons/navigation, keyboard and dialog state, below-the-fold count, next actions. Optionally saves a named snapshot | `verbosity`, `snapshot` | JSON | A ✓ / iOS unverified |
| `appium_locator_intel` | read-only | Find targets by description; return validated candidates with match count, 0-100 stability score, warnings, `safeToUse` | `text`, `id`, `clickable`, `input`, `includeHidden`, `limit`, `verbosity` | JSON | A ✓ / iOS unverified |
| `appium_ui_diff` | read-only | Diff saved snapshot vs snapshot or live screen: added, removed, text, state, moved | `from`, `to`, `limit` | JSON | A ✓ / iOS unverified |
| `appium_a11y_audit` | read-only | Static accessibility findings from the UI tree. Not a TalkBack/VoiceOver run | `minTargetPx` | JSON | A ✓ / iOS unverified |
| `appium_scenarios` | read-only | Positive / negative / boundary / exploratory scenarios from what is on screen. Business-rule expectations are `TO CONFIRM` | `requirement` | JSON | A ✓ / iOS unverified |
| `appium_diagnose` | read-only | After a failure: session liveness, app state, screen state, logcat crash/ANR/network signals → evidence, causes with confidence, next steps, safe recovery. Never retries | `error`, `locator`, `appId`, `includeLogs` | JSON | Android logs only; iOS gets screen/app-state checks |
| `appium_scroll_until` | state-changing (scroll position) | Scroll until target visible; stops when the page stops changing | `locator` (id/text/desc), `direction`, `maxScrolls` | JSON | A: scrollGesture; iOS: swipe, unverified |
| `appium_session_health` | state-changing only with `recover=true` | Diagnoses a session from device state (adb), Appium server (remote), liveness, app state, foreground and ANR dialog. Returns the failure kind, signals, and whether a new session would help. `recover=true` replaces the session only for a dead session or driver: 2 attempts per 10 minutes, one new session verified, `fullReset` removed, other sessions untouched, app relaunched. Cloud and attached sessions are never replaced | `recover`, `appId`, `detail` | JSON report (original session, failure, attempted, result, new session id, app restored, limitations) | A: verified live on an emulator incl. driver kill and the retry limit / iOS: classifier unit-tested, not device-verified |
| `appium_workflow` | state-changing on replay | `start`/`stop` record `appium_batch` steps, `list`/`show`, `replay` in one call, `export_java` renders Java with explicit waits. Secret-looking fields are stored as `${SECRET}` | `action`, `name` | text/JSON | A ✓ live / iOS unverified |
| `appium_network_check` | read-only | Android connectivity (airplane, Wi-Fi, data) and optional host reachability from the device, with a verdict. No traffic inspection | `host` | JSON | Android only |
| `appium_visual_check` | read-only (in-memory baselines) | `baseline`/`compare` report changed screen regions (x,y,w,h, % pixels) instead of images; `layout` finds overlapping or clipped elements from the tree | `action`, `name`, `width`, `tolerance` | JSON | A ✓ live / iOS unverified |
| `appium_explore` | state-changing | Bounded breadth-first exploration of one app: taps unseen labelled controls (never inputs, never deny-list words such as delete, pay, bid, submit, log out), detects and undoes leaving the app (Back, then relaunch), clears permission and ANR dialogs, keeps visited-screen history, recovers a dead session without losing it, captures screenshots. Status is one of `explored`, `limits`, `app-boundary`, `safety`, `device-failure`, `incomplete`, `error`; errors are always structured JSON | `appId`, `goal`, `maxSteps`, `maxDepth`, `maxScreens`, `maxScreenshots`, `allowRecovery`, `denyWords`, `allowOnly` | JSON report: status, detail, counts, screens (id, type, depth, parent, via), unexplored, safety-skipped, boundary controls, history, evidence paths | A: verified live on Android (Settings app): several screens, boundary exits undone; engine covered by 31 simulated-app tests / iOS not verified. Opt-in group `qa` |

## Connectivity tools (local and cloud providers)

Credentials come from environment variables only and never appear in output. Per-provider setup and verification status: [DEVICE_CONNECTIVITY_GUIDE.md](DEVICE_CONNECTIVITY_GUIDE.md).

| Tool | Class | Purpose | Key inputs | Provider support |
|---|---|---|---|---|
| `appium_provider_list` | read-only | Providers, whether configured, missing variable **names**, whether this host can run it | none | all |
| `appium_provider_devices` | read-only | adb devices (ready, offline, unauthorized, with fixes) and defined AVDs; iOS simulators (macOS); or the cloud catalogue. `verbosity=minimal` gives one line per device | `provider`, `platform`, `name`, `osVersion`, `limit`, `verbosity` | local-android live-verified; local-ios, LambdaTest, BrowserStack, Sauce not live-verified; Kobiton has no listing |
| `appium_provider_check` | read-only | Connectivity diagnosis with next steps; for clouds an authenticated read-only call | `provider` | all (Kobiton checks configuration only) |
| `appium_provider_upload_app` | state-changing, third party | Upload .apk/.aab/.xapk/.ipa and return the provider app reference. The first call needs a confirmation token | `provider`, `path` | LambdaTest, BrowserStack, Sauce (not live-verified) |
| `appium_provider_session` | state-changing | Create a cloud session from environment credentials and make it active. Does not close other sessions. No credentials in the result or the stored metadata | `provider`, `platform`, `deviceName`, `osVersion`, `app`, `build`, `name`, `tunnelName`, `extraCapabilities` | LambdaTest, BrowserStack, Sauce, Kobiton. Verified against a local fake hub, not the real clouds |
| `appium_provider_finish` | state-changing (cloud side) | Provider details for a session and optional pass/fail, routed only to the provider that created it | `sessionId`, `passed`, `reason` | BrowserStack and Sauce record status; LambdaTest and Kobiton do not |
| `appium_session_overview` | read-only | All sessions with provider, platform, device, and which is active | none | all; verified live |

## Limits worth knowing

- Match counts come from the tree captured at call time. Re-verify after navigation.
- `appium_batch` taps the first match and warns when there are several; use `appium_verify_locator` first for anything ambiguous.
- Snapshots are kept in memory per session (max 8) and are lost when the MCP process restarts.
- Redaction in `appium_diagnose` covers tokens, passwords, api keys and e-mail addresses in log lines; it is pattern-based, not a guarantee.

## Changed upstream tools

| Tool | Change |
|---|---|
| `appium_app_lifecycle` | `uninstall` and `clear` need `confirmToken` (first call returns CONFIRMATION REQUIRED with a single-use token bound to operation, target and session, valid 2 minutes). Confirmation stays on unless trusted automation mode covers that operation and app (see Safety below) |
| `appium_mobile_file` | `push` needs `confirmToken` (it overwrites files on the device). `pull` is unchanged |
| `appium_session_management` | `create` with a `fullReset` capability (any spelling, including `appium:options` and string booleans) needs `confirmToken`, because it uninstalls the app and erases its data |
| `appium_get_page_source` | New optional `mode=compact` (about 97% smaller on Settings) |
| `generate_locators` | New optional `limit` with a `truncated` note |
| `appium_mobile_device_info` | Compact JSON; `verbosity=minimal` for `info` (276 vs 1,032 characters measured) |
| `appium_app_lifecycle` `list` | Compact JSON, `appName` omitted when equal to the package id, new `filter` and `limit` (14,569 characters by default vs 32,338 before; 420 with a filter) |
| `appium_mobile_permissions` `get` | Compact JSON; new `grep` for Android permission names (76 characters with `grep=CAMERA` vs 13,820) |
