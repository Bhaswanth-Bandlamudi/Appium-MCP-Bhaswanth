import base from './jest.config.js';

// Same transform and module mapping as unit tests, but selects only the device integration suite.
// The @appium/support mock is NOT applied here: these tests talk to the built server in dist/ as a separate process.
const config = {
  ...base,
  roots: ['<rootDir>/src/tests/integration'],
  testMatch: ['**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/dist/', '/node_modules/'],
  testTimeout: 240000,
};

export default config;
