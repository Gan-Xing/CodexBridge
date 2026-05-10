import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isLoopbackHost,
  normalizeServeHost,
  parseOptionalBoolean,
  parseOptionalSeconds,
  parsePort,
  parseServeCliArgs,
  type ServeCliOptions,
} from './cli_options.js';

export interface CodexNativeApiDaemonLayout {
  platform: NodeJS.Platform;
  homeDir: string;
  configDir: string;
  stateDir: string;
  logDir: string;
  envFile: string;
  stdoutLog: string;
  stderrLog: string;
  launchdLabel: string | null;
  launchdPlistPath: string | null;
  systemdServiceName: string | null;
  systemdUnitPath: string | null;
  windowsTaskName: string | null;
}

export interface CodexNativeApiDaemonInstallPlan {
  layout: CodexNativeApiDaemonLayout;
  serviceEnv: Record<string, string>;
  serviceEnvFileContent: string;
  launchSpec: SelfLaunchSpec;
  supervisorArgs: string[];
  generatedAuthToken: string | null;
  artifactPath: string | null;
  artifactContent: string | null;
}

interface SelfLaunchSpec {
  command: string;
  args: string[];
  workingDirectory: string;
}

interface DaemonCommandOptions {
  subcommand: 'install' | 'start' | 'stop' | 'restart' | 'status' | 'logs' | 'uninstall';
  serveOptions: ServeCliOptions;
  dryRun: boolean;
  follow: boolean;
  lines: number;
  restartSec: number | null;
  codexHome: string | null;
  codexRealBin: string | null;
  launchCommand: string | null;
  autolaunch: boolean | null;
}

interface SupervisorOptions {
  envFile: string | null;
  homeDir: string | null;
  stdoutLog: string | null;
  stderrLog: string | null;
  once: boolean;
}

const DAEMON_CONFIG_DIR_NAME = 'codex-native-api';
const DAEMON_STATE_DIR_NAME = '.codex-native-api';
const DAEMON_SERVICE_ENV_NAME = 'service.env';
const DAEMON_STDOUT_LOG_NAME = 'codex-native-api.out.log';
const DAEMON_STDERR_LOG_NAME = 'codex-native-api.err.log';
const LAUNCHD_LABEL = 'com.codexbridge.codex-native-api';
const SYSTEMD_SERVICE_NAME = 'codex-native-api.service';
const WINDOWS_TASK_NAME = 'CodexNativeApi';
const MANAGED_ENV_KEYS = [
  'CODEX_NATIVE_API_HOST',
  'CODEX_NATIVE_API_PORT',
  'CODEX_NATIVE_API_PUBLIC',
  'CODEX_NATIVE_API_AUTH_PATH',
  'CODEX_NATIVE_API_AUTH_TOKEN',
  'CODEX_NATIVE_API_DEFAULT_CWD',
  'CODEX_NATIVE_API_PROVIDER_PROFILE',
  'CODEX_NATIVE_API_DEFAULT_MODEL',
  'CODEX_NATIVE_API_RESTART_SEC',
  'CODEX_HOME',
  'CODEX_REAL_BIN',
  'CODEX_APP_LAUNCH_CMD',
  'CODEX_APP_AUTOLAUNCH',
];

export async function runDaemonCommand(argv: string[]): Promise<void> {
  const options = parseDaemonCommandArgs(argv);
  if (options.subcommand === 'install') {
    const plan = await buildDaemonInstallPlan(options);
    if (options.dryRun) {
      printInstallPlan(plan);
      return;
    }
    await installDaemon(plan);
    printInstallSuccess(plan);
    return;
  }

  if (options.dryRun) {
    throw new Error('--dry-run is only supported for daemon install.');
  }

  switch (options.subcommand) {
    case 'start':
      await startDaemon();
      return;
    case 'stop':
      await stopDaemon();
      return;
    case 'restart':
      await restartDaemon();
      return;
    case 'status':
      await statusDaemon();
      return;
    case 'logs':
      await logsDaemon({ follow: options.follow, lines: options.lines });
      return;
    case 'uninstall':
      await uninstallDaemon();
      return;
    default:
      throw new Error(`Unsupported daemon subcommand: ${String(options.subcommand)}`);
  }
}

export async function runDaemonSupervisor(argv: string[]): Promise<void> {
  const options = parseSupervisorArgs(argv);
  const layout = resolveDaemonLayout(process.env, {
    homeDir: options.homeDir ? path.resolve(options.homeDir) : null,
  });
  const envFile = path.resolve(options.envFile ?? layout.envFile);
  const stdoutLog = path.resolve(options.stdoutLog ?? layout.stdoutLog);
  const stderrLog = path.resolve(options.stderrLog ?? layout.stderrLog);

  await loadEnvFileIntoProcessEnv(envFile);
  process.env.HOME ||= layout.homeDir;
  process.env.USERPROFILE ||= layout.homeDir;
  if (process.platform === 'win32') {
    process.env.APPDATA ||= path.join(layout.homeDir, 'AppData', 'Roaming');
    process.env.LOCALAPPDATA ||= path.join(layout.homeDir, 'AppData', 'Local');
  }

  await fsp.mkdir(path.dirname(stdoutLog), { recursive: true });
  await fsp.mkdir(path.dirname(stderrLog), { recursive: true });

  let child: ReturnType<typeof spawn> | null = null;
  let stopping = false;
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  do {
    const code = await runSupervisorChild({
      stdoutLog,
      stderrLog,
      onChild: (nextChild) => {
        child = nextChild;
      },
    });
    child = null;
    if (stopping || options.once) {
      process.exitCode = typeof code === 'number' ? code : 0;
      break;
    }
    const restartMs = Math.max(
      0,
      Number.parseFloat(process.env.CODEX_NATIVE_API_RESTART_SEC ?? '2') * 1000,
    );
    await sleep(restartMs);
  } while (!stopping);

  function stop(signal: string) {
    if (stopping) {
      return;
    }
    stopping = true;
    writeLogLine(stderrLog, 'stderr', `[codex-native-api-daemon] stopping on ${signal}`);
    if (child && !child.killed) {
      child.kill(signal as NodeJS.Signals);
    }
  }
}

export async function buildDaemonInstallPlan(
  options: Pick<
    DaemonCommandOptions,
    'serveOptions' | 'restartSec' | 'codexHome' | 'codexRealBin' | 'launchCommand' | 'autolaunch'
  >,
  {
    platform = process.platform,
    env = process.env,
    currentWorkingDirectory = process.cwd(),
    entryPath = process.argv[1] ?? fileURLToPath(import.meta.url),
    nodeBin = process.execPath,
  }: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    currentWorkingDirectory?: string;
    entryPath?: string;
    nodeBin?: string;
  } = {},
): Promise<CodexNativeApiDaemonInstallPlan> {
  const layout = resolveDaemonLayout(env, { platform });
  const existingEnv = await readEnvFileRecord(layout.envFile);
  const launchSpec = resolveSelfLaunchSpec({
    entryPath,
    nodeBin,
  });

  const host = normalizeServeHost(options.serveOptions)
    ?? (normalizeString(existingEnv.CODEX_NATIVE_API_HOST) || '127.0.0.1');
  const publicBind = !isLoopbackHost(host);
  const authTokenFromExisting = normalizeString(existingEnv.CODEX_NATIVE_API_AUTH_TOKEN);
  const requestedAuthToken = normalizeString(options.serveOptions.authToken);
  const generatedAuthToken = publicBind && !requestedAuthToken && !authTokenFromExisting
    ? crypto.randomBytes(24).toString('hex')
    : null;

  const serviceEnv = {
    ...existingEnv,
    CODEX_NATIVE_API_HOST: host,
    CODEX_NATIVE_API_PORT: String(
      options.serveOptions.port
      ?? parsePort(existingEnv.CODEX_NATIVE_API_PORT ?? '')
      ?? 4242,
    ),
    CODEX_NATIVE_API_PUBLIC: publicBind ? '1' : '0',
    CODEX_NATIVE_API_AUTH_PATH:
      normalizeString(options.serveOptions.authPath)
      || normalizeString(existingEnv.CODEX_NATIVE_API_AUTH_PATH),
    CODEX_NATIVE_API_AUTH_TOKEN:
      requestedAuthToken
      || authTokenFromExisting
      || generatedAuthToken
      || '',
    CODEX_NATIVE_API_DEFAULT_CWD:
      normalizeString(options.serveOptions.cwd)
      || normalizeString(existingEnv.CODEX_NATIVE_API_DEFAULT_CWD)
      || currentWorkingDirectory,
    CODEX_NATIVE_API_PROVIDER_PROFILE:
      normalizeString(options.serveOptions.providerProfileId)
      || normalizeString(existingEnv.CODEX_NATIVE_API_PROVIDER_PROFILE),
    CODEX_NATIVE_API_DEFAULT_MODEL:
      normalizeString(options.serveOptions.defaultModel)
      || normalizeString(existingEnv.CODEX_NATIVE_API_DEFAULT_MODEL)
      || normalizeString(env.CODEX_DEFAULT_MODEL),
    CODEX_NATIVE_API_RESTART_SEC: String(
      options.restartSec
      ?? parseOptionalSeconds(existingEnv.CODEX_NATIVE_API_RESTART_SEC)
      ?? 2,
    ),
    CODEX_HOME:
      normalizeString(options.codexHome)
      || normalizeString(existingEnv.CODEX_HOME)
      || normalizeString(env.CODEX_HOME)
      || path.join(layout.homeDir, '.codex'),
    CODEX_REAL_BIN:
      normalizeString(options.codexRealBin)
      || normalizeString(existingEnv.CODEX_REAL_BIN)
      || normalizeString(env.CODEX_REAL_BIN)
      || (findCommandOnPath(platform, env.PATH, ['codex', 'codex.exe', 'codex.cmd', 'codex.bat']) ?? ''),
    CODEX_APP_LAUNCH_CMD:
      normalizeString(options.launchCommand)
      || normalizeString(existingEnv.CODEX_APP_LAUNCH_CMD)
      || normalizeString(env.CODEX_APP_LAUNCH_CMD),
    CODEX_APP_AUTOLAUNCH: String(
      options.autolaunch
      ?? parseOptionalBoolean(existingEnv.CODEX_APP_AUTOLAUNCH, parseOptionalBoolean(env.CODEX_APP_AUTOLAUNCH, false)),
    ),
  };

  const supervisorArgs = [
    ...launchSpec.args,
    'daemon-supervisor',
    '--home-dir', layout.homeDir,
    '--env-file', layout.envFile,
    '--stdout-log', layout.stdoutLog,
    '--stderr-log', layout.stderrLog,
  ];
  const serviceEnvFileContent = renderServiceEnvFile(serviceEnv);

  let artifactPath: string | null = null;
  let artifactContent: string | null = null;
  if (platform === 'darwin') {
    artifactPath = layout.launchdPlistPath;
    artifactContent = renderLaunchdPlist({
      label: layout.launchdLabel!,
      supervisorCommand: launchSpec.command,
      supervisorArgs,
      workingDirectory: launchSpec.workingDirectory,
      stdoutLog: layout.stdoutLog,
      stderrLog: layout.stderrLog,
      pathEnv: buildServicePathEnv(platform, env.PATH, launchSpec.command),
      homeDir: layout.homeDir,
    });
  } else if (platform === 'linux') {
    artifactPath = layout.systemdUnitPath;
    artifactContent = renderSystemdUnit({
      description: 'Codex Native API',
      envFile: layout.envFile,
      launchSpec,
      supervisorArgs,
      pathEnv: buildServicePathEnv(platform, env.PATH, launchSpec.command),
      homeDir: layout.homeDir,
      userName: resolveUserName(env),
      logName: env.LOGNAME || resolveUserName(env),
    });
  }

  return {
    layout,
    serviceEnv,
    serviceEnvFileContent,
    launchSpec,
    supervisorArgs,
    generatedAuthToken,
    artifactPath,
    artifactContent,
  };
}

export function resolveDaemonLayout(
  env: NodeJS.ProcessEnv = process.env,
  {
    platform = process.platform,
    homeDir = null,
  }: {
    platform?: NodeJS.Platform;
    homeDir?: string | null;
  } = {},
): CodexNativeApiDaemonLayout {
  if (platform === 'win32') {
    const winPath = path.win32;
    const resolvedHomeDir = winPath.resolve(homeDir || resolveHomeDir(env, platform));
    const appData = winPath.resolve(env.APPDATA || winPath.join(resolvedHomeDir, 'AppData', 'Roaming'));
    const configDir = winPath.join(appData, DAEMON_CONFIG_DIR_NAME);
    const stateDir = winPath.join(resolvedHomeDir, DAEMON_STATE_DIR_NAME);
    const logDir = winPath.join(stateDir, 'logs');
    return {
      platform,
      homeDir: resolvedHomeDir,
      configDir,
      stateDir,
      logDir,
      envFile: winPath.join(configDir, DAEMON_SERVICE_ENV_NAME),
      stdoutLog: winPath.join(logDir, DAEMON_STDOUT_LOG_NAME),
      stderrLog: winPath.join(logDir, DAEMON_STDERR_LOG_NAME),
      launchdLabel: null,
      launchdPlistPath: null,
      systemdServiceName: null,
      systemdUnitPath: null,
      windowsTaskName: WINDOWS_TASK_NAME,
    };
  }

  const resolvedHomeDir = path.resolve(homeDir || resolveHomeDir(env, platform));
  const configRoot = path.resolve(env.XDG_CONFIG_HOME || path.join(resolvedHomeDir, '.config'));
  const configDir = path.join(configRoot, DAEMON_CONFIG_DIR_NAME);
  const stateDir = path.join(resolvedHomeDir, DAEMON_STATE_DIR_NAME);
  const logDir = path.join(stateDir, 'logs');
  if (platform === 'darwin') {
    return {
      platform,
      homeDir: resolvedHomeDir,
      configDir,
      stateDir,
      logDir,
      envFile: path.join(configDir, DAEMON_SERVICE_ENV_NAME),
      stdoutLog: path.join(logDir, DAEMON_STDOUT_LOG_NAME),
      stderrLog: path.join(logDir, DAEMON_STDERR_LOG_NAME),
      launchdLabel: LAUNCHD_LABEL,
      launchdPlistPath: path.join(resolvedHomeDir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
      systemdServiceName: null,
      systemdUnitPath: null,
      windowsTaskName: null,
    };
  }

  return {
    platform,
    homeDir: resolvedHomeDir,
    configDir,
    stateDir,
    logDir,
    envFile: path.join(configDir, DAEMON_SERVICE_ENV_NAME),
    stdoutLog: path.join(logDir, DAEMON_STDOUT_LOG_NAME),
    stderrLog: path.join(logDir, DAEMON_STDERR_LOG_NAME),
    launchdLabel: null,
    launchdPlistPath: null,
    systemdServiceName: SYSTEMD_SERVICE_NAME,
    systemdUnitPath: path.join(configRoot, 'systemd', 'user', SYSTEMD_SERVICE_NAME),
    windowsTaskName: null,
  };
}

export function renderServiceEnvFile(record: Record<string, string>): string {
  const normalized = new Map<string, string>();
  Object.entries(record).forEach(([key, value]) => {
    const normalizedKey = normalizeString(key);
    if (!normalizedKey) {
      return;
    }
    normalized.set(normalizedKey, String(value ?? ''));
  });

  const lines: string[] = [
    '# Generated by codex-native-api daemon install',
    '# Safe to edit after install.',
    '',
    '# Managed Codex Native API service values',
  ];
  MANAGED_ENV_KEYS.forEach((key) => {
    lines.push(`${key}=${normalized.get(key) ?? ''}`);
    normalized.delete(key);
  });

  if (normalized.size > 0) {
    lines.push('', '# Additional environment overrides');
    Array.from(normalized.keys()).sort().forEach((key) => {
      lines.push(`${key}=${normalized.get(key) ?? ''}`);
    });
  }

  return `${lines.join('\n')}\n`;
}

export function renderSystemdUnit({
  description,
  envFile,
  launchSpec,
  supervisorArgs,
  pathEnv,
  homeDir,
  userName,
  logName,
}: {
  description: string;
  envFile: string;
  launchSpec: SelfLaunchSpec;
  supervisorArgs: string[];
  pathEnv: string;
  homeDir: string;
  userName: string;
  logName: string;
}): string {
  const execStart = quoteSystemdExecStart(launchSpec.command, supervisorArgs);
  return [
    '[Unit]',
    `Description=${description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${launchSpec.workingDirectory}`,
    `Environment=HOME=${homeDir}`,
    `Environment=USER=${userName}`,
    `Environment=LOGNAME=${logName}`,
    `Environment=PATH=${pathEnv}`,
    `EnvironmentFile=${envFile}`,
    `ExecStart=${execStart}`,
    'Restart=always',
    'RestartSec=2',
    'KillMode=process',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function renderLaunchdPlist({
  label,
  supervisorCommand,
  supervisorArgs,
  workingDirectory,
  stdoutLog,
  stderrLog,
  pathEnv,
  homeDir,
}: {
  label: string;
  supervisorCommand: string;
  supervisorArgs: string[];
  workingDirectory: string;
  stdoutLog: string;
  stderrLog: string;
  pathEnv: string;
  homeDir: string;
}): string {
  const allArgs = [supervisorCommand, ...supervisorArgs];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${escapeXml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...allArgs.map((value) => `    <string>${escapeXml(value)}</string>`),
    '  </array>',
    `  <key>WorkingDirectory</key><string>${escapeXml(workingDirectory)}</string>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>StandardOutPath</key><string>${escapeXml(stdoutLog)}</string>`,
    `  <key>StandardErrorPath</key><string>${escapeXml(stderrLog)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>HOME</key><string>${escapeXml(homeDir)}</string>`,
    `    <key>PATH</key><string>${escapeXml(pathEnv)}</string>`,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function buildWindowsInstallScript(plan: CodexNativeApiDaemonInstallPlan): string {
  const launchArgs = buildWindowsCommandArgumentString(plan.supervisorArgs);
  const taskName = plan.layout.windowsTaskName ?? WINDOWS_TASK_NAME;
  return [
    '$ErrorActionPreference = "Stop"',
    `$TaskName = ${toPowerShellString(taskName)}`,
    `$NodeBin = ${toPowerShellString(plan.launchSpec.command)}`,
    `$Arguments = ${toPowerShellString(launchArgs)}`,
    '$CurrentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
    '$Action = New-ScheduledTaskAction -Execute $NodeBin -Argument $Arguments',
    '$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentIdentity',
    '$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 3650) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable',
    '$Principal = New-ScheduledTaskPrincipal -UserId $CurrentIdentity -LogonType Interactive -RunLevel Highest',
    'Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null',
    'Start-ScheduledTask -TaskName $TaskName',
    `Write-Host ${toPowerShellString(`Installed scheduled task: ${taskName}`)}`,
  ].join('\n');
}

async function installDaemon(plan: CodexNativeApiDaemonInstallPlan): Promise<void> {
  await ensureDaemonDirectories(plan.layout);
  await fsp.writeFile(plan.layout.envFile, plan.serviceEnvFileContent, 'utf8');

  switch (plan.layout.platform) {
    case 'darwin':
      await fsp.writeFile(plan.layout.launchdPlistPath!, plan.artifactContent ?? '', 'utf8');
      await runCommand('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, plan.layout.launchdPlistPath!], { allowFailure: true });
      await runCommand('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, plan.layout.launchdPlistPath!]);
      await runCommand('launchctl', ['enable', `gui/${process.getuid?.() ?? 0}/${plan.layout.launchdLabel!}`]);
      await runCommand('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${plan.layout.launchdLabel!}`]);
      return;
    case 'linux':
      await fsp.mkdir(path.dirname(plan.layout.systemdUnitPath!), { recursive: true });
      await fsp.writeFile(plan.layout.systemdUnitPath!, plan.artifactContent ?? '', 'utf8');
      await runCommand('systemctl', ['--user', 'daemon-reload']);
      await runCommand('systemctl', ['--user', 'enable', '--now', plan.layout.systemdServiceName!]);
      if (await commandExists('loginctl')) {
        await runCommand('loginctl', ['enable-linger', resolveUserName(process.env)], { allowFailure: true });
      }
      return;
    case 'win32':
      await runPowerShellScript(buildWindowsInstallScript(plan));
      return;
    default:
      throw new Error(`Unsupported daemon platform: ${plan.layout.platform}`);
  }
}

async function startDaemon(): Promise<void> {
  const layout = resolveDaemonLayout();
  switch (layout.platform) {
    case 'darwin':
      assertFileExists(layout.launchdPlistPath, 'launchd plist');
      await runCommand('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, layout.launchdPlistPath!], { allowFailure: true });
      await runCommand('launchctl', ['enable', `gui/${process.getuid?.() ?? 0}/${layout.launchdLabel!}`]);
      await runCommand('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${layout.launchdLabel!}`]);
      return;
    case 'linux':
      assertFileExists(layout.systemdUnitPath, 'systemd user unit');
      await runCommand('systemctl', ['--user', 'start', layout.systemdServiceName!]);
      return;
    case 'win32':
      await runPowerShellScript([
        '$ErrorActionPreference = "Stop"',
        `$TaskName = ${toPowerShellString(layout.windowsTaskName ?? WINDOWS_TASK_NAME)}`,
        'Start-ScheduledTask -TaskName $TaskName',
      ].join('\n'));
      return;
    default:
      throw new Error(`Unsupported daemon platform: ${layout.platform}`);
  }
}

async function stopDaemon(): Promise<void> {
  const layout = resolveDaemonLayout();
  switch (layout.platform) {
    case 'darwin':
      assertFileExists(layout.launchdPlistPath, 'launchd plist');
      await runCommand('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, layout.launchdPlistPath!], { allowFailure: true });
      return;
    case 'linux':
      await runCommand('systemctl', ['--user', 'stop', layout.systemdServiceName!]);
      return;
    case 'win32':
      await runPowerShellScript([
        '$ErrorActionPreference = "Stop"',
        `$TaskName = ${toPowerShellString(layout.windowsTaskName ?? WINDOWS_TASK_NAME)}`,
        'Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue',
      ].join('\n'));
      return;
    default:
      throw new Error(`Unsupported daemon platform: ${layout.platform}`);
  }
}

async function restartDaemon(): Promise<void> {
  const layout = resolveDaemonLayout();
  switch (layout.platform) {
    case 'darwin':
      assertFileExists(layout.launchdPlistPath, 'launchd plist');
      await runCommand('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, layout.launchdPlistPath!], { allowFailure: true });
      await runCommand('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, layout.launchdPlistPath!]);
      await runCommand('launchctl', ['enable', `gui/${process.getuid?.() ?? 0}/${layout.launchdLabel!}`]);
      await runCommand('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${layout.launchdLabel!}`]);
      return;
    case 'linux':
      await runCommand('systemctl', ['--user', 'restart', layout.systemdServiceName!]);
      return;
    case 'win32':
      await runPowerShellScript([
        '$ErrorActionPreference = "Stop"',
        `$TaskName = ${toPowerShellString(layout.windowsTaskName ?? WINDOWS_TASK_NAME)}`,
        'Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue',
        'Start-ScheduledTask -TaskName $TaskName',
      ].join('\n'));
      return;
    default:
      throw new Error(`Unsupported daemon platform: ${layout.platform}`);
  }
}

async function statusDaemon(): Promise<void> {
  const layout = resolveDaemonLayout();
  switch (layout.platform) {
    case 'darwin':
      await runCommand('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${layout.launchdLabel!}`]);
      return;
    case 'linux':
      await runCommand('systemctl', ['--user', 'status', layout.systemdServiceName!, '--no-pager']);
      return;
    case 'win32':
      await runPowerShellScript([
        '$ErrorActionPreference = "Stop"',
        `$TaskName = ${toPowerShellString(layout.windowsTaskName ?? WINDOWS_TASK_NAME)}`,
        '$Task = Get-ScheduledTask -TaskName $TaskName',
        '$Info = Get-ScheduledTaskInfo -TaskName $TaskName',
        '$Task | Select-Object TaskName, State | Format-List | Out-String | Write-Host',
        '$Info | Select-Object LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns | Format-List | Out-String | Write-Host',
      ].join('\n'));
      return;
    default:
      throw new Error(`Unsupported daemon platform: ${layout.platform}`);
  }
}

async function logsDaemon({
  follow,
  lines,
}: {
  follow: boolean;
  lines: number;
}): Promise<void> {
  const layout = resolveDaemonLayout();
  if (layout.platform === 'linux') {
    const args = ['--user', '-u', layout.systemdServiceName!, '-n', String(lines)];
    if (follow) {
      args.push('-f');
    }
    await runCommand('journalctl', args);
    return;
  }

  await printFileTail(layout.stdoutLog, lines, process.stdout, `== ${layout.stdoutLog} ==\n`);
  await printFileTail(layout.stderrLog, lines, process.stderr, `== ${layout.stderrLog} ==\n`);
  if (!follow) {
    return;
  }
  await followLogFiles([layout.stdoutLog, layout.stderrLog]);
}

async function uninstallDaemon(): Promise<void> {
  const layout = resolveDaemonLayout();
  switch (layout.platform) {
    case 'darwin':
      await runCommand('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, layout.launchdPlistPath!], { allowFailure: true });
      await removeIfExists(layout.launchdPlistPath);
      return;
    case 'linux':
      await runCommand('systemctl', ['--user', 'disable', '--now', layout.systemdServiceName!], { allowFailure: true });
      await removeIfExists(layout.systemdUnitPath);
      await runCommand('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
      return;
    case 'win32':
      await runPowerShellScript([
        '$ErrorActionPreference = "Stop"',
        `$TaskName = ${toPowerShellString(layout.windowsTaskName ?? WINDOWS_TASK_NAME)}`,
        'Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue',
      ].join('\n'));
      return;
    default:
      throw new Error(`Unsupported daemon platform: ${layout.platform}`);
  }
}

async function runSupervisorChild({
  stdoutLog,
  stderrLog,
  onChild,
}: {
  stdoutLog: string;
  stderrLog: string;
  onChild: (child: ReturnType<typeof spawn>) => void;
}): Promise<number | null> {
  const launchSpec = resolveSelfLaunchSpec();
  const serveArgs = [
    ...launchSpec.args,
    'serve',
    ...buildServeArgsFromEnv(process.env),
  ];
  writeLogLine(stdoutLog, 'stdout', `[codex-native-api-daemon] starting: ${launchSpec.command} ${serveArgs.join(' ')}`);
  const child = spawn(launchSpec.command, serveArgs, {
    cwd: launchSpec.workingDirectory,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  onChild(child);
  child.stdout.on('data', (chunk) => writeLogChunk(stdoutLog, 'stdout', chunk));
  child.stderr.on('data', (chunk) => writeLogChunk(stderrLog, 'stderr', chunk));

  return await new Promise((resolve) => {
    child.once('error', (error) => {
      writeLogLine(stderrLog, 'stderr', `[codex-native-api-daemon] child spawn failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      writeLogLine(stderrLog, 'stderr', `[codex-native-api-daemon] child exited code=${code ?? ''} signal=${signal ?? ''}`);
      resolve(code);
    });
  });
}

function resolveSelfLaunchSpec({
  entryPath = process.argv[1] ?? fileURLToPath(import.meta.url),
  nodeBin = process.execPath,
}: {
  entryPath?: string;
  nodeBin?: string;
} = {}): SelfLaunchSpec {
  const resolvedEntryPath = path.resolve(entryPath);
  const packageRoot = path.resolve(path.dirname(resolvedEntryPath), '..');
  if (resolvedEntryPath.endsWith('.ts')) {
    return {
      command: nodeBin,
      args: ['--import', 'tsx', resolvedEntryPath],
      workingDirectory: packageRoot,
    };
  }
  return {
    command: nodeBin,
    args: [resolvedEntryPath],
    workingDirectory: packageRoot,
  };
}

function buildServeArgsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  const host = normalizeString(env.CODEX_NATIVE_API_HOST);
  const publicBind = parseOptionalBoolean(env.CODEX_NATIVE_API_PUBLIC, false);
  if (host) {
    args.push('--host', host);
  } else if (publicBind) {
    args.push('--public');
  }
  const port = parsePort(env.CODEX_NATIVE_API_PORT ?? '');
  if (port !== null) {
    args.push('--port', String(port));
  }
  const authPath = normalizeString(env.CODEX_NATIVE_API_AUTH_PATH);
  if (authPath) {
    args.push('--auth-path', authPath);
  }
  const authToken = normalizeString(env.CODEX_NATIVE_API_AUTH_TOKEN);
  if (authToken) {
    args.push('--auth-token', authToken);
  }
  const cwd = normalizeString(env.CODEX_NATIVE_API_DEFAULT_CWD);
  if (cwd) {
    args.push('--cwd', cwd);
  }
  const providerProfileId = normalizeString(env.CODEX_NATIVE_API_PROVIDER_PROFILE);
  if (providerProfileId) {
    args.push('--provider-profile', providerProfileId);
  }
  const defaultModel = normalizeString(env.CODEX_NATIVE_API_DEFAULT_MODEL);
  if (defaultModel) {
    args.push('--default-model', defaultModel);
  }
  return args;
}

function parseDaemonCommandArgs(argv: string[]): DaemonCommandOptions {
  const subcommand = normalizeDaemonSubcommand(argv[0]);
  if (!subcommand) {
    throw new Error('Daemon command requires one of: install, start, stop, restart, status, logs, uninstall.');
  }
  const args = argv.slice(1);
  const serveOptions = parseServeCliArgs(args);
  let dryRun = false;
  let follow = false;
  let lines = 80;
  let restartSec: number | null = null;
  let codexHome: string | null = null;
  let codexRealBin: string | null = null;
  let launchCommand: string | null = null;
  let autolaunch: boolean | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--follow' || arg === '-f') {
      follow = true;
      continue;
    }
    if ((arg === '--lines' || arg === '-n') && next) {
      const parsed = Number.parseInt(next, 10);
      lines = Number.isFinite(parsed) && parsed > 0 ? parsed : 80;
      index += 1;
      continue;
    }
    if (arg === '--restart-sec' && next) {
      restartSec = parseOptionalSeconds(next);
      index += 1;
      continue;
    }
    if (arg === '--codex-home' && next) {
      codexHome = next;
      index += 1;
      continue;
    }
    if (arg === '--codex-bin' && next) {
      codexRealBin = next;
      index += 1;
      continue;
    }
    if (arg === '--launch-cmd' && next) {
      launchCommand = next;
      index += 1;
      continue;
    }
    if (arg === '--autolaunch') {
      autolaunch = true;
      continue;
    }
    if (arg === '--no-autolaunch') {
      autolaunch = false;
      continue;
    }
  }

  return {
    subcommand,
    serveOptions,
    dryRun,
    follow,
    lines,
    restartSec,
    codexHome,
    codexRealBin,
    launchCommand,
    autolaunch,
  };
}

function parseSupervisorArgs(argv: string[]): SupervisorOptions {
  const options: SupervisorOptions = {
    envFile: null,
    homeDir: null,
    stdoutLog: null,
    stderrLog: null,
    once: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--once') {
      options.once = true;
      continue;
    }
    if (arg === '--env-file' && next) {
      options.envFile = next;
      index += 1;
      continue;
    }
    if (arg === '--home-dir' && next) {
      options.homeDir = next;
      index += 1;
      continue;
    }
    if (arg === '--stdout-log' && next) {
      options.stdoutLog = next;
      index += 1;
      continue;
    }
    if (arg === '--stderr-log' && next) {
      options.stderrLog = next;
      index += 1;
      continue;
    }
  }
  return options;
}

function normalizeDaemonSubcommand(value: string | undefined): DaemonCommandOptions['subcommand'] | null {
  const normalized = normalizeString(value).toLowerCase();
  if (
    normalized === 'install'
    || normalized === 'start'
    || normalized === 'stop'
    || normalized === 'restart'
    || normalized === 'status'
    || normalized === 'logs'
    || normalized === 'uninstall'
  ) {
    return normalized;
  }
  return null;
}

async function ensureDaemonDirectories(layout: CodexNativeApiDaemonLayout): Promise<void> {
  await fsp.mkdir(layout.configDir, { recursive: true });
  await fsp.mkdir(layout.logDir, { recursive: true });
  if (layout.platform === 'darwin' && layout.launchdPlistPath) {
    await fsp.mkdir(path.dirname(layout.launchdPlistPath), { recursive: true });
  }
  if (layout.platform === 'linux' && layout.systemdUnitPath) {
    await fsp.mkdir(path.dirname(layout.systemdUnitPath), { recursive: true });
  }
}

async function readEnvFileRecord(filePath: string): Promise<Record<string, string>> {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return parseEnvText(content);
  } catch {
    return {};
  }
}

async function loadEnvFileIntoProcessEnv(filePath: string): Promise<void> {
  const record = await readEnvFileRecord(filePath);
  Object.entries(record).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

function parseEnvText(content: string): Record<string, string> {
  const record: Record<string, string> = {};
  content.split(/\r?\n/u).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      return;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      return;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      return;
    }
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    record[key] = value;
  });
  return record;
}

async function runCommand(
  command: string,
  args: string[],
  {
    allowFailure = false,
  }: {
    allowFailure?: boolean;
  } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', (error) => {
      if (allowFailure) {
        resolve();
        return;
      }
      reject(error);
    });
    child.once('exit', (code) => {
      if (!allowFailure && code !== 0) {
        reject(new Error(`Command failed (${command} ${args.join(' ')}): exit ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function runPowerShellScript(script: string): Promise<void> {
  const powershell = process.platform === 'win32' ? 'powershell.exe' : 'powershell';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await runCommand(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
}

async function commandExists(command: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command, ['--version'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function printFileTail(
  filePath: string,
  lines: number,
  stream: NodeJS.WriteStream,
  header: string,
): Promise<void> {
  stream.write(header);
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    const tail = content.split(/\r?\n/u).slice(-lines).join('\n').trim();
    if (tail) {
      stream.write(`${tail}\n`);
    }
  } catch {
    stream.write('(no log yet)\n');
  }
}

async function followLogFiles(filePaths: string[]): Promise<void> {
  const positions = new Map<string, number>();
  for (const filePath of filePaths) {
    try {
      const stats = await fsp.stat(filePath);
      positions.set(filePath, stats.size);
    } catch {
      positions.set(filePath, 0);
    }
  }
  await new Promise<void>(() => {
    const timer = setInterval(async () => {
      for (const filePath of filePaths) {
        try {
          const stats = await fsp.stat(filePath);
          const previousSize = positions.get(filePath) ?? 0;
          if (stats.size <= previousSize) {
            continue;
          }
          const handle = await fsp.open(filePath, 'r');
          try {
            const buffer = Buffer.alloc(stats.size - previousSize);
            await handle.read(buffer, 0, buffer.length, previousSize);
            process.stdout.write(buffer.toString('utf8'));
            positions.set(filePath, stats.size);
          } finally {
            await handle.close();
          }
        } catch {
          // Ignore transient read errors while following logs.
        }
      }
    }, 1000);
    process.on('SIGINT', () => clearInterval(timer));
    process.on('SIGTERM', () => clearInterval(timer));
  });
}

function buildServicePathEnv(platform: NodeJS.Platform, currentPath: string | undefined, nodeBin: string): string {
  const parts = new Set<string>();
  const nodeDir = path.dirname(nodeBin);
  if (nodeDir) {
    parts.add(nodeDir);
  }
  String(currentPath ?? '').split(path.delimiter).forEach((entry) => {
    const normalized = normalizeString(entry);
    if (normalized) {
      parts.add(normalized);
    }
  });
  if (platform === 'darwin') {
    ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].forEach((entry) => parts.add(entry));
  } else if (platform === 'linux') {
    ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].forEach((entry) => parts.add(entry));
  }
  return Array.from(parts).join(path.delimiter);
}

function quoteSystemdExecStart(command: string, args: string[]): string {
  return [command, ...args].map(quoteSystemdArg).join(' ');
}

function quoteSystemdArg(value: string): string {
  if (!/[\s"\\]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function buildWindowsCommandArgumentString(args: string[]): string {
  return args.map(quoteWindowsArgument).join(' ');
}

function quoteWindowsArgument(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  let escaped = '"';
  let slashCount = 0;
  for (const character of value) {
    if (character === '\\') {
      slashCount += 1;
      continue;
    }
    if (character === '"') {
      escaped += '\\'.repeat((slashCount * 2) + 1);
      escaped += '"';
      slashCount = 0;
      continue;
    }
    if (slashCount > 0) {
      escaped += '\\'.repeat(slashCount);
      slashCount = 0;
    }
    escaped += character;
  }
  if (slashCount > 0) {
    escaped += '\\'.repeat(slashCount * 2);
  }
  escaped += '"';
  return escaped;
}

function toPowerShellString(value: string): string {
  return `'${String(value ?? '').replace(/'/gu, "''")}'`;
}

function resolveHomeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const requested = normalizeString(platform === 'win32' ? (env.USERPROFILE || env.HOME) : (env.HOME || env.USERPROFILE));
  return requested || os.homedir();
}

function resolveUserName(env: NodeJS.ProcessEnv): string {
  return normalizeString(env.USER) || normalizeString(env.LOGNAME) || os.userInfo().username;
}

function findCommandOnPath(
  platform: NodeJS.Platform,
  currentPath: string | undefined,
  candidates: string[],
): string | null {
  const pathEntries = String(currentPath ?? '').split(path.delimiter).filter((entry) => entry.trim());
  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const resolved = path.join(entry, candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
    if (platform !== 'win32') {
      continue;
    }
    const normalizedCandidates = candidates.flatMap((candidate) => (
      candidate.endsWith('.exe') || candidate.endsWith('.cmd') || candidate.endsWith('.bat')
        ? [candidate]
        : [`${candidate}.exe`, `${candidate}.cmd`, `${candidate}.bat`]
    ));
    for (const candidate of normalizedCandidates) {
      const resolved = path.join(entry, candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
  }
  return null;
}

async function removeIfExists(filePath: string | null): Promise<void> {
  if (!filePath) {
    return;
  }
  try {
    await fsp.unlink(filePath);
  } catch {
    // Ignore missing files during uninstall.
  }
}

function assertFileExists(filePath: string | null, label: string): void {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} is not installed: ${filePath ?? 'unknown path'}`);
  }
}

function printInstallPlan(plan: CodexNativeApiDaemonInstallPlan): void {
  process.stdout.write(`platform: ${plan.layout.platform}\n`);
  process.stdout.write(`env_file: ${plan.layout.envFile}\n`);
  if (plan.artifactPath) {
    process.stdout.write(`service_artifact: ${plan.artifactPath}\n`);
  }
  if (plan.generatedAuthToken) {
    process.stdout.write(`generated_auth_token: ${plan.generatedAuthToken}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(plan.serviceEnvFileContent);
  if (plan.artifactContent) {
    process.stdout.write('\n');
    process.stdout.write(plan.artifactContent);
    if (!plan.artifactContent.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }
  if (plan.layout.platform === 'win32') {
    process.stdout.write('\n');
    process.stdout.write(`${buildWindowsInstallScript(plan)}\n`);
  }
}

function printInstallSuccess(plan: CodexNativeApiDaemonInstallPlan): void {
  process.stdout.write(`daemon installed for ${plan.layout.platform}\n`);
  process.stdout.write(`env_file: ${plan.layout.envFile}\n`);
  if (plan.artifactPath) {
    process.stdout.write(`service_artifact: ${plan.artifactPath}\n`);
  }
  process.stdout.write(`stdout_log: ${plan.layout.stdoutLog}\n`);
  process.stdout.write(`stderr_log: ${plan.layout.stderrLog}\n`);
  if (plan.generatedAuthToken) {
    process.stdout.write(`auth_token: ${plan.generatedAuthToken}\n`);
  }
}

function writeLogChunk(filePath: string, streamName: 'stdout' | 'stderr', chunk: unknown): void {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  if (streamName === 'stderr') {
    process.stderr.write(text);
  } else {
    process.stdout.write(text);
  }
  fs.appendFile(filePath, text, () => {});
}

function writeLogLine(filePath: string, streamName: 'stdout' | 'stderr', line: string): void {
  writeLogChunk(filePath, streamName, `${new Date().toISOString()} ${line}\n`);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
