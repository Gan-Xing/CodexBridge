import { createCodexBridgeRuntime } from './runtime/bootstrap.js';
import { WeixinPlatformPlugin } from './platforms/weixin/plugin.js';
import { TelegramPlatformPlugin } from './platforms/telegram/plugin.js';
import { loadCodexProfilesFromEnv } from './providers/codex/config.js';
import { CodexProviderPlugin } from './providers/codex/plugin.js';
import { OpenAINativeProviderPlugin } from './providers/openai_native/plugin.js';
import { MiniMaxViaCLIProxyProviderPlugin } from './providers/minimax/plugin.js';
import type { PlatformPluginContract } from './types/platform.js';
import type { ProviderPluginContract } from './types/provider.js';

export {
  createCodexBridgeRuntime,
  WeixinPlatformPlugin,
  TelegramPlatformPlugin,
  CodexProviderPlugin,
  loadCodexProfilesFromEnv,
  OpenAINativeProviderPlugin,
  MiniMaxViaCLIProxyProviderPlugin,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const codexProfiles = loadCodexProfilesFromEnv();
  const runtime = createCodexBridgeRuntime({
    platformPlugins: [
      new WeixinPlatformPlugin(),
      new TelegramPlatformPlugin(),
    ],
    providerPlugins: [
      new OpenAINativeProviderPlugin(),
      new MiniMaxViaCLIProxyProviderPlugin(),
    ],
    providerProfiles: codexProfiles.profiles,
    defaultProviderProfileId: codexProfiles.defaultProviderProfileId,
  });
  const summary = {
    platforms: runtime.registry.listPlatforms().map((plugin: PlatformPluginContract) => plugin.id),
    providers: runtime.registry.listProviders().map((plugin: ProviderPluginContract) => plugin.kind),
    providerProfiles: runtime.repositories.providerProfiles.list(),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
