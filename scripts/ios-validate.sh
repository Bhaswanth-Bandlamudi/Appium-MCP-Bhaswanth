#!/usr/bin/env bash
# iOS simulator validation. Run on a Mac. It verifies prerequisites, boots a simulator, and runs the same
# integration suite that runs on Android. Nothing here has been executed on iOS by the authors (no Mac was
# available when it was written); a green run on your Mac is what turns "implemented" into "validated".
#
#   scripts/ios-validate.sh                       # boots a default simulator if none is booted
#   IOS_UDID=<udid> scripts/ios-validate.sh       # use a specific simulator
#   INTEGRATION_APP_ID=com.apple.Preferences ...  # app under test (default: Settings)
set -u
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok:   $*"; }

[ "$(uname -s)" = "Darwin" ] || fail "iOS simulators need macOS (this is $(uname -s))"
command -v xcodebuild >/dev/null || fail "Xcode is not installed (xcodebuild not found)"
command -v xcrun >/dev/null || fail "xcrun not found: run xcode-select --install"
xcode-select -p >/dev/null 2>&1 || fail "no active developer directory: sudo xcode-select -s /Applications/Xcode.app"
ok "Xcode $(xcodebuild -version | head -1)"

NODE_V=$(node -v 2>/dev/null | sed 's/^v//') || fail "node not found"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>=24?0:1)' \
  || fail "Node $NODE_V is too old for the XCUITest driver (needs ^20.19, ^22.12 or >=24)"
ok "Node $NODE_V"

[ -f dist/index.js ] || fail "dist/index.js missing: run npm ci && npm run build"
ok "server built"

XCUI=$(node -p "require('./node_modules/appium-xcuitest-driver/package.json').version" 2>/dev/null) || fail "appium-xcuitest-driver not installed (npm ci)"
WDA=$(node -p "require('./node_modules/appium-webdriveragent/package.json').version" 2>/dev/null) || fail "appium-webdriveragent not installed (npm ci)"
ok "appium-xcuitest-driver $XCUI, appium-webdriveragent $WDA (bundled; no separate Appium server needed)"

# iOS runtime available?
xcrun simctl list runtimes | grep -q "iOS" || fail "no iOS simulator runtime: Xcode > Settings > Components"

UDID="${IOS_UDID:-}"
if [ -z "$UDID" ]; then
  UDID=$(xcrun simctl list devices booted -j | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const b=Object.values(j.devices).flat();console.log(b[0]?b[0].udid:"")})')
fi
if [ -z "$UDID" ]; then
  UDID=$(xcrun simctl list devices available -j | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const [rt,l] of Object.entries(j.devices)){if(!/iOS/.test(rt))continue;const p=l.find(d=>/iPhone/.test(d.name));if(p){console.log(p.udid);return}}})')
  [ -n "$UDID" ] || fail "no available iPhone simulator; create one in Xcode"
  echo "booting simulator $UDID"
  xcrun simctl boot "$UDID" || fail "could not boot $UDID"
  xcrun simctl bootstatus "$UDID" -b || fail "simulator did not finish booting"
fi
export IOS_UDID="$UDID"
ok "simulator $UDID is booted"

echo "--- registering and discovery checks (no session yet)"
node scripts/run-integration.mjs ios -t "creates a session" || exit $?

echo
echo "Evidence is written to integration-results/. Attach the newest integration-ios-*.json when reporting results."
echo "First run builds WebDriverAgent for the simulator and can take several minutes; if session creation times out,"
echo "set INTEGRATION_LAUNCH_TIMEOUT_MS=300000 and retry, or run prepare_ios_simulator through the MCP first."
