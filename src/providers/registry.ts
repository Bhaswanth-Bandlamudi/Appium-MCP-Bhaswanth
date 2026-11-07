import {BrowserStackProvider} from './browserstack.js';
import {KobitonProvider} from './kobiton.js';
import {LambdaTestProvider} from './lambdatest.js';
import {LocalAndroidProvider, LocalIosProvider} from './local.js';
import {SauceLabsProvider} from './saucelabs.js';
import type {DeviceProvider, ProviderId} from './types.js';

const providers: DeviceProvider[] = [
  new LocalAndroidProvider(),
  new LocalIosProvider(),
  new LambdaTestProvider(),
  new BrowserStackProvider(),
  new SauceLabsProvider(),
  new KobitonProvider(),
];

export const PROVIDER_IDS = providers.map((p) => p.id) as [ProviderId, ...ProviderId[]];

export function listProviders(): readonly DeviceProvider[] {
  return providers;
}

export function getProvider(id: string): DeviceProvider | undefined {
  return providers.find((p) => p.id === id);
}

/** Which provider created each session. A session id is only ever acted on by the provider that made it. */
const sessionOwner = new Map<string, ProviderId>();

export function rememberSession(sessionId: string, provider: ProviderId): void {
  sessionOwner.set(sessionId, provider);
}

export function providerOfSession(sessionId: string): ProviderId | undefined {
  return sessionOwner.get(sessionId);
}

export function forgetSession(sessionId: string): void {
  sessionOwner.delete(sessionId);
}

export function _resetForTests(): void {
  sessionOwner.clear();
}
