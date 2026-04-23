import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  TurnArtifactContext,
  TurnArtifactDeliveryState,
  TurnArtifactIntent,
  TurnArtifactNoticeCode,
  TurnArtifactRejectedItem,
} from '../types/core.js';
import type { OutputArtifact, OutputArtifactKind, ProviderTurnResult } from '../types/provider.js';

const MANIFEST_FENCE = 'codexbridge-artifacts';
const FALLBACK_SCAN_LIMIT = 32;
const DEFAULT_DELIVERABLE_BASENAME = 'deliverable';
const DEFAULT_MAX_ARTIFACT_COUNT = 3;
const DEFAULT_MAX_ARTIFACT_SIZE_BYTES = 25 * 1024 * 1024;

interface DeclaredArtifactManifestEntry {
  path?: string | null;
  kind?: string | null;
  displayName?: string | null;
  fileName?: string | null;
  name?: string | null;
  title?: string | null;
  mimeType?: string | null;
  caption?: string | null;
}

interface MaterializedArtifactResult {
  artifacts: OutputArtifact[];
  rejected: TurnArtifactRejectedItem[];
}

interface ExtractedDeclaredArtifactResult {
  cleanText: string;
  entries: DeclaredArtifactManifestEntry[];
  invalidManifestCount: number;
}

interface FallbackArtifactResult extends MaterializedArtifactResult {
  scannedCandidateCount: number;
  noticeCode: TurnArtifactNoticeCode | null;
}

interface ArtifactPolicyResult extends MaterializedArtifactResult {
  sizeRejectedCount: number;
  countRejectedCount: number;
}

export function detectTurnArtifactIntent(text: string): TurnArtifactIntent {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    return emptyIntent();
  }
  const lowered = normalized.toLowerCase();
  const requestedFormat = detectRequestedFormat(lowered);
  const requestedExtension = extensionForFormat(requestedFormat);
  const preferredKind = kindForFormat(requestedFormat);
  const explicitFileName = detectExplicitArtifactFileName(normalized);
  const requestedFileName = explicitFileName;
  const hasDeliveryVerb = hasArtifactDeliveryVerb(lowered);

  if (preferredKind && preferredKind !== 'image' && hasDeliveryVerb) {
    return {
      requested: true,
      preferredKind,
      requestedFormat,
      requestedExtension,
      requestedFileName,
      userDescription: normalized,
      requiresClarification: false,
    };
  }

  if (preferredKind === 'image' && hasDeliveryVerb) {
    return {
      requested: true,
      preferredKind,
      requestedFormat,
      requestedExtension,
      requestedFileName,
      userDescription: normalized,
      requiresClarification: false,
    };
  }

  if (hasGenericArtifactRequest(lowered)) {
    return {
      requested: true,
      preferredKind: 'file',
      requestedFormat,
      requestedExtension,
      requestedFileName,
      userDescription: normalized,
      requiresClarification: !requestedFormat,
    };
  }

  return emptyIntent();
}

export function detectRequestedArtifactFormat(text: string): string | null {
  const normalized = String(text ?? '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return detectRequestedFormat(normalized);
}

export function createTurnArtifactContext({
  bridgeSessionId,
  cwd,
  text,
}: {
  bridgeSessionId: string;
  cwd?: string | null;
  text: string;
}): TurnArtifactContext | null {
  const intent = detectTurnArtifactIntent(text);
  if (!intent.requested || intent.requiresClarification) {
    return null;
  }
  const requestId = crypto.randomUUID();
  const baseDir = resolveArtifactBaseDir(cwd);
  return {
    requestId,
    bridgeSessionId,
    artifactDir: path.join(baseDir, '.codexbridge', 'turn-artifacts', requestId),
    spoolDir: path.join(baseDir, '.codexbridge', 'artifact-spool', requestId),
    turnId: null,
    intent,
  };
}

export function ensureTurnArtifactDirectories(context: TurnArtifactContext | null | undefined): void {
  if (!context) {
    return;
  }
  fs.mkdirSync(context.artifactDir, { recursive: true });
  fs.mkdirSync(context.spoolDir, { recursive: true });
}

export function createPendingTurnArtifactDeliveryState(
  context: TurnArtifactContext | null | undefined,
): TurnArtifactDeliveryState | null {
  if (!context?.intent.requested) {
    return null;
  }
  const limits = resolveTurnArtifactLimits();
  return {
    requestId: context.requestId,
    bridgeSessionId: context.bridgeSessionId,
    turnId: context.turnId ?? null,
    requestedByUser: true,
    requestedFormat: context.intent.requestedFormat,
    preferredKind: context.intent.preferredKind,
    requestedByText: context.intent.userDescription,
    artifactDir: context.artifactDir,
    spoolDir: context.spoolDir,
    stage: 'pending',
    fallbackUsed: false,
    manifestDeclaredCount: 0,
    scannedCandidateCount: 0,
    maxArtifactCount: limits.maxArtifactCount,
    maxArtifactSizeBytes: limits.maxArtifactSizeBytes,
    noticeCode: null,
    deliveredArtifacts: [],
    rejectedArtifacts: [],
  };
}

export function buildTurnArtifactDeveloperInstructions(context: TurnArtifactContext | null | undefined): string {
  if (!context?.intent.requested) {
    return '';
  }
  const limits = resolveTurnArtifactLimits();
  const preferredFormat = context.intent.requestedFormat ?? 'file';
  const exampleFilename = buildManifestExampleFilename(context.intent);
  const preferredKind = context.intent.preferredKind ?? 'file';
  const lines = [
    'CodexBridge attachment delivery protocol:',
    'The user explicitly expects a deliverable attachment in this turn.',
    `Write any deliverable files only inside this directory: ${context.artifactDir}`,
    `Preferred output format: ${preferredFormat}. If that is not practical, create the closest useful deliverable file and declare it.`,
    `Keep the number of returned deliverables at or below ${limits.maxArtifactCount}.`,
    `Keep each declared file at or below ${limits.maxArtifactSizeBytes} bytes whenever practical.`,
    'Use absolute paths in the manifest whenever possible.',
  ];
  if (context.intent.requestedFileName) {
    lines.push(`Use this exact filename for the final deliverable whenever practical: ${context.intent.requestedFileName}`);
  } else {
    lines.push('Choose a clear, semantic final filename yourself. If you are modifying an existing file, keep its current filename.');
    lines.push('In the manifest example below, replace the placeholder filename with the real filename you chose.');
  }
  return [
    ...lines,
    'After your normal user-visible final answer, append exactly one fenced JSON manifest block in this format:',
    `\`\`\`${MANIFEST_FENCE}`,
    `[{"path":"${path.join(context.artifactDir, exampleFilename)}","kind":"${preferredKind}","displayName":"${exampleFilename}","caption":"final deliverable"}]`,
    '```',
    'Only include files that should be sent back to the user.',
    'Do not explain the protocol or mention the manifest outside the fenced block.',
  ].join('\n');
}

export function finalizeTurnArtifacts({
  result,
  context,
}: {
  result: ProviderTurnResult;
  context?: TurnArtifactContext | null;
}): ProviderTurnResult {
  const providerArtifacts = normalizeProviderArtifacts(result);
  if (!context) {
    return {
      ...result,
      outputArtifacts: providerArtifacts,
      outputMedia: normalizeImageMedia(providerArtifacts),
      artifactDelivery: result.artifactDelivery ?? null,
    };
  }

  const limits = resolveTurnArtifactLimits();
  const pendingState = createPendingTurnArtifactDeliveryState(context);
  ensureTurnArtifactDirectories(context);
  const extracted = extractDeclaredArtifactsFromText(String(result?.outputText ?? ''));
  const declaredArtifacts = materializeDeclaredArtifacts(extracted.entries, context, limits.maxArtifactSizeBytes);
  const fallbackArtifacts = declaredArtifacts.artifacts.length === 0
    ? collectFallbackArtifacts(context, limits.maxArtifactSizeBytes)
    : {
      artifacts: [],
      rejected: [],
      scannedCandidateCount: 0,
      noticeCode: null,
    };
  const outputArtifacts = dedupeArtifacts([
    ...providerArtifacts,
    ...declaredArtifacts.artifacts,
    ...fallbackArtifacts.artifacts,
  ]);
  const limitedArtifacts = applyArtifactDeliveryPolicy(outputArtifacts, context);
  const prePolicySizeRejectedCount = countRejectedArtifactsByReason([
    ...declaredArtifacts.rejected,
    ...fallbackArtifacts.rejected,
  ], 'size_limit');
  const noticeCode = resolveArtifactNoticeCode({
    fallbackNoticeCode: fallbackArtifacts.noticeCode,
    sizeRejectedCount: limitedArtifacts.sizeRejectedCount + prePolicySizeRejectedCount,
    countRejectedCount: limitedArtifacts.countRejectedCount,
    deliverableCount: limitedArtifacts.artifacts.length,
    requestedByUser: context.intent.requested,
  });
  const artifactDelivery: TurnArtifactDeliveryState | null = pendingState
    ? {
      ...pendingState,
      turnId: result.turnId ?? context.turnId ?? null,
      stage: resolveArtifactDeliveryStage({
        fallbackUsed: fallbackArtifacts.artifacts.length > 0,
        noticeCode,
        deliveredCount: limitedArtifacts.artifacts.length,
      }),
      fallbackUsed: fallbackArtifacts.artifacts.length > 0,
      manifestDeclaredCount: extracted.entries.length,
      scannedCandidateCount: fallbackArtifacts.scannedCandidateCount,
      noticeCode,
      deliveredArtifacts: limitedArtifacts.artifacts.map((artifact) => ({
        kind: artifact.kind,
        path: artifact.path,
        displayName: artifact.displayName ?? null,
        mimeType: artifact.mimeType ?? null,
        sizeBytes: artifact.sizeBytes ?? null,
        caption: artifact.caption ?? null,
        source: artifact.source ?? 'provider_native',
        turnId: artifact.turnId ?? result.turnId ?? context.turnId ?? null,
      })),
      rejectedArtifacts: [
        ...buildInvalidManifestRejections(extracted.invalidManifestCount),
        ...declaredArtifacts.rejected,
        ...fallbackArtifacts.rejected,
        ...limitedArtifacts.rejected,
      ],
    }
    : null;
  return {
    ...result,
    outputText: extracted.cleanText,
    outputArtifacts: limitedArtifacts.artifacts,
    outputMedia: normalizeImageMedia(limitedArtifacts.artifacts),
    artifactDelivery,
  };
}

function normalizeProviderArtifacts(result: ProviderTurnResult): OutputArtifact[] {
  const direct = Array.isArray(result?.outputArtifacts) ? result.outputArtifacts : [];
  if (direct.length > 0) {
    return dedupeArtifacts(direct.map((artifact) => ({
      ...artifact,
      source: artifact.source ?? 'provider_native',
      turnId: artifact.turnId ?? result?.turnId ?? null,
    })));
  }
  const legacyMedia = Array.isArray(result?.outputMedia) ? result.outputMedia : [];
  return dedupeArtifacts(legacyMedia
    .map((media) => {
      const artifactPath = String(media?.path ?? '').trim();
      if (!artifactPath) {
        return null;
      }
      return {
        kind: 'image' as const,
        path: artifactPath,
        caption: typeof media?.caption === 'string' ? media.caption : null,
        source: 'provider_native' as const,
        turnId: result?.turnId ?? null,
      };
    })
    .filter(Boolean) as OutputArtifact[]);
}

function normalizeImageMedia(artifacts: OutputArtifact[]): Array<{
  kind: 'image';
  path: string;
  caption?: string | null;
}> {
  return artifacts
    .filter((artifact) => artifact?.kind === 'image')
    .map((artifact) => ({
      kind: 'image' as const,
      path: artifact.path,
      caption: artifact.caption ?? null,
    }));
}

function extractDeclaredArtifactsFromText(text: string): ExtractedDeclaredArtifactResult {
  const escapedFence = escapeRegex(MANIFEST_FENCE);
  const blockPattern = new RegExp(`\`\`\`${escapedFence}\\s*([\\s\\S]*?)\`\`\``, 'giu');
  const stripPattern = new RegExp(`\\n?\`\`\`${escapedFence}\\s*[\\s\\S]*?\`\`\`\\n?`, 'giu');
  const matches = [...String(text ?? '').matchAll(blockPattern)];
  if (matches.length === 0) {
    return {
      cleanText: normalizeUserVisibleText(text),
      entries: [],
      invalidManifestCount: 0,
    };
  }
  const entries: DeclaredArtifactManifestEntry[] = [];
  let invalidManifestCount = 0;
  for (const match of matches) {
    const payload = String(match[1] ?? '').trim();
    if (!payload) {
      continue;
    }
    const parsed = parseDeclaredArtifactManifest(payload);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && typeof entry === 'object') {
          entries.push(entry as DeclaredArtifactManifestEntry);
        }
      }
    } else {
      invalidManifestCount += 1;
    }
  }
  return {
    cleanText: normalizeUserVisibleText(String(text ?? '').replace(stripPattern, '\n')),
    entries,
    invalidManifestCount,
  };
}

function parseDeclaredArtifactManifest(payload: string): unknown[] | null {
  const normalizedPathPayload = escapeBareBackslashesInPathFields(payload);
  const relaxedPayload = escapeInvalidJsonBackslashes(normalizedPathPayload);
  for (const candidate of unique([normalizedPathPayload, payload, relaxedPayload])) {
    try {
      const parsed = JSON.parse(candidate);
      return Array.isArray(parsed) ? parsed : null;
    } catch {}
  }
  return null;
}

function escapeBareBackslashesInPathFields(value: string): string {
  return String(value ?? '').replace(
    /("path"\s*:\s*")((?:[^"\\]|\\.)*)(")/giu,
    (_match, prefix: string, rawPath: string, suffix: string) => {
      const normalizedPath = rawPath.replace(/(?<!\\)\\(?!\\)/gu, '\\\\');
      return `${prefix}${normalizedPath}${suffix}`;
    },
  );
}

function escapeInvalidJsonBackslashes(value: string): string {
  let normalized = '';
  let inString = false;
  let escaped = false;
  let changed = false;
  for (const character of String(value ?? '')) {
    if (!inString) {
      normalized += character;
      if (character === '"') {
        inString = true;
      }
      continue;
    }
    if (escaped) {
      if (isValidJsonEscapeCharacter(character)) {
        normalized += character;
      } else {
        normalized += `\\${character}`;
        changed = true;
      }
      escaped = false;
      continue;
    }
    normalized += character;
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = false;
    }
  }
  if (escaped) {
    normalized += '\\';
    changed = true;
  }
  return changed ? normalized : value;
}

function isValidJsonEscapeCharacter(character: string): boolean {
  return character === '"'
    || character === '\\'
    || character === '/'
    || character === 'b'
    || character === 'f'
    || character === 'n'
    || character === 'r'
    || character === 't'
    || character === 'u';
}

function materializeDeclaredArtifacts(
  entries: DeclaredArtifactManifestEntry[],
  context: TurnArtifactContext,
  maxArtifactSizeBytes: number,
): MaterializedArtifactResult {
  const artifacts: OutputArtifact[] = [];
  const rejected: TurnArtifactRejectedItem[] = [];
  for (const entry of entries) {
    const resolved = materializeDeclaredArtifact(entry, context, maxArtifactSizeBytes);
    if (resolved.artifact) {
      artifacts.push(resolved.artifact);
    }
    if (resolved.rejected) {
      rejected.push(resolved.rejected);
    }
  }
  return {
    artifacts: dedupeArtifacts(artifacts),
    rejected,
  };
}

function materializeDeclaredArtifact(
  entry: DeclaredArtifactManifestEntry,
  context: TurnArtifactContext,
  maxArtifactSizeBytes: number,
): { artifact: OutputArtifact | null; rejected: TurnArtifactRejectedItem | null } {
  const declaredPath = String(entry?.path ?? '').trim();
  if (!declaredPath) {
    return {
      artifact: null,
      rejected: null,
    };
  }
  const resolvedPath = resolveArtifactPath(declaredPath, context.artifactDir);
  if (!resolvedPath || !isWithinRoot(context.artifactDir, resolvedPath)) {
    return {
      artifact: null,
      rejected: {
        path: resolvedPath ?? declaredPath,
        displayName: sanitizeArtifactName(firstNonEmpty(entry.displayName, entry.fileName, entry.name, entry.title, declaredPath)),
        sizeBytes: null,
        reason: 'path_outside_artifact_dir',
      },
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedPath);
  } catch {
    return {
      artifact: null,
      rejected: {
        path: resolvedPath,
        displayName: sanitizeArtifactName(firstNonEmpty(entry.displayName, entry.fileName, entry.name, entry.title, path.basename(resolvedPath))),
        sizeBytes: null,
        reason: 'missing_file',
      },
    };
  }
  const displayName = sanitizeArtifactName(
    firstNonEmpty(entry.displayName, entry.fileName, entry.name, entry.title, path.basename(resolvedPath)),
  );
  if (stat.isSymbolicLink()) {
    return {
      artifact: null,
      rejected: {
        path: resolvedPath,
        displayName,
        sizeBytes: null,
        reason: 'symlink',
      },
    };
  }
  if (!stat.isFile()) {
    return {
      artifact: null,
      rejected: {
        path: resolvedPath,
        displayName,
        sizeBytes: null,
        reason: 'not_file',
      },
    };
  }
  if (stat.size > maxArtifactSizeBytes) {
    return {
      artifact: null,
      rejected: {
        path: resolvedPath,
        displayName,
        sizeBytes: stat.size,
        reason: 'size_limit',
      },
    };
  }
  const spoolPath = copyArtifactToSpool(resolvedPath, context.spoolDir, displayName);
  return {
    artifact: {
      kind: normalizeArtifactKind(entry.kind, spoolPath),
      path: spoolPath,
      displayName,
      mimeType: normalizeMimeType(entry.mimeType, spoolPath),
      sizeBytes: stat.size,
      caption: typeof entry?.caption === 'string' ? entry.caption.trim() || null : null,
      source: 'bridge_declared',
      turnId: context.turnId ?? null,
    },
    rejected: null,
  };
}

function collectFallbackArtifacts(
  context: TurnArtifactContext,
  maxArtifactSizeBytes: number,
): FallbackArtifactResult {
  let candidates = listRegularFiles(context.artifactDir);
  if (candidates.length === 0) {
    return {
      artifacts: [],
      rejected: [],
      scannedCandidateCount: 0,
      noticeCode: 'missing_deliverable',
    };
  }
  const preferredExtension = String(context.intent.requestedExtension ?? '').trim().toLowerCase();
  if (preferredExtension) {
    const preferred = candidates.filter((candidate) => path.extname(candidate).toLowerCase() === preferredExtension);
    if (preferred.length > 0) {
      candidates = preferred;
    }
  }
  if (context.intent.requestedFileName) {
    const exactFileNameMatch = candidates.find((candidate) => {
      return sanitizeArtifactName(path.basename(candidate)).toLowerCase() === context.intent.requestedFileName?.toLowerCase();
    });
    if (exactFileNameMatch) {
      candidates = [exactFileNameMatch];
    }
  }
  if (candidates.length !== 1) {
    return {
      artifacts: [],
      rejected: [],
      scannedCandidateCount: candidates.length,
      noticeCode: 'ambiguous_candidates',
    };
  }
  const candidate = candidates[0];
  if (!candidate) {
    return {
      artifacts: [],
      rejected: [],
      scannedCandidateCount: 0,
      noticeCode: 'missing_deliverable',
    };
  }
  const displayName = sanitizeArtifactName(path.basename(candidate));
  const stat = fs.statSync(candidate);
  if (stat.size > maxArtifactSizeBytes) {
    return {
      artifacts: [],
      rejected: [{
        path: candidate,
        displayName,
        sizeBytes: stat.size,
        reason: 'size_limit',
      }],
      scannedCandidateCount: 1,
      noticeCode: 'missing_deliverable',
    };
  }
  const spoolPath = copyArtifactToSpool(candidate, context.spoolDir, displayName);
  return {
    artifacts: [{
      kind: normalizeArtifactKind(null, spoolPath),
      path: spoolPath,
      displayName,
      mimeType: normalizeMimeType(null, spoolPath),
      sizeBytes: stat.size,
      caption: null,
      source: 'bridge_fallback',
      turnId: context.turnId ?? null,
    }],
    rejected: [],
    scannedCandidateCount: 1,
    noticeCode: null,
  };
}

function listRegularFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const results: string[] = [];
  const queue = [rootDir];
  while (queue.length > 0 && results.length <= FALLBACK_SCAN_LIMIT) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(nextPath);
        continue;
      }
      if (entry.isFile()) {
        results.push(nextPath);
      }
      if (results.length > FALLBACK_SCAN_LIMIT) {
        break;
      }
    }
  }
  return results;
}

function copyArtifactToSpool(sourcePath: string, spoolDir: string, displayName: string): string {
  fs.mkdirSync(spoolDir, { recursive: true });
  const safeName = sanitizeArtifactName(displayName || path.basename(sourcePath));
  const targetPath = reserveSpoolPath(spoolDir, safeName);
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function reserveSpoolPath(spoolDir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext) || DEFAULT_DELIVERABLE_BASENAME;
  const initial = path.join(spoolDir, fileName);
  if (!fs.existsSync(initial)) {
    return initial;
  }
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(spoolDir, `${base}-${index}${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(spoolDir, `${base}-${crypto.randomUUID()}${ext}`);
}

function resolveArtifactPath(rawPath: string, artifactDir: string): string | null {
  const normalized = String(rawPath ?? '').trim();
  if (!normalized) {
    return null;
  }
  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  return path.resolve(artifactDir, normalized);
}

function isWithinRoot(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function normalizeArtifactKind(kind: string | null | undefined, artifactPath: string): OutputArtifactKind {
  const normalized = String(kind ?? '').trim().toLowerCase();
  if (normalized === 'image' || normalized === 'file' || normalized === 'video' || normalized === 'audio') {
    return normalized;
  }
  const extension = path.extname(artifactPath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(extension)) {
    return 'image';
  }
  if (['.mp4', '.mov', '.mkv', '.webm'].includes(extension)) {
    return 'video';
  }
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.amr'].includes(extension)) {
    return 'audio';
  }
  return 'file';
}

function normalizeMimeType(rawMimeType: string | null | undefined, artifactPath: string): string | null {
  const explicit = String(rawMimeType ?? '').trim();
  if (explicit) {
    return explicit;
  }
  const extension = path.extname(artifactPath).toLowerCase();
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.html': 'text/html',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.tgz': 'application/gzip',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  })[extension] ?? null;
}

function sanitizeArtifactName(value: string): string {
  const trimmed = String(value ?? '').trim();
  const baseName = path.basename(trimmed || DEFAULT_DELIVERABLE_BASENAME);
  return baseName.replace(/[\\/:*?"<>|]/g, '-').trim() || DEFAULT_DELIVERABLE_BASENAME;
}

function normalizeUserVisibleText(text: string): string {
  return String(text ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function dedupeArtifacts(artifacts: OutputArtifact[]): OutputArtifact[] {
  const seen = new Set<string>();
  const unique: OutputArtifact[] = [];
  for (const artifact of artifacts) {
    const artifactPath = String(artifact?.path ?? '').trim();
    if (!artifactPath) {
      continue;
    }
    const key = `${artifact.kind}:${artifactPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({
      ...artifact,
      path: artifactPath,
    });
  }
  return unique;
}

function applyArtifactDeliveryPolicy(
  artifacts: OutputArtifact[],
  context: TurnArtifactContext,
): ArtifactPolicyResult {
  const limits = resolveTurnArtifactLimits();
  const selected = selectArtifactsForIntent(artifacts, context.intent);
  const ordered = prioritizeArtifacts(selected, context.intent);
  const kept: OutputArtifact[] = [];
  const rejected: TurnArtifactRejectedItem[] = [];
  let sizeRejectedCount = 0;
  let countRejectedCount = 0;
  for (const artifact of ordered) {
    const artifactPath = String(artifact?.path ?? '').trim();
    if (!artifactPath) {
      continue;
    }
    const displayName = sanitizeArtifactName(artifact.displayName ?? path.basename(artifactPath));
    const sizeBytes = resolveArtifactSizeBytes(artifact);
    if (sizeBytes !== null && sizeBytes > limits.maxArtifactSizeBytes) {
      sizeRejectedCount += 1;
      rejected.push({
        path: artifactPath,
        displayName,
        sizeBytes,
        reason: 'size_limit',
      });
      continue;
    }
    if (kept.length >= limits.maxArtifactCount) {
      countRejectedCount += 1;
      rejected.push({
        path: artifactPath,
        displayName,
        sizeBytes,
        reason: 'count_limit',
      });
      continue;
    }
    kept.push({
      ...artifact,
      sizeBytes,
    });
  }
  return {
    artifacts: kept,
    rejected,
    sizeRejectedCount,
    countRejectedCount,
  };
}

function prioritizeArtifacts(artifacts: OutputArtifact[], intent: TurnArtifactIntent): OutputArtifact[] {
  return artifacts
    .map((artifact, index) => ({
      artifact,
      index,
      score: scoreArtifactForIntent(artifact, intent),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.artifact);
}

function scoreArtifactForIntent(artifact: OutputArtifact, intent: TurnArtifactIntent): number {
  let score = 0;
  const fileName = sanitizeArtifactName(artifact.displayName ?? path.basename(String(artifact?.path ?? '')));
  const extension = path.extname(fileName).toLowerCase();
  if (intent.requestedFileName && fileName.toLowerCase() === intent.requestedFileName.toLowerCase()) {
    score += 2400;
  }
  if (intent.requestedExtension && extension === intent.requestedExtension.toLowerCase()) {
    score += 1000;
  }
  if (intent.preferredKind && artifact.kind === intent.preferredKind) {
    score += 500;
  }
  if (artifact.source === 'bridge_declared') {
    score += 250;
  } else if (artifact.source === 'bridge_fallback') {
    score += 200;
  } else if (artifact.source === 'provider_native') {
    score += 100;
  }
  if (artifact.kind === 'file') {
    score += 50;
  }
  return score;
}

function selectArtifactsForIntent(artifacts: OutputArtifact[], intent: TurnArtifactIntent): OutputArtifact[] {
  if (!intent.requested) {
    return artifacts;
  }
  const preferredExtension = String(intent.requestedExtension ?? '').trim().toLowerCase();
  if (preferredExtension) {
    const exactExtensionMatches = artifacts.filter((artifact) => {
      const fileName = sanitizeArtifactName(artifact.displayName ?? path.basename(String(artifact?.path ?? '')));
      return path.extname(fileName).toLowerCase() === preferredExtension;
    });
    if (exactExtensionMatches.length > 0) {
      return exactExtensionMatches;
    }
  }
  if (intent.preferredKind) {
    const kindMatches = artifacts.filter((artifact) => artifact.kind === intent.preferredKind);
    if (kindMatches.length > 0) {
      return kindMatches;
    }
    return [];
  }
  return artifacts;
}

function resolveArtifactSizeBytes(artifact: OutputArtifact): number | null {
  const explicitSize = Number(artifact?.sizeBytes ?? NaN);
  if (Number.isFinite(explicitSize) && explicitSize >= 0) {
    return explicitSize;
  }
  const artifactPath = String(artifact?.path ?? '').trim();
  if (!artifactPath) {
    return null;
  }
  try {
    return fs.statSync(artifactPath).size;
  } catch {
    return null;
  }
}

function resolveArtifactDeliveryStage({
  fallbackUsed,
  noticeCode,
  deliveredCount,
}: {
  fallbackUsed: boolean;
  noticeCode: TurnArtifactNoticeCode | null;
  deliveredCount: number;
}): TurnArtifactDeliveryState['stage'] {
  if (noticeCode === 'ambiguous_candidates') {
    return 'ambiguous';
  }
  if (noticeCode === 'missing_deliverable' && deliveredCount === 0) {
    return 'missing';
  }
  if (deliveredCount > 0 && (noticeCode === 'count_limited' || noticeCode === 'size_limited' || noticeCode === 'count_and_size_limited')) {
    return 'limited';
  }
  if (deliveredCount > 0 && fallbackUsed) {
    return 'fallback_ready';
  }
  return deliveredCount > 0 ? 'ready' : 'missing';
}

function resolveArtifactNoticeCode({
  fallbackNoticeCode,
  sizeRejectedCount,
  countRejectedCount,
  deliverableCount,
  requestedByUser,
}: {
  fallbackNoticeCode: TurnArtifactNoticeCode | null;
  sizeRejectedCount: number;
  countRejectedCount: number;
  deliverableCount: number;
  requestedByUser: boolean;
}): TurnArtifactNoticeCode | null {
  if (sizeRejectedCount > 0 && countRejectedCount > 0) {
    return 'count_and_size_limited';
  }
  if (sizeRejectedCount > 0) {
    return 'size_limited';
  }
  if (requestedByUser && deliverableCount === 0) {
    return fallbackNoticeCode ?? 'missing_deliverable';
  }
  if (countRejectedCount > 0) {
    return 'count_limited';
  }
  return null;
}

function buildInvalidManifestRejections(count: number): TurnArtifactRejectedItem[] {
  if (count <= 0) {
    return [];
  }
  return Array.from({ length: count }, () => ({
    path: null,
    displayName: null,
    sizeBytes: null,
    reason: 'invalid_manifest' as const,
  }));
}

function countRejectedArtifactsByReason(
  rejectedArtifacts: TurnArtifactRejectedItem[],
  reason: TurnArtifactRejectedItem['reason'],
): number {
  return rejectedArtifacts.filter((artifact) => artifact.reason === reason).length;
}

function resolveTurnArtifactLimits(): {
  maxArtifactCount: number;
  maxArtifactSizeBytes: number;
} {
  return {
    maxArtifactCount: parsePositiveIntegerEnv('CODEXBRIDGE_MAX_OUTPUT_ARTIFACTS', DEFAULT_MAX_ARTIFACT_COUNT),
    maxArtifactSizeBytes: parsePositiveIntegerEnv('CODEXBRIDGE_MAX_ARTIFACT_SIZE_BYTES', DEFAULT_MAX_ARTIFACT_SIZE_BYTES),
  };
}

function parsePositiveIntegerEnv(name: string, fallbackValue: number): number {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) {
    return fallbackValue;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function buildManifestExampleFilename(intent: TurnArtifactIntent): string {
  if (intent.requestedFileName) {
    return intent.requestedFileName;
  }
  const extension = intent.requestedExtension ?? '';
  const baseName = ({
    image: 'your-chosen-image',
    video: 'your-chosen-video',
    audio: 'your-chosen-audio',
  })[String(intent.preferredKind ?? '')] ?? 'your-chosen-file';
  return `${baseName}${extension}`;
}

function resolveArtifactBaseDir(cwd: string | null | undefined): string {
  const normalized = String(cwd ?? '').trim();
  return normalized || path.join(os.homedir(), '.codexbridge');
}

function detectRequestedFormat(loweredText: string): string | null {
  if (/(?:\.png\b|\bpng\b|png图片|png图)/iu.test(loweredText)) {
    return 'png';
  }
  if (/(?:\.jpe?g\b|\.jpg\b|\bjpeg\b|\bjpg\b|jpg图片|jpeg图片)/iu.test(loweredText)) {
    return 'jpg';
  }
  if (/(?:\.webp\b|\bwebp\b)/iu.test(loweredText)) {
    return 'webp';
  }
  if (/(?:\.docx\b|\.doc\b|\bdocx\b|\bdoc\b|\bword\b|word文档|文档|文稿)/iu.test(loweredText)) {
    return 'docx';
  }
  if (/(?:\.pdf\b|\bpdf\b|pdf文件)/iu.test(loweredText)) {
    return 'pdf';
  }
  if (/(?:\.xlsx\b|\.xls\b|\bxlsx\b|\bxls\b|\bexcel\b|表格|工作簿)/iu.test(loweredText)) {
    return 'xlsx';
  }
  if (/(?:\.csv\b|\bcsv\b)/iu.test(loweredText)) {
    return 'csv';
  }
  if (/(?:\.zip\b|\bzip\b|压缩包|打包)/iu.test(loweredText)) {
    return 'zip';
  }
  if (/(?:\.md\b|\bmd\b|\bmarkdown\b|md文件|md 文件|md文档|md 文档|markdown文件|markdown 文件|markdown文档|markdown 文档)/iu.test(loweredText)) {
    return 'md';
  }
  if (/(?:\.txt\b|\btxt\b|文本文件)/iu.test(loweredText)) {
    return 'txt';
  }
  if (/(?:\.json\b|\bjson\b)/iu.test(loweredText)) {
    return 'json';
  }
  if (/(?:\.html?\b|\bhtml\b)/iu.test(loweredText)) {
    return 'html';
  }
  return null;
}

function extensionForFormat(format: string | null): string | null {
  if (!format) {
    return null;
  }
  return format.startsWith('.') ? format : `.${format}`;
}

function kindForFormat(format: string | null): TurnArtifactIntent['preferredKind'] {
  if (!format) {
    return null;
  }
  switch (format) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return 'image';
    case 'mp4':
    case 'mov':
    case 'webm':
      return 'video';
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'm4a':
      return 'audio';
    default:
      return 'file';
  }
}

function hasGenericArtifactRequest(loweredText: string): boolean {
  const hasDeliveryVerb = hasArtifactDeliveryVerb(loweredText);
  const hasArtifactNoun = /(文件|附件|文档|报告|压缩包|file|attachment|document|report|bundle)/iu.test(loweredText);
  const hasFileCreationVerb = /(导出|输出|保存成|另存为|打包|压缩|export|output|attach|save as)/iu.test(loweredText);
  const hasReturnVerb = /(发我|给我|发给我|传给我|回传|send me|deliver|return)/iu.test(loweredText);
  return (hasDeliveryVerb && hasArtifactNoun) || (hasFileCreationVerb && hasReturnVerb);
}

function detectExplicitArtifactFileName(text: string): string | null {
  const match = String(text ?? '').match(/([^\s"'`<>|]+?\.(?:pdf|docx?|xlsx?|xls|csv|zip|png|jpe?g|webp|md|txt|json|html?))/iu);
  if (!match?.[1]) {
    return null;
  }
  return sanitizeArtifactName(match[1]);
}

function hasArtifactDeliveryVerb(loweredText: string): boolean {
  return /(发我|给我|发给我|传给我|回传|导出|输出|生成|整理成|保存成|打包|做成|写成|转成|转换成|send me|return .*file|export|deliver|attach|save as|output as|convert to)/iu.test(loweredText);
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function emptyIntent(): TurnArtifactIntent {
  return {
    requested: false,
    preferredKind: null,
    requestedFormat: null,
    requestedExtension: null,
    requestedFileName: null,
    userDescription: null,
    requiresClarification: false,
  };
}

function escapeRegex(value: string): string {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
