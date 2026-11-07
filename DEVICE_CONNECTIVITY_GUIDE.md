# Device connectivity guide

How to connect this MCP to local devices, simulators and cloud device providers. Each section says what is **implemented and live-verified**, **implemented but not live-verified**, or **documentation only**. Provider facts were read from the official pages listed under each provider on 2026-11-05; vendors change APIs, so re-check before relying on them.

## Status at a glance

| Environment | Status |
|---|---|
| Local Android emulator (this Windows machine) | Implemented, **live-verified** |
| Local Android physical device | Implemented (same code path as the emulator; parser and fixes unit-tested), **not live-verified** (no phone was attached) |
| Local iOS simulator | Implemented for macOS, **not verified** (no Mac) |
| Local iOS physical device | **Documentation only**: devices are not enumerated by this server |
| LambdaTest | Implemented, **not live-verified** (no account); session status/logs/video are **not implemented** (endpoints not verified) |
| BrowserStack | Implemented, **not live-verified** |
| Sauce Labs | Implemented, **not live-verified**; response shapes for the device list are read defensively because they were not fully visible in the docs |
| Kobiton | **Partial**: you must supply the hub URL; no device list, upload or status calls |
| Firebase Test Lab | **Not supported**: it has no Appium endpoint (see its section) |
| Other clouds | Documentation only (see section K) |

## A. Architecture

```
AI agent ── MCP ──> appium-mcp (this server)
                      ├─ provider tools (appium_provider_*): discover, check, upload, create cloud sessions
                      ├─ local path: select_device + appium_session_management (embedded UiAutomator2 / XCUITest driver)
                      └─ every other appium_* tool acts on the ACTIVE session, local or cloud
Cloud hub (HTTPS, W3C WebDriver) <── WebDriver client ── session store ── tools
```

* **Local** sessions run Appium's UiAutomator2/XCUITest driver inside this process. No separate Appium server is needed.
* **Cloud** sessions use the hub of the provider; the provider owns the device and Appium server.
* A **provider** (`src/providers/`) knows one vendor's endpoints, credentials variables, capability names and app upload. The core tools never see vendor details.
* A session remembers which provider created it. Provider-specific calls (`appium_provider_finish`) are routed only to that provider.
* Creating a cloud session makes it **active** and does not close any other session. Call `appium_session_overview` to see which is active; pass `sessionId` explicitly when more than one is open.

Typical flow: `appium_provider_list` -> `appium_provider_devices` -> (`appium_provider_upload_app`) -> `appium_provider_session` -> any `appium_*` tool -> `appium_provider_finish` -> `appium_session_management action=delete`.

## B. Prerequisites

* Node.js 22 or newer.
* Android: Android SDK platform-tools (adb), set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`). For emulators also the `emulator` package and an AVD.
* iOS (local): macOS, Xcode with a simulator runtime, Xcode command line tools. Not possible on Windows or Linux.
* Cloud: an account with the provider and its username and access key.
* This repository built (`npm ci`, `npm run build`). If `npm ci` is killed for low memory on a small machine, run it with `NODE_OPTIONS=--max-old-space-size=1024` and `--maxsockets=3`.

## C. Local Android emulator

1. Install Android Studio. In SDK Manager install **Android SDK Platform-Tools**, **Emulator** and a system image.
2. Set `ANDROID_HOME` (Windows: `C:\Users\<you>\AppData\Local\Android\Sdk`).
3. Create an AVD in Device Manager, or list existing ones: `%ANDROID_HOME%\emulator\emulator.exe -list-avds`.
4. Start it. Headless (needs ~2 GB RAM): `emulator -avd <name> -no-window -no-audio -no-snapshot -gpu swiftshader_indirect`.
5. Wait until `adb shell getprop sys.boot_completed` prints `1`.
6. In the MCP: `appium_provider_check provider=local-android`, then `appium_provider_devices provider=local-android`. An emulator that is not running does not appear as a device; the tool names defined AVDs in a note.
7. Create the session: `select_device platform=android`, then `appium_session_management action=create platform=android capabilities={"appium:app":"<path to apk>"}`. To drive an app that is already installed use `appium:appPackage` and `appium:appActivity` instead of `appium:app`.

Troubleshooting: `adb` not found -> set `ANDROID_HOME` or add platform-tools to PATH. Device `offline` -> `adb kill-server && adb start-server`. Session creation fails with "Appium Settings is not running" -> force-stop `io.appium.settings`, `io.appium.uiautomator2.server` and `io.appium.uiautomator2.server.test`, then retry; this is a known flake on a freshly created emulator. `platformVersion` in your capabilities must match the device.

## D. Physical Android device

1. On the phone: Settings > About phone > tap Build number 7 times; then Developer options > enable **USB debugging**.
2. Connect by USB and accept the "Allow USB debugging?" prompt on the phone. Only a person can do this.
3. `adb devices -l` must show the serial as `device`. `unauthorized` means the prompt was not accepted; `offline` means reconnect.
4. `appium_provider_devices provider=local-android` lists it with state and, when not ready, the fix. Use the serial as `deviceUdid` in `select_device`.
5. Several devices: pass `deviceUdid` explicitly. Every adb call this server makes is scoped with `-s <serial>`.

## E. Local iOS simulator (macOS only)

Requires macOS, Xcode (with a simulator runtime), and Xcode command line tools. `appium_provider_check provider=local-ios` runs `xcrun simctl`. On any other OS it returns an explicit "unsupported" reason.

Upstream tools handle the rest: `prepare_ios_simulator` boots a simulator and installs/launches WebDriverAgent, then `appium_session_management action=create platform=ios`. **This path was not run here (no Mac).**

## F. Physical iOS device

Needs macOS and Xcode, a device with Developer Mode on and the computer trusted, and a provisioning profile to sign WebDriverAgent. Upstream's `appium_prepare_ios_real_device` lists `.mobileprovision` profiles and builds a signed WebDriverAgent. **Not run here and not enumerated by `appium_provider_devices`.** From Windows, local iOS automation is **not possible**; use a cloud provider or a remote Appium server on a Mac (`remoteServerUrl` in `appium_session_management`).

## G. LambdaTest (TestMu AI) — implemented, not live-verified

Variables: `LAMBDATEST_USERNAME`, `LAMBDATEST_ACCESS_KEY`; optional `LAMBDATEST_REGION` (`us`, `eu`, `ap`) for the device list.

* Hub used: `https://mobile-hub.lambdatest.com/wd/hub`. Credentials are passed to the WebDriver client, never placed in capabilities or the URL.
* Device list: `GET mobile-api.lambdatest.com/mobile-automation/api/v1/list?region=<r>`. Per-device availability is not provided.
* App upload: `POST manual-api.lambdatest.com/app/upload/realDevice` with form fields `appFile` and `name`; reference the result as `lt://...`. The exact JSON key of the reference was not documented, so the first `lt://` value in the response is used.
* Capabilities set: `platformName`, `deviceName`, `platformVersion`, `isRealMobile=true`, `app`, `build`, `name`, and for tunnels `tunnel=true` plus `tunnelName`. The docs show these as top-level keys; the `lt:options` block name was **not** confirmed, so it is not used. Pass anything else through `extraCapabilities`.
* Tunnel: this server never starts or stops one. Start the LambdaTest tunnel yourself (`LT` binary, flags `--user`, `--key`, `--tunnelName`) and pass the same name as `tunnelName`. Whether a mobile session selects the tunnel exactly this way is not confirmed for App Automate in the pages read.
* **Not implemented:** session pass/fail status, logs, video and screenshots (endpoints not seen in the docs). End the session with `appium_session_management action=delete`; view results in the dashboard.

Official docs: https://www.testmuai.com/support/docs/appium-java/ , https://www.testmuai.com/support/docs/desired-capabilities-in-appium/ , https://www.testmuai.com/support/docs/app-testing-apis.md

## H. BrowserStack — implemented, not live-verified

Variables: `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY`.

* Hub: `https://hub.browserstack.com/wd/hub` (the host on the official getting-started page). Credentials go in `bstack:options` (`userName`, `accessKey`).
* Upload: `POST api-cloud.browserstack.com/app-automate/upload` (field `file`); returns `app_url` (`bs://...`). Apps are kept 30 days.
* Devices: `GET /app-automate/devices.json`; no live availability, so a session request can still queue.
* Session details and pass/fail: `GET` and `PUT /app-automate/sessions/{id}.json` (`status` passed/failed, `reason`). Wired to `appium_provider_finish`.
* Local testing: set `tunnelName` to enable `bstack:options.local=true` and `localIdentifier`. You start `BrowserStackLocal` yourself. Omitting a unique identifier can cut an existing Local connection per a search snippet that was **not** confirmed on a page.
* Appium 2 rules: vendor capabilities need the `appium:` prefix; BrowserStack capabilities outside `bstack:options` are ignored.

Official docs: https://www.browserstack.com/docs/app-automate/api-reference/appium/apps , https://www.browserstack.com/docs/app-automate/api-reference/appium/sessions , https://www.browserstack.com/docs/app-automate/api-reference/appium/devices , https://www.browserstack.com/app-automate/capabilities?tag=w3c

## I. Sauce Labs — implemented, not live-verified

Variables: `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY`; optional `SAUCE_REGION` in `us-west-1` (default), `us-east-4`, `eu-central-1`, `asia-south-2`. The region is chosen from this fixed list only, so a variable cannot redirect your credentials to another host.

* Hub: `https://ondemand.<region>.saucelabs.com/wd/hub`; credentials in `sauce:options` (`username`, `accessKey`).
* Upload: `POST api.<region>.saucelabs.com/v1/storage/upload` (multipart `payload`, `name`); reference with `storage:filename=<name>`.
* Devices: `GET /v1/rdc/devices` and `/v1/rdc/devices/status` (AVAILABLE, IN_USE, CLEANING, MAINTENANCE, REBOOTING, OFFLINE).
* Job details and pass/fail: `GET` and `PUT /v1/rdc/jobs/{id}`.
* Tunnel: `tunnelName` maps to `sauce:options.tunnelName`. Sauce Connect start flags were **not** verified; start it yourself.
* iOS real devices may need `resigningEnabled` in `sauce:options` (from a search summary, unverified): pass it through `extraCapabilities`.

Official docs: https://docs.saucelabs.com/basics/data-center-endpoints/ , https://docs.saucelabs.com/mobile-apps/automated-testing/appium/real-devices/ , https://docs.saucelabs.com/dev/api/storage/ , https://docs.saucelabs.com/dev/api/rdc/

## J. Kobiton — partial

Variables: `KOBITON_USERNAME`, `KOBITON_API_KEY`, and **`KOBITON_HUB_URL`** (https, no credentials; take it from your Kobiton account documentation). This server does not guess the hub.

* Capabilities set: `appium:username`, `appium:accessKey`, `appium:deviceName` (wildcards are a Kobiton feature), `appium:app` (`kobiton-store:<id>` or https URL), `kobiton:sessionName`.
* **Not implemented:** device list, app upload, session status, tunnels (no verified endpoints). `appium_provider_check` validates configuration only, not the key. Docs pages were inconsistent about `kobiton:app` versus `app`, so verify against your account.

Official docs: https://docs.kobiton.com/automation-testing/capabilities/available-capabilities

## K. Other providers

* **Firebase Test Lab**: no Appium-compatible endpoint. Its FAQ says Appium is not supported; it runs Robo, Instrumentation (Espresso), Game Loop and XCTest. It cannot be a provider here. Source: https://firebase.google.com/docs/test-lab/troubleshooting
* **TestingBot** (read from official storage docs, **not implemented**): hub `https://hub.testingbot.com/wd/hub` (from a search snippet, unverified), upload `POST https://api.testingbot.com/v1/storage` returns `app_url` (`tb://...`).
* HeadSpin, pCloudy, Perfecto, Experitest: **not researched**.

Anything with a standard W3C Appium hub can already be used without code: call `appium_session_management action=create` with `remoteServerUrl` (credentials in the URL userinfo are redacted in logs) and the provider's capabilities.

## L. Adding a provider

1. Create `src/providers/<name>.ts` implementing `DeviceProvider` (`src/providers/types.ts`): `status()`, `check()`, `listDevices()`, and for clouds `buildSession()` plus optional `uploadApp`, `setSessionStatus`, `sessionDetails`.
2. Read credentials with `readCreds` / `cloudStatus` in `config.ts`; add the variable names to `CLOUD_ENV`. Choose any region from a fixed list (`pickRegion`).
3. Use `requestJson` from `http.ts` for every HTTP call (timeout, basic auth, scrubbed errors).
4. Call `assertNoCredentialCaps(request.extraCapabilities)` in `buildSession`.
5. Register in `registry.ts` and add the id to `ProviderId`.
6. Add unit tests like `src/tests/providers.test.ts`, including one that proves the key never appears in errors.
7. Only implement an endpoint after reading it on the vendor's official page. Mark anything unverified in the file header and in this guide.

## M. MCP client configuration

Claude Code, user scope, local Android only:

```
claude mcp add appium-mcp -s user -e ANDROID_HOME="C:\Users\you\AppData\Local\Android\Sdk" -e NO_UI=true -- node "<path>\dist\index.js"
```

Add cloud credentials as `-e BROWSERSTACK_USERNAME=... -e BROWSERSTACK_ACCESS_KEY=...` (see `.env.example`). The cloud provider tools are an opt-in group, so enable them with `-e APPIUM_MCP_TOOL_GROUPS=default,providers` (add `qa` for exploration, workflows and visual checks, or use `all`). Other MCP clients take the same command and environment in their server configuration. Run `claude mcp list` from PowerShell if the Git Bash shim fails.

## N. Troubleshooting

| Symptom | Cause | Check / fix |
|---|---|---|
| `adb executable not found` | ANDROID_HOME unset | Set it, or put platform-tools on PATH |
| device `unauthorized` | USB prompt not accepted | Unlock the phone, accept, `adb devices` |
| device `offline` | stale adb | `adb kill-server && adb start-server`, reconnect |
| `not-configured` with variable names | credentials missing | Export the named variables before starting the MCP |
| `authentication rejected (HTTP 401/403)` | wrong key or region | Re-copy from the provider dashboard; for Sauce check `SAUCE_REGION` |
| `network error` / timeout | proxy or firewall | Test the provider API host from this machine |
| session creation hangs | no free cloud device (queue) | Pick another device or retry later; check provider concurrency |
| tunnel errors | tunnel not running or name mismatch | Start the tunnel yourself; use the same name |
| emulator shows "System UI isn't responding" | host low on RAM | Close apps, give the AVD more RAM, use `appium_dismiss_interrupts` |

## O. Security

* Credentials come **only** from environment variables. Use `.env.example` as a template; do not commit a filled file.
* Tool responses and logs never contain credentials: they report missing variable **names** only. Stored session metadata and the persisted-session file hold a scrubbed copy of capabilities; the hub URL is stored without userinfo.
* `extraCapabilities` rejects credential-looking keys so an agent cannot inject or override keys.
* Cloud regions and hubs are fixed lists or operator-supplied; user input never selects the host that receives credentials.
* Uploading an app sends it to a third party and needs a confirmation token; only `.apk`, `.aab`, `.xapk`, `.ipa` are accepted.
* This server never starts, stops or reuses shared tunnels, and never closes an existing session when creating a new one.
* Local discovery runs only fixed `adb`/`xcrun`/`emulator` commands with an argument array, never a shell string. Device serials and AVD names are validated.
* A cloud session is a paid, shared resource: always end it. Provider-side data (screenshots, video) may contain sensitive app data under the provider's retention rules.
