import type { PublishConfig } from '../../config/index.js';
import { FakePublishProvider } from './fakePublishProvider.js';
import type { PublishProvider } from './types.js';

export * from './types.js';
export { FakePublishProvider, type FakePublishCall, type FakePublishOptions, type ScriptedPublishReply } from './fakePublishProvider.js';

/** Builds the provider chosen by configuration. Starts nothing and never touches the network. */
export function createPublishProvider(cfg: PublishConfig): PublishProvider {
  return new FakePublishProvider();
}
