let globalLogSequence = 0;

type SequencedStderrOptions = {
  envVar?: string | null;
};

function shouldWrite(envVar: string | null | undefined): boolean {
  return !envVar || process.env[envVar] === '1';
}

function nextSequence(): number {
  globalLogSequence += 1;
  return globalLogSequence;
}

export function writeSequencedStderrLine(
  message: string,
  {
    envVar = null,
  }: SequencedStderrOptions = {},
): void {
  if (!shouldWrite(envVar)) {
    return;
  }
  const normalized = String(message ?? '').trim();
  const lines = normalized
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return;
  }
  for (const line of lines) {
    process.stderr.write(`[${nextSequence()}] ${line}\n`);
  }
}

export function writeSequencedDebugLog(
  tag: string,
  event: string,
  payload: unknown,
  {
    envVar = 'CODEXBRIDGE_DEBUG_WEIXIN',
  }: SequencedStderrOptions = {},
): void {
  if (!shouldWrite(envVar)) {
    return;
  }
  try {
    writeSequencedStderrLine(`[${tag}] ${event} ${JSON.stringify(payload)}`);
  } catch {
    writeSequencedStderrLine(`[${tag}] ${event}`);
  }
}
