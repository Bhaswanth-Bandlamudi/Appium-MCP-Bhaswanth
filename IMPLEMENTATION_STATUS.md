# Implementation status (2026-11-06)

Baseline: upstream appium-mcp 1.99.3, 32 registered tools. This build registers 56 with `APPIUM_MCP_TOOL_GROUPS=all`, and **40 by default** (the `qa` and `providers` groups are opt-in).

Status labels: **A** implemented and tested (where it was tested is stated), **B** implemented but not live-verified, **C** partial, **D** documentation only, **E** unsupported here.

## Build and tests

| Check | Result |
|---|---|
| `npm ci` | Killed once for low memory. Succeeded with `NODE_OPTIONS=--max-old-space-size=1024` and `--maxsockets=3`. `package.json` and the lockfile were not changed by installation. The only `package.json` change is the new npm scripts (`test:integration*`, `bench:tokens`) |
| OpenTelemetry packages | Optional dependencies that `npm ci` skipped (their engine range needs Node 22.22.1; this machine has 22.14.0). They were installed with `--force` in a scratch folder and copied into the gitignored `node_modules`. Needed only for the type-check and telemetry tests. `js-tiktoken` for the benchmark was copied in the same way |
| `tsc` and `npm run build` | 0 errors |
| Lint (`oxlint`) | 0 errors on every file added or changed |
| MCP startup over stdio | Starts. `listTools` returns 40 tools by default and 56 with `all` |
| Unit tests | See "Final unit run" below |
| Device integration, Android | 11 of 11 scenarios passed on the final build (see below). Host-memory threshold lowered with `INTEGRATION_MIN_HOST_MB=200` because this machine has about 0.3-0.5 GB free while the emulator runs |
| Device integration, iOS | **Not executed** (no Mac) |
| Cloud providers | Mocked only (fake hub). **No live provider connection was made** |

### Final unit run
Serial run (`--runInBand`) on the final tree: **859 passed, 7 failed, 71 suites (67 passed, 4 failed)**. 

A first serial run showed 10 failures in 5 suites. The fifth was `tools/session/file-transfer.test.ts`: my new confirmation guard on `appium_mobile_file push` correctly stopped the existing push tests, which expected a one-call push. That was a regression caused by this work, not an upstream problem. The tests were updated to perform the documented two-step confirmation with their original assertions kept, and new tests were added (no token writes nothing; a token cannot be reused or moved to another path; `pull` needs no confirmation). The second run is the one reported above.

The 7 remaining failures are in four suites and are **not caused by this work**: they fail on the untouched upstream v1.99.3 checkout on this Windows machine too. Measured this round by running just these four suites in a separate copy of upstream v1.99.3: all four suites failed there (12 failing tests of 37). The upstream run has more failing tests than this build's 7 because the six `publish-mcp-registry` tests are timing-dependent and failed together under load there, while only one failed in the full serial run here. The same four suites fail in both; none passes upstream and fails here:

| Suite | Failing tests | Reason |
|---|---|---|
| `persistence.test.ts` | restricts newly written session files to the current user; repairs permissive permissions | assert POSIX file modes, which Windows does not provide |
| `screenshot.test.ts` | should return success content with filename; should write screenshot buffer to correct filepath | assumptions about the screenshot directory and path separators |
| `tools/interactions/screenshot.test.ts` | keeps saved screenshot base64 out of model content for MCP Apps clients; keeps the embedded screenshot viewer fallback | same |
| `publish-mcp-registry.test.ts` | fails after the retry budget is exhausted | timing and retry-budget behaviour of a release script (flaky; passes or fails with machine load) |

None of these assertions were weakened, skipped or edited. New and changed tests all pass: explore engine 34, recovery 21, confirm and policy 26, tool groups 7, integration harness 10, providers 25, provider session 2, file transfer 9.

## Live Android validation (final build)

Device: Android 17 x86_64 emulator, 2 cores, 3 GB, headless, no internet, app under test Android Settings. Evidence record: `integration-results/integration-android-*.json` (git-ignored; produced by the suite). The host was short of memory throughout (~340 MB free), so the emulator showed "not responding" dialogs between runs; the suite clears one only where a scenario's precondition is a calm device and records how many it cleared (0 in the final run). Earlier runs on the same machine failed intermittently for that reason, which is why the results below come from the final, repeated run and the unit tests carry the logic coverage.

| Scenario | Result | What it asserted |
|---|---|---|
| Session create and overview | passed | exactly one active session |
| Page source, screenshot, screen intel | passed | compact source smaller than full (1,576 vs 55,694 chars) |
| Invalid locator, missing element | passed | errors surfaced, no crash |
| Destructive block | passed | `clear` blocked without a token, app still installed |
| `appium_explore` normal run | passed | status `limits`, 12 taps, 6 screens, 6 boundary exits undone, 5 relaunches, 4 screenshots; no restricted control tapped; one session; app back in front. Fails if fewer than 3 screens or 3 taps, or a device-failure status |
| `appium_explore` missing session | passed | structured `device-failure`, never plain text |
| `appium_explore` deny word | passed | status `safety`, 0 taps |
| `appium_session_health` healthy | passed | kind `healthy`, no extra session |
| Recovery | passed | UiAutomator2 server killed; report-only diagnosed `driver-crashed` and changed nothing; `recover=true` replaced the session once (old to new id), app restored, device list unchanged |
| Exploration after recovery | passed | from a relaunched app, 4 screens, 4 relaunches |
| Recovery bound | passed | third attempt refused: "recovery limit reached (2 of 2 in the window)" |

What the live exploration run is and is not. It crosses into other apps (Settings search, Google services) and returns each time, which is the behaviour the earlier version failed at. It ended at the action limit, not "explored everything", and the 6 screens are the top level plus a few Settings sub-screens. It is evidence that exploration works on a real app, not a coverage claim.

## Capability status

### Connectivity
| Capability | Status |
|---|---|
| Local Android emulator: discovery, check, session, overview, health | **A, live** |
| Local Android physical device, unauthorized and offline states | **B**: parsing and fix messages unit-tested; no phone attached |
| Local iOS simulator | **B** (macOS only): `simctl` parsing unit-tested; this host reports "unsupported" with a reason (verified). `scripts/ios-validate.sh` and the iOS integration path are prepared and **have not been run** |
| Local iOS physical device | **D**: not enumerated by this server; upstream's `appium_prepare_ios_real_device` covers signing on a Mac |
| LambdaTest | **B**: capabilities, upload, device list, concurrency check, tunnel name. Session status, logs and video **not implemented** (no verified endpoint) |
| BrowserStack | **B**: capabilities, upload, device list, session details and pass/fail, local tunnel name |
| Sauce Labs | **B**: capabilities, upload, device list and states, job details and pass/fail. Device-list field names assumed |
| Kobiton | **C**: operator supplies the hub URL; capabilities only. No device list, upload, status or tunnel |
| Firebase Test Lab | **E**: no Appium endpoint (official FAQ) |
| Cloud session creation, credential scrubbing, two-session isolation | **A against a local fake hub**; **not run against any real cloud** |

### Tools
| Capability | Status |
|---|---|
| `appium_observe`, `appium_wait_for`, `appium_verify_locator`, `appium_batch`, `appium_dismiss_interrupts`, `appium_scroll_until` | **A, live** |
| `appium_screen_intel`, `appium_locator_intel`, `appium_scenarios`, `appium_a11y_audit`, `appium_ui_diff`, `appium_diagnose` | **A, live** |
| `appium_workflow` (record, replay, Java export), `appium_network_check`, `appium_visual_check` | **A, live** (run in an earlier round on the same emulator; not part of the final 11-scenario suite) |
| `appium_session_health` and recovery | **A, live** (final suite): classification, report-only, one verified replacement, retry bound. iOS (`wda-failure`) classification is unit-tested only |
| `appium_explore` | **A, live** (final suite) plus 34 simulated-app tests covering every stop reason. iOS not verified |
| Destructive-action safeguards | **A, live** for `clear`; **A, unit** for uninstall, fullReset, file push, provider upload and trusted mode |
| iOS paths in every tool | **B** |
| MCP clients other than the SDK stdio client | not tested |

## Safety behaviour

- Default: confirmation required for `app.uninstall`, `app.clear`, `session.fullReset`, `file.push`, `provider.upload`. Token is single-use, 2 minutes, bound to operation, target and session. Read-only and reversible operations are unaffected.
- Trusted automation mode: off unless `APPIUM_MCP_TRUSTED_MODE=on`, `APPIUM_MCP_TRUSTED_OPS`, `APPIUM_MCP_TRUSTED_APPS` (exact ids) and `APPIUM_MCP_TRUSTED_REASON` are all valid. `all` and wildcards are rejected, any mistake leaves confirmation on, every bypass is logged. Verified through the running server: default blocks, a legacy `APPIUM_MCP_ALLOW_DESTRUCTIVE=true` still blocks, a valid trusted configuration passes the guard, a wildcard configuration still blocks.
- Removed: `APPIUM_MCP_ALLOW_DESTRUCTIVE`. It is rejected, not honoured.
- Recovery never resets app data (`fullReset` is stripped from replacement capabilities).

## Token measurements

Tokenizer: **`js-tiktoken` `o200k_base`, an OpenAI encoding. It is a proxy, not Claude token counts.** `ANTHROPIC_API_KEY` was not available, so Anthropic's token-counting endpoint was not used. `npm run bench:tokens` uses that endpoint automatically when the key is set (documented: `POST /v1/messages/count_tokens`, free, rate limited; current Claude models use a tokenizer that produces roughly 30% more tokens than older ones, so Claude counts will be higher in absolute terms, and the savings percentages are expected to be similar but are not guaranteed to be). The benchmark prints the tokenizer on every run and refuses to run without either a key or the proxy installed.

Method: `src/tests/fixtures/bench/captured.json` holds the real outputs of upstream v1.99.3 (baseline, built from commit 154ff11) and of this build for the same questions, captured on one device by `npm run bench:tokens -- --capture`. Token cost of a call is the tokens of the call arguments plus its result. Definitions are the `tools/list` result encoded as name, description and input schema.

### 1. Tool definitions sent at the start of every session
| Configuration | Tools | Tokens (proxy) | Change vs upstream |
|---|---|---|---|
| Upstream v1.99.3 | 32 | 9,264 | baseline |
| This build, default | 40 | 11,363 | +2,099 (+22.7%) |
| `default,qa` | 49 | 13,266 | +4,002 (+43.2%) |
| `default,providers` | 47 | 12,630 | +3,366 (+36.3%) |
| `all` | 56 | 14,533 | +5,269 (+56.9%) |
| `core,observe,interact` | 23 | 6,470 | -2,794 (-30.2%) |

The default set costs **more** than upstream because it adds tools; adding capability is not free. The reduction is available with an exact group list.

### 2. Cost of representative calls
| Case | Baseline | Current | Saved | % | Information |
|---|---|---|---|---|---|
| Read the current screen (full vs `mode=compact`) | 13,611 | 491 | 13,120 | 96.4% | all 22 readable strings kept; 12 of 12 clickable rows listed; ids on non-actionable layout containers (13 of 18) and bounds/hierarchy are dropped |
| Locator candidates (`limit=10`) | 3,173 | 984 | 2,189 | 69.0% | shows 10 of 35 candidates by design |
| Find "Network" and get a locator | 30 | 85 | -55 | -183% | current is larger on purpose: it adds uniqueness and a stability score that upstream does not return |
| Device information (`verbosity=minimal`) | 398 | 90 | 308 | 77.4% | drops `androidId`, `bluetooth`, `carrierName`, per-network detail |
| List open sessions | 80 | 55 | 25 | 31.3% | different content: adds provider and active flag |
| List installed apps (all, compact) | 8,653 | 2,994 | 5,659 | 65.4% | package ids kept; `appName` omitted when equal to the id |
| Is a settings app installed (`filter`) | 8,653 | 92 | 8,561 | 98.9% | only matches returned |
| Camera permission (`grep`) | 3,269 | 28 | 3,241 | 99.1% | only matching permissions returned |
| Element not found | 38 | 38 | 0 | 0% | unchanged code path |
| Why did a step fail (diagnose) | none | 219 | n/a | n/a | upstream has no log or diagnosis tool |

### 3. Workflows
| Workflow | Baseline | Current | Saved | % |
|---|---|---|---|---|
| Understand the screen (full source vs `appium_screen_intel`) | 13,611 | 122 | 13,489 | 99.1% |
| Open a row and confirm the next screen (find, tap, source vs one `appium_batch` with diff) | 3,840 | 446 | 3,394 | 88.4% |
| Check two locators are unique | 59 | 40 | 19 | 32.2% |
| **Three together** | **17,510** | **608** | **16,902** | **96.5%** |

Net for one pass through the three workflows after paying the larger default definition cost (+2,099): **14,803 tokens saved** (proxy). Repeating workflows amortises the fixed cost.

Where optimisation reduces information: compact page source drops bounds, hierarchy and non-actionable ids, so it is not a drop-in for XML parsing; `appium_screen_intel` summarises and cannot answer questions about elements it did not list; filters and `limit` return only what was asked for. Automation reliability is preserved because every action path still resolves elements by locator against the live screen (`appium_batch` waits and re-finds), but a caller that parsed the old full output needs the full mode (still the default of `appium_get_page_source`).

Limits: one device, one app, one run; proxy tokenizer; baseline outputs are from the same emulator state.

## Changes to upstream behaviour

1. Destructive operations need a `confirmToken` (uninstall, clear, `fullReset` capability, file push, provider upload). **Breaking for callers that expect a one-call uninstall or clear.**
2. The default tool set now hides the `qa` and `providers` groups (`APPIUM_MCP_TOOL_GROUPS=default,qa,providers` or `all` restores them). Upstream's 32 tools are all still registered by default.
3. `appium_app_lifecycle list` and `appium_mobile_permissions get` return compact JSON; `list` omits `appName` when equal to the package id. A consumer parsing these strings may need an update.
4. New optional parameters: `appium_get_page_source` `mode`, `generate_locators` `limit`, `list` `filter`/`limit`, `permissions get` `grep`, `device_info` `verbosity`, `appium_session_management` `confirmToken`, `appium_mobile_file` `confirmToken`.
5. `appium_mobile_device_info` returns compact JSON.
6. `jest.config.js` excludes `src/tests/integration/` from `npm test`; `package.json` gains five scripts.

## Pre-existing unit failures (not caused by this work)

Four suites fail identically on the untouched upstream checkout on this Windows machine, measured on a stashed baseline: `persistence` (POSIX file modes), `screenshot` and `tools/interactions/screenshot` (screenshot directory and viewer assumptions), `publish-mcp-registry` (retry/timing). They are not weakened or skipped.

## Remaining limitations (genuine blockers)

* **No real cloud account:** nothing was run against LambdaTest, BrowserStack, Sauce Labs or Kobiton. Endpoints and capability names come from official pages read on 2026-11-05 and may have drifted.
* **No Mac:** local iOS, iOS physical devices and every iOS code path are unvalidated. The procedure is `scripts/ios-validate.sh` (see `src/tests/integration/README.md`).
* **No Claude tokenizer access (no API key):** token figures are a proxy. Run `ANTHROPIC_API_KEY=... npm run bench:tokens` to obtain Claude counts from the same fixtures.
* **No physical Android phone.**
* **Low-memory host:** the emulator stalls on this machine; the device suite needs about 6 GB free for a clean run. The final run used a lowered threshold and the record says so.
* LambdaTest session status/logs and Kobiton device list, upload, status and tunnels are not implemented because no endpoint was verified. Tunnels are never started or stopped by this server.
* `appium_a11y_audit` is static (not TalkBack/VoiceOver). Network tools do not inspect traffic. Recovery does not restore in-app state.
