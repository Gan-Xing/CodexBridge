export class MiniMaxViaCLIProxyProviderPlugin {
  constructor() {
    this.kind = 'minimax-via-cliproxy';
    this.displayName = 'MiniMax via CLIProxyAPI';
  }

  async startThread() {
    throw new Error('MiniMaxViaCLIProxyProviderPlugin.startThread is not implemented yet');
  }

  async readThread() {
    throw new Error('MiniMaxViaCLIProxyProviderPlugin.readThread is not implemented yet');
  }

  async listThreads() {
    throw new Error('MiniMaxViaCLIProxyProviderPlugin.listThreads is not implemented yet');
  }

  async startTurn() {
    throw new Error('MiniMaxViaCLIProxyProviderPlugin.startTurn is not implemented yet');
  }
}
