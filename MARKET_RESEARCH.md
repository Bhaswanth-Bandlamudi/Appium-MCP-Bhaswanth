# Market research (researched 2026-11-05)

Only facts read from fetched pages are listed. "Unverified" means a search snippet or nothing was seen. Stars, release dates and most licences were not visible.

## Alternatives reviewed

| Project | Tools / design seen | Idea worth taking | Decision |
|---|---|---|---|
| mobile-next/mobile-mcp (34 tools) | accessibility-tree element list, `mobile_batch_commands`, device logs, crash list/get, cloud device allocate/release, fold device | batch execution; compact element list; crash tools | Adopted: batch + compact list (`appium_batch`, `appium_observe`). Crash tools: partly (`appium_diagnose` reads logcat, verified live). Cloud allocation: rejected for now (needs vendor accounts) |
| gavrix/appium-mcp (12 tools) | `*_file` variants for page source and screenshots, 0-1 normalised gesture coordinates | write big payloads to a file | Upstream already has page-source file variants. Normalised coordinates: roadmap |
| Rahulec08/appium-mcp | tap fallback chain click, W3C actions, TouchAction | self-healing tap | Rejected as unsafe: a fallback that taps an unverified element hides failures. Healing is on the roadmap only with uniqueness, visibility and identity checks |
| joshuayoes/ios-simulator-mcp | `ui_describe_all`, `ui_describe_point`, compressed `ui_view` screenshot | screenshot compression | Roadmap |
| Maestro MCP | runs YAML flows, assert, run-until-pass | flow engine | Adopted in a smaller form: `appium_workflow` record/replay/Java export (no YAML, no assert DSL) |
| CursorTouch/Android-MCP (MIT per sidebar) | `Snapshot` lists only interactive elements; optional vision; 256-colour screenshots; `WaitForElement` | interactive-only snapshot | Adopted (`appium_observe`, `appium_wait_for`) |
| microsoft/playwright-mcp | accessibility snapshot with refs, `depth`/`target` scoping, `filename` output to file, opt-in tool groups (`--caps`), `browser_generate_locator` | scoped snapshots, opt-in groups, locator generation | Adopted: locator generation (`appium_locator_intel`). Opt-in groups: roadmap |
| browserstack/mcp-server | 5 meta-tools that search a capability catalogue instead of one tool per workflow | lazy tool discovery to cut definition tokens | Roadmap |
| saucelabs/sauce-api-mcp (Apache-2.0 from 1.1.0) | `filter_har_data`, network conditions, HAR | filtered HAR slice | Roadmap (network intelligence) |
| LambdaTest MCP | remote, OAuth 2.1, accessibility product | n/a | Tool list unverified |
| Perfecto, Kobiton, Firebase Test Lab | no MCP found | n/a | Unverified |
| Detox, Flutter, Espresso MCPs | not researched | n/a | Unverified |

## Device clouds (researched 2026-11-05 for connectivity; facts read on official pages)

| Provider | Appium endpoint | Auth | App upload | Device list | Session status | Decision |
|---|---|---|---|---|---|---|
| LambdaTest (TestMu AI) | `mobile-hub.lambdatest.com/wd/hub` | username + access key (client credentials) | `POST manual-api.lambdatest.com/app/upload/realDevice` -> `lt://` | `GET mobile-api.lambdatest.com/mobile-automation/api/v1/list` (no availability) | not found in docs read | Implemented; no status/logs; `lt:options` not confirmed so top-level keys used |
| BrowserStack | `hub.browserstack.com/wd/hub` | `bstack:options.userName/accessKey` | `POST api-cloud.browserstack.com/app-automate/upload` -> `bs://` | `GET /app-automate/devices.json` (no availability) | `GET/PUT /app-automate/sessions/{id}.json` | Implemented incl. status; a second hub host seen only in a search snippet was not used |
| Sauce Labs | `ondemand.<region>.saucelabs.com/wd/hub` (4 regions) | `sauce:options.username/accessKey` | `POST api.<region>.saucelabs.com/v1/storage/upload` | `GET /v1/rdc/devices`, `/v1/rdc/devices/status` | `GET/PUT /v1/rdc/jobs/{id}` | Implemented; device-list field names assumed |
| Kobiton | hub only partly verified | `appium:username`, `appium:accessKey` | endpoint seen only in an old snippet | not verified | not verified | Partial: operator supplies the hub; no REST calls |
| Firebase Test Lab | none | n/a | n/a | n/a | n/a | Rejected: its FAQ says Appium is not supported (Robo, Espresso, Game Loop, XCTest) |
| TestingBot | `hub.testingbot.com/wd/hub` (snippet) | key + secret | `POST api.testingbot.com/v1/storage` -> `tb://` | n/a | n/a | Documented only |
| HeadSpin, pCloudy, Perfecto, Experitest | not researched | | | | | Not researched |

Sources: docs.saucelabs.com (data-center-endpoints, appium/real-devices, dev/api/storage, dev/api/rdc), browserstack.com/docs/app-automate (api-reference/appium/apps, sessions, devices; app-automate/capabilities), testmuai.com/support/docs (appium-java, desired-capabilities-in-appium, app-testing-apis), docs.kobiton.com (automation-testing/capabilities), firebase.google.com/docs/test-lab/troubleshooting, testingbot.com/support/api/storage.

## Platform facts used (appium-uiautomator2-driver README)

- Logcat is streamed with `mobile: startLogsBroadcast` / `stopLogsBroadcast` and filtered with the `appium:logcatFilterSpecs` capability. No ANR or crash command was found. `appium_diagnose` therefore reads `getLog('logcat')` defensively and reports "not readable" when the driver refuses.
- `mobile: shell` needs the `uiautomator2:adb_shell` server feature, so no tool here depends on it.
- `mobile: getCurrentPackage`, `getCurrentActivity`, `getDisplayDensity` (2.20+/2.21+) exist and are candidates for the roadmap.
- `appium driver doctor uiautomator2` exists since 2.39.0.
- Appium 3 details came from third-party guides only; verify before relying on them.

## MCP specification (2025-06-18)

- Tool annotations are hints, untrusted unless the server is trusted. All new tools set `readOnlyHint` and `openWorldHint`.
- `outputSchema` / `structuredContent` and `resource_link` exist; the new tools return JSON text for now (roadmap).
- Elicitation (`elicitation/create`) is the standard way to confirm destructive actions; not yet wired (see IMPLEMENTATION_STATUS.md).

## Sources

github.com/mobile-next/mobile-mcp, github.com/gavrix/appium-mcp, github.com/Rahulec08/appium-mcp, github.com/joshuayoes/ios-simulator-mcp, github.com/mobile-dev-inc/maestro, github.com/CursorTouch/Android-MCP, github.com/microsoft/playwright-mcp, github.com/browserstack/mcp-server, github.com/saucelabs/sauce-api-mcp, github.com/appium/appium-uiautomator2-driver, modelcontextprotocol.io/specification/2025-06-18
