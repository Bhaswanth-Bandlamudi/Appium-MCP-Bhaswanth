import type {AppiumMcpPolicy} from './policy.js';

/**
 * Tool groups for APPIUM_MCP_TOOL_GROUPS. Every registered tool's definition is sent to the model each
 * session, so the fixed context cost is the sum of what is registered.
 *
 * Groups partition the tools this fork knows about (a test enforces that each tool is in exactly one group).
 * Two groups are OPT-IN and are not registered unless asked for: `qa` and `providers`.
 *
 *   unset / ""            -> default: everything except the opt-in groups
 *   "all"                 -> everything
 *   "default,qa"          -> default plus the named opt-in group(s)
 *   "core,observe"        -> exactly those groups (and nothing else known to this list)
 *
 * Tools that are not in any group (appium_ai, documentation/skills tools, plugin tools) are governed by their own
 * feature flags and are never hidden by the default or by "default,..." lists. Only an explicit list that does not
 * contain "default" restricts to named groups.
 */
export const TOOL_GROUPS: Record<string, readonly string[]> = {
  /** session and app lifecycle */
  core: [
    'select_device',
    'appium_session_management',
    'appium_session_health',
    'appium_app_lifecycle',
    'appium_context',
  ],
  /** seeing the screen and diagnosing a failed step */
  observe: [
    'appium_observe',
    'appium_screen_intel',
    'appium_get_page_source',
    'appium_screenshot',
    'appium_get_window_size',
    'appium_diagnose',
  ],
  /** acting on elements */
  interact: [
    'appium_batch',
    'appium_wait_for',
    'appium_find_element',
    'appium_find_elements',
    'appium_set_value',
    'appium_get_text',
    'appium_get_element_attribute',
    'appium_get_active_element',
    'appium_gesture',
    'appium_mobile_press_key',
    'appium_mobile_keyboard',
    'appium_alert',
  ],
  /** finding and validating locators, generating code */
  locators: ['appium_locator_intel', 'appium_verify_locator', 'generate_locators', 'appium_generate_tests'],
  /** device-level controls */
  device: [
    'appium_mobile_device_info',
    'appium_mobile_device_control',
    'appium_geolocation',
    'appium_orientation',
    'appium_mobile_clipboard',
    'appium_mobile_file',
    'appium_mobile_permissions',
    'appium_driver_settings',
    'appium_screen_recording',
  ],
  /** low-level gestures */
  advanced: ['appium_perform_actions', 'appium_drag_and_drop'],
  /** iOS preparation */
  ios: ['prepare_ios_simulator', 'appium_prepare_ios_real_device'],
  /** OPT-IN: exploration, workflows, visual and accessibility checks, UI diff, scenarios, network */
  qa: [
    'appium_scroll_until',
    'appium_dismiss_interrupts',
    'appium_ui_diff',
    'appium_a11y_audit',
    'appium_scenarios',
    'appium_visual_check',
    'appium_network_check',
    'appium_explore',
    'appium_workflow',
  ],
  /** OPT-IN: cloud and multi-device providers */
  providers: [
    'appium_provider_list',
    'appium_provider_devices',
    'appium_provider_check',
    'appium_provider_upload_app',
    'appium_provider_session',
    'appium_provider_finish',
    'appium_session_overview',
  ],
};

export const OPT_IN_GROUPS = ['qa', 'providers'] as const;
export const DEFAULT_GROUPS = Object.keys(TOOL_GROUPS).filter((g) => !(OPT_IN_GROUPS as readonly string[]).includes(g));

const exactly = (names: Iterable<string>): RegExp => new RegExp(`^(?:${[...names].join('|')})$`);
const anyBut = (names: Iterable<string>): RegExp => new RegExp(`^(?!(?:${[...names].join('|')})$).*$`);

/**
 * Builds the registration policy. Unknown group names throw, so a typo never silently hides tools.
 */
export function toolGroupsPolicy(raw: string | undefined): AppiumMcpPolicy | undefined {
  const names = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.includes('all')) {
    return undefined;
  }
  const unknown = names.filter((n) => n !== 'default' && !(n in TOOL_GROUPS));
  if (unknown.length) {
    throw new Error(
      `APPIUM_MCP_TOOL_GROUPS has unknown group(s): ${unknown.join(', ')}. Valid: default, all, ${Object.keys(TOOL_GROUPS).join(', ')}`,
    );
  }
  const useDefault = names.length === 0 || names.includes('default');
  if (useDefault) {
    // Deny only the opt-in tools that were not requested; anything else (including tools this list does not know) stays.
    const wanted = new Set(names);
    const hidden = OPT_IN_GROUPS.filter((g) => !wanted.has(g)).flatMap((g) => TOOL_GROUPS[g]);
    return hidden.length ? {allowTools: [anyBut(hidden)]} : undefined;
  }
  // Explicit list: exactly these groups.
  return {allowTools: [exactly(names.flatMap((n) => TOOL_GROUPS[n]))]};
}
