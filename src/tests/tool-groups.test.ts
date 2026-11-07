import {describe, expect, test} from '@jest/globals';

import {DEFAULT_GROUPS, OPT_IN_GROUPS, TOOL_GROUPS, toolGroupsPolicy} from '../tool-groups.js';

const allowed = (raw: string | undefined, tool: string): boolean => {
  const p = toolGroupsPolicy(raw);
  return p === undefined ? true : (p.allowTools ?? []).some((r) => r.test(tool));
};

describe('toolGroupsPolicy', () => {
  test('"all" means no filtering', () => {
    expect(toolGroupsPolicy('all')).toBeUndefined();
    expect(toolGroupsPolicy('core, ALL')).toBeUndefined();
  });
  test('unset or empty is the default set: opt-in tools hidden, everything else (known or unknown) visible', () => {
    for (const raw of [undefined, '']) {
      expect(allowed(raw, 'appium_batch')).toBe(true);
      expect(allowed(raw, 'appium_gesture')).toBe(true);
      expect(allowed(raw, 'appium_explore')).toBe(false);
      expect(allowed(raw, 'appium_provider_session')).toBe(false);
      expect(allowed(raw, 'appium_ai')).toBe(true); // not in any group: governed by its own flag
      expect(allowed(raw, 'appium_documentation_query')).toBe(true);
      expect(allowed(raw, 'some_plugin_tool')).toBe(true);
    }
  });
  test('"default,qa" adds exactly that opt-in group', () => {
    expect(allowed('default,qa', 'appium_explore')).toBe(true);
    expect(allowed('default,qa', 'appium_provider_session')).toBe(false);
    expect(allowed('default,qa,providers', 'appium_provider_session')).toBe(true);
  });
  test('an explicit list without "default" is exact and anchored', () => {
    expect(allowed('core', 'appium_session_management')).toBe(true);
    expect(allowed('core', 'appium_session_management_x')).toBe(false);
    expect(allowed('core', 'appium_batch')).toBe(false);
    expect(allowed('core,observe', 'appium_diagnose')).toBe(true);
  });
  test('an unknown group fails loudly', () => {
    expect(() => toolGroupsPolicy('core,bogus')).toThrow(/bogus/);
    expect(() => toolGroupsPolicy('defualt')).toThrow(/defualt/);
  });
  test('no tool is in two groups', () => {
    const all = Object.values(TOOL_GROUPS).flat();
    expect(new Set(all).size).toBe(all.length);
  });
  test('the opt-in groups exist and the default is everything else', () => {
    for (const g of OPT_IN_GROUPS) {
      expect(TOOL_GROUPS[g]).toBeDefined();
      expect(DEFAULT_GROUPS).not.toContain(g);
    }
    expect(DEFAULT_GROUPS).toEqual(expect.arrayContaining(['core', 'observe', 'interact', 'locators', 'device']));
  });
});
