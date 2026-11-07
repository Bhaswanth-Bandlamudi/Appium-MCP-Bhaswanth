# Roadmap (next 6-12 months)

Ordered by value over risk. Nothing below is implemented unless IMPLEMENTATION_STATUS.md says so. "Realistic" items extend code that exists; "Experimental" items need research or infrastructure first.

## Already done

Destructive-action confirmation with a strict trusted automation mode, opt-in tool groups with a smaller default, session diagnosis and bounded recovery, workflow record/replay/Java export, connectivity check, pixel and layout visual check, a bounded safety-gated exploration engine validated live on Android, a device integration suite with a health gate, a token benchmark (Claude API or labelled proxy), and universal provider connectivity (local Android/iOS, LambdaTest, BrowserStack, Sauce Labs, Kobiton partial). Live-verification gaps are listed in IMPLEMENTATION_STATUS.md.

## Realistic

### 1. Validate the cloud providers for real (phase 1, weeks 1-3)
* **Problem:** four providers are implemented from documentation only.
* **Solution:** run the same scripted session (create, observe, batch, finish, delete) against real LambdaTest, BrowserStack and Sauce accounts, and fix drift. Confirm the Sauce device-list field names, the LambdaTest `lt://` upload response key and whether `lt:options` is required, and find the Kobiton hub and REST endpoints.
* **How:** the jest fake hub already proves routing and secret handling; add an opt-in live suite gated by environment credentials.
* **Dependencies:** accounts or trial credits. **Complexity:** low. **Risk:** vendor rate limits and cost.

### 2. Run the device suite in CI (phase 1)
* **Status:** the suite exists (`npm run test:integration:android`) and passes on an emulator.
* **Remaining:** run it in CI on a runner with at least 6 GB free; add a Mac runner for `scripts/ios-validate.sh`.
* **Risk:** emulator stalls on small runners. The health gate skips, never passes, an unhealthy device.

### 3. Output scoping on the remaining upstream tools (phase 1)
* **Problem:** other upstream outputs stay verbose (for example `driver_settings get`, session create text, screenshot UI payloads).
* **Solution:** opt-in `filename` or `resource_link` output, `depth` and `target` scoping (the Playwright MCP pattern), minimal modes.
* **Benefit:** lower context use. **Complexity:** low. **Risk:** contract changes, so keep every change opt-in.

### 4. Claude token counts (phase 1)
* **Status:** `npm run bench:tokens` uses Anthropic's token-counting endpoint when `ANTHROPIC_API_KEY` is set; the published numbers are from a proxy tokenizer because no key was available.
* **Remaining:** run it once with a key and publish both columns.

### 5. LambdaTest and Kobiton session APIs (phase 2)
* **Problem:** no verified status or log endpoints.
* **Solution:** add them once read from official pages and confirmed live.
* **Dependency:** item 1.

### 6. iOS validation and physical iPhone listing (phase 2)
* **Problem:** every iOS path is unverified; physical iPhones are not listed.
* **Solution:** run the live suite on a simulator with WebDriverAgent; add device listing through `xcrun devicectl`.
* **Dependencies:** a Mac, Xcode. **Risk:** tree-format differences between XCUITest and UiAutomator2.

### 7. Network intelligence (phase 2)
* **Problem:** backend failures look like UI failures; only connectivity and reachability are checked.
* **Solution:** a user-configured proxy with a filtered HAR slice (the Sauce `filter_har_data` idea), and an offline toggle that restores state.
* **Dependencies:** proxy. **Risk:** must not bypass pinning or organisational controls.

### 8. Screenshot cost control (phase 2)
* **Problem:** images dominate context.
* **Solution:** downscale or quantise, element-only crops, omit by default.
* **Dependency:** an image library (sharp is already available through Appium).

### 9. Tool catalogue search (phase 3)
* **Problem:** every session pays for all tool definitions (66,791 characters for 56 tools).
* **Solution:** a few meta-tools that search a capability catalogue on demand (the BrowserStack MCP pattern), on top of `APPIUM_MCP_TOOL_GROUPS`.
* **Risk:** discoverability for the model.

### 10. Failure evidence bundles and defect drafts (phase 3)
* **Problem:** reproducing a failure needs steps, screen state, logs and a screenshot.
* **Solution:** bundle the last workflow steps, `appium_diagnose` output, a compact screen and an optional screenshot into one file a person reviews before it goes into a tracker. No automatic filing.

## Experimental

| Idea | Problem | Approach | Needs | Risk |
|---|---|---|---|---|
| Self-healing locators | Locators break between app versions | Re-resolve a target by role, label and neighbours, and act only when uniqueness, visibility and identity all match; otherwise report | A corpus of version pairs | Wrong-element taps hide bugs; never silent |
| Natural-language test execution | Plain-English steps to tests | Compose `appium_batch`, `appium_locator_intel` and `appium_workflow` from a model | Evaluation set | Invented expectations |
| Autonomous exploration at scale | Coverage of unfamiliar apps | Extend `appium_explore` with a persistent screen graph and coverage reports | Run history store | Destructive taps; needs a test account |
| Failure clustering and root-cause ranking | Many failures, few causes | Cluster `appium_diagnose` outputs across runs | Run history | Over-claiming causes |
| Intelligent device selection | Which device finds this bug | Rank by past failures and provider availability | Run history | Sparse data |
| Test impact analysis, regression selection | Run less, miss less | Map code changes to screens | Repository integration | Hard to validate |
| Multi-agent QA flows, CI/CD investigation | Parallel and unattended work | Several sessions through `appium_session_overview` and explicit session ids | Orchestrator | Session cross-talk; shared device cost |
