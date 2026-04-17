export class OpenAINativeProviderPlugin {
  constructor() {
    this.kind = 'openai-native';
    this.displayName = 'OpenAI Native';
  }

  async startThread() {
    throw new Error('OpenAINativeProviderPlugin.startThread is not implemented yet');
  }

  async readThread() {
    throw new Error('OpenAINativeProviderPlugin.readThread is not implemented yet');
  }

  async listThreads() {
    throw new Error('OpenAINativeProviderPlugin.listThreads is not implemented yet');
  }

  async startTurn() {
    throw new Error('OpenAINativeProviderPlugin.startTurn is not implemented yet');
  }

  async interruptTurn() {
    throw new Error('OpenAINativeProviderPlugin.interruptTurn is not implemented yet');
  }
}
