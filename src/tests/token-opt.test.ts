import {describe, expect, test} from '@jest/globals';

import {minimalDeviceInfo} from '../tools/session/device-info.js';

describe('minimalDeviceInfo', () => {
  const raw = {
    brand: 'google',
    model: 'sdk_gphone64_x86_64',
    platformVersion: '17',
    locale: 'en_US',
    androidId: 'abc',
    networks: [
      {
        typeName: 'MOBILE',
        state: 'CONNECTED',
        isAvailable: true,
        capabilities: {networkCapabilities: 'NET_CAPABILITY_MMS,NET_CAPABILITY_SUPL,'.repeat(20), SSID: null},
        extraInfo: 'epc.example.com',
      },
    ],
  };
  test('keeps identifying fields and a one-line summary per network', () => {
    const m = minimalDeviceInfo(raw);
    expect(m).toMatchObject({brand: 'google', model: 'sdk_gphone64_x86_64', platformVersion: '17', locale: 'en_US'});
    expect(m.networks).toEqual([{type: 'MOBILE', state: 'CONNECTED', available: true}]);
  });
  test('drops fields that are not needed to identify the device', () => {
    expect(minimalDeviceInfo(raw)).not.toHaveProperty('androidId');
  });
  test('is substantially smaller than the full payload', () => {
    expect(JSON.stringify(minimalDeviceInfo(raw)).length).toBeLessThan(JSON.stringify(raw).length / 3);
  });
  test('tolerates a payload without networks', () => {
    expect(minimalDeviceInfo({model: 'x'})).toEqual({model: 'x'});
  });
});
