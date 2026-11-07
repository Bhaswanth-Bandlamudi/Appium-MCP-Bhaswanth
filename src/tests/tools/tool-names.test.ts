import {describe, expect, jest, test} from '@jest/globals';

// create-session.ts statically imports these appium drivers; mock them so the
// module loads cleanly in tests without real driver binaries.
jest.unstable_mockModule('appium-uiautomator2-driver', () => ({
  AndroidUiautomator2Driver: class {},
}));

jest.unstable_mockModule('appium-xcuitest-driver', () => ({
  XCUITestDriver: class {},
}));

jest.unstable_mockModule('webdriver', () => ({
  default: {newSession: jest.fn(), attachToSession: jest.fn()},
}));

// appium-webdriveragent transitively loads @appium/base-driver, which calls
// @appium/support.fs.readPackageJsonFrom at import time — not in our mock.
jest.unstable_mockModule('appium-webdriveragent', () => ({
  BOOTSTRAP_PATH: '/mock/wda',
}));

jest.unstable_mockModule('@appium/coresim', () => ({NativeSimctl: class {}}));

// adb-manager and ios-manager wrap native CLI tools; mock them to keep the
// test portable across environments without ADB or simctl installed.
jest.unstable_mockModule('../../devicemanager/adb-manager', () => ({
  ADBManager: {getInstance: jest.fn()},
}));

jest.unstable_mockModule('../../devicemanager/ios-manager', () => ({
  IOSManager: {getInstance: jest.fn()},
}));

const {default: registerTools} = await import('../../tools/index.js');
const {TOOL_GROUPS} = await import('../../tool-groups.js');

// Update this list when a tool is added, removed, or renamed — that is the
// point of this test.
const EXPECTED_TOOL_NAMES = [
  // Session / Device
  'select_device',
  'appium_session_management',
  'appium_mobile_device_control',
  'appium_geolocation',
  'appium_mobile_device_info',
  'appium_mobile_file',
  'appium_driver_settings',
  // iOS Setup
  'prepare_ios_simulator',
  'appium_prepare_ios_real_device',
  // Gestures
  'appium_gesture',
  'appium_drag_and_drop',
  'appium_perform_actions',
  // Element Interactions
  'appium_find_element',
  'appium_find_elements',
  'appium_mobile_press_key',
  'appium_set_value',
  'appium_mobile_keyboard',
  'appium_get_text',
  'appium_get_element_attribute',
  'appium_mobile_clipboard',
  'appium_get_active_element',
  'appium_get_page_source',
  'appium_orientation',
  'appium_alert',
  'appium_screenshot',
  'appium_get_window_size',
  'appium_screen_recording',
  // App Management
  'appium_app_lifecycle',
  'appium_mobile_permissions',
  // Context
  'appium_context',
  // Test Generation
  'generate_locators',
  'appium_generate_tests',
  // Token-efficient and QA-intelligence tools (src/tools/efficient, src/tools/intel)
  'appium_observe',
  'appium_wait_for',
  'appium_verify_locator',
  'appium_dismiss_interrupts',
  'appium_batch',
  'appium_screen_intel',
  'appium_locator_intel',
  'appium_ui_diff',
  'appium_a11y_audit',
  'appium_scenarios',
  'appium_diagnose',
  'appium_scroll_until',
  'appium_session_health',
  'appium_workflow',
  'appium_network_check',
  'appium_visual_check',
  'appium_explore',
  'appium_provider_list',
  'appium_provider_devices',
  'appium_provider_check',
  'appium_provider_upload_app',
  'appium_provider_session',
  'appium_provider_finish',
  'appium_session_overview',
  // appium_ai is intentionally absent — gated by AI_VISION_ENABLED env var
];

describe('registered MCP tool names', () => {
  test('matches expected set', () => {
    const names: string[] = [];
    const mockServer = {
      addTool: ({name}: {name: string}) => {
        names.push(name);
      },
    };

    registerTools(mockServer as any);

    expect(names.sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  test('every registered tool belongs to a tool group, and groups name no unknown tool', () => {
    const grouped = new Set(Object.values(TOOL_GROUPS).flat());
    // Opt-in tools registered only when their feature flag is on are exempt.
    expect([...EXPECTED_TOOL_NAMES].filter((n) => !grouped.has(n))).toEqual([]);
    expect([...grouped].filter((n) => !EXPECTED_TOOL_NAMES.includes(n))).toEqual([]);
  });
});
