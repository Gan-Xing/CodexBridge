#!/usr/bin/env node

import {
  createCodexGatewayStandaloneServerFromEnv,
} from './server/standalone_server.js';

async function main(): Promise<void> {
  const { config, server } = createCodexGatewayStandaloneServerFromEnv(process.env);
  await server.start();

  console.log('Codex Gateway standalone server started.');
  console.log(`Provider preset: ${config.presetId}`);
  console.log(`Provider: ${config.providerName} (${config.providerKind})`);
  console.log(`Upstream base URL: ${config.upstreamBaseUrl}`);
  console.log(`Default model: ${config.defaultModel}`);
  console.log(`Local base URL: ${server.baseUrl}`);
  console.log(`Model catalog source: ${config.modelCatalogSource}`);
  console.log('Routes: GET /v1/models, POST /v1/responses, POST /v1/responses/compact');
  console.log('Press Ctrl+C to stop.');

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, stopping Codex Gateway standalone server...`);
    await server.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
