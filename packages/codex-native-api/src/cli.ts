import path from 'node:path';
import { CodexNativeApiService } from './native_api_service.js';
import { parseServeCliArgs, normalizeServeHost, isLoopbackHost } from './cli_options.js';
import { runDaemonCommand, runDaemonSupervisor } from './daemon_manager.js';

async function main(argv: string[] = process.argv.slice(2)) {
  const command = String(argv[0] ?? '').trim().toLowerCase();
  if (command === 'daemon') {
    await runDaemonCommand(argv.slice(1));
    return;
  }
  if (command === 'daemon-supervisor') {
    await runDaemonSupervisor(argv.slice(1));
    return;
  }
  if (command === 'serve') {
    await serve(argv.slice(1));
    return;
  }
  await serve(argv);
}

async function serve(argv: string[]): Promise<void> {
  const options = parseCliArgs(argv);
  const defaultCwd = path.resolve(options.cwd ?? process.cwd());
  const host = normalizeServeHost(options);
  const service = new CodexNativeApiService({
    env: process.env,
    host,
    port: options.port,
    authPath: options.authPath,
    authToken: options.authToken,
    defaultCwd,
    providerProfileId: options.providerProfileId,
    defaultModel: options.defaultModel,
  });

  let stopped = false;
  const stop = async (signal: string) => {
    if (stopped) {
      return;
    }
    stopped = true;
    process.stdout.write(`stopping: ${signal}\n`);
    await service.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => { void stop('SIGINT'); });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });

  const binding = await service.start();
  process.stdout.write('codex-native-api started\n');
  process.stdout.write(`base_url: ${service.baseUrl}\n`);
  process.stdout.write(`default_cwd: ${defaultCwd}\n`);
  process.stdout.write(`provider_profile: ${binding.providerProfileId}\n`);
  process.stdout.write(`provider_kind: ${binding.providerKind}\n`);
  process.stdout.write(`provider_display_name: ${binding.providerDisplayName}\n`);
  process.stdout.write(`auth_path: ${binding.authPath ?? 'none'}\n`);
  process.stdout.write(`access_scope: ${isLoopbackHost(host) ? 'localhost' : 'public'}\n`);

  if (!isLoopbackHost(host) && !options.authToken) {
    process.stderr.write(
      'warning: public bind enabled without --auth-token; anyone who can reach this port can use your logged-in Codex runtime.\n',
    );
  }

  await new Promise<void>(() => {});
}

const parseCliArgs = parseServeCliArgs;

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exit(1);
  });
}

function formatCliError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

export {
  main,
  parseCliArgs,
};
