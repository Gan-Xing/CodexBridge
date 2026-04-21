import { CodexProviderPlugin } from '../codex/plugin.js';

export class MiniMaxViaCLIProxyProviderPlugin extends CodexProviderPlugin {
  constructor(options: ConstructorParameters<typeof CodexProviderPlugin>[0] = {}) {
    super(options);
    this.kind = 'minimax-via-cliproxy';
    this.displayName = 'MiniMax via CLIProxyAPI';
  }
}
