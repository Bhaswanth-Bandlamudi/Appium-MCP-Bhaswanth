#!/usr/bin/env node
// Cross-platform launcher for the device integration suite (no inline env syntax, so it works in cmd and PowerShell).
// Usage: node scripts/run-integration.mjs [android|ios]
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';

const platform = process.argv[2] ?? process.env.INTEGRATION_PLATFORM ?? 'android';
if (!['android', 'ios'].includes(platform)) {
  console.error(`platform must be android or ios, got "${platform}"`);
  process.exit(2);
}
if (!existsSync(new URL('../dist/index.js', import.meta.url))) {
  console.error('dist/index.js not found: run `npm run build` first.');
  process.exit(2);
}
const result = spawnSync(
  process.execPath,
  ['node_modules/jest/bin/jest.js', '-c', 'jest.integration.config.js', '--runInBand', ...process.argv.slice(3)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      RUN_DEVICE_TESTS: '1',
      INTEGRATION_PLATFORM: platform,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --experimental-vm-modules`.trim(),
    },
  },
);
process.exit(result.status ?? 1);
