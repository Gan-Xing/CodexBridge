import { createCodexBridgeRuntime } from './runtime/bootstrap.js';
import { WeixinPlatformPlugin } from './platforms/weixin/plugin.js';
import { TelegramPlatformPlugin } from './platforms/telegram/plugin.js';
import { loadCodexProfilesFromEnv } from './providers/codex/config.js';
import { CodexProviderPlugin } from './providers/codex/plugin.js';
import { OpenAINativeProviderPlugin } from './providers/openai_native/plugin.js';
import { MiniMaxViaCLIProxyProviderPlugin } from './providers/minimax/plugin.js';

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
      new CodexProviderPlugin(),
    ],
    providerProfiles: codexProfiles.profiles,
    defaultProviderProfileId: codexProfiles.defaultProviderProfileId,
  });
  const summary = {
    platforms: runtime.registry.listPlatforms().map((plugin) => plugin.id),
    providers: runtime.registry.listProviders().map((plugin) => plugin.kind),
    providerProfiles: runtime.repositories.providerProfiles.list(),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
