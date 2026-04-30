import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { finalizeTurnArtifacts } from '../../src/core/turn_artifacts.js';
import type { TurnArtifactContext } from '../../src/types/core.js';

test('finalizeTurnArtifacts rejects symlinked manifest files that escape the turn artifact directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifacts-'));
  const artifactDir = path.join(tempDir, 'artifact-dir');
  const spoolDir = path.join(tempDir, 'spool-dir');
  const outsideFile = path.join(tempDir, 'outside.pdf');
  const symlinkPath = path.join(artifactDir, 'report.pdf');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(spoolDir, { recursive: true });
  fs.writeFileSync(outsideFile, 'outside');
  fs.symlinkSync(outsideFile, symlinkPath);

  const context: TurnArtifactContext = {
    requestId: 'req-1',
    bridgeSessionId: 'session-1',
    artifactDir,
    spoolDir,
    turnId: null,
    intent: {
      requested: true,
      preferredKind: 'file',
      requestedFormat: 'pdf',
      requestedExtension: '.pdf',
      requestedFileName: 'report.pdf',
      userDescription: '给我一个 PDF',
      requiresClarification: false,
    },
  };

  try {
    const result = finalizeTurnArtifacts({
      result: {
        outputText: `已完成。\n\n\`\`\`codexbridge-artifacts\n${JSON.stringify([{ path: symlinkPath, kind: 'file' }])}\n\`\`\``,
      },
      context,
    });

    assert.equal(result.outputText, '已完成。');
    assert.deepEqual(result.outputArtifacts, []);
    assert.deepEqual(fs.readdirSync(spoolDir), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('finalizeTurnArtifacts accepts manifest paths that contain raw Windows backslashes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifacts-'));
  const artifactDir = path.join(tempDir, 'artifact-dir');
  const spoolDir = path.join(tempDir, 'spool-dir');
  const reportPath = path.join(artifactDir, 'summary.docx');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(spoolDir, { recursive: true });
  fs.writeFileSync(reportPath, 'word-output');

  try {
    const manifestPath = reportPath.replace(/\//g, '\\');
    const result = finalizeTurnArtifacts({
      result: {
        outputText: `已完成。\n\n\`\`\`codexbridge-artifacts\n[{"path":"${manifestPath}","kind":"file","displayName":"summary.docx"}]\n\`\`\``,
      },
      context: makeContext({
        artifactDir,
        spoolDir,
        requestedFormat: 'docx',
        requestedExtension: '.docx',
        requestedFileName: 'summary.docx',
      }),
    });

    assert.equal(result.outputText, '已完成。');
    assert.equal(result.outputArtifacts?.length, 1);
    assert.equal(result.outputArtifacts?.[0]?.displayName, 'summary.docx');
    assert.equal(result.artifactDelivery?.stage, 'ready');
    assert.equal(result.artifactDelivery?.noticeCode, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('finalizeTurnArtifacts reports ambiguous fallback candidates instead of sending multiple files blindly', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifacts-'));
  const artifactDir = path.join(tempDir, 'artifact-dir');
  const spoolDir = path.join(tempDir, 'spool-dir');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(spoolDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'report-a.pdf'), 'a');
  fs.writeFileSync(path.join(artifactDir, 'report-b.pdf'), 'b');

  const context = makeContext({
    artifactDir,
    spoolDir,
    requestedFormat: 'pdf',
    requestedExtension: '.pdf',
  });

  try {
    const result = finalizeTurnArtifacts({
      result: {
        outputText: '已完成。',
      },
      context,
    });

    assert.deepEqual(result.outputArtifacts, []);
    assert.equal(result.artifactDelivery?.noticeCode, 'ambiguous_candidates');
    assert.equal(result.artifactDelivery?.stage, 'ambiguous');
    assert.equal(result.artifactDelivery?.scannedCandidateCount, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('finalizeTurnArtifacts enforces artifact count limits and keeps only the highest-priority attachments', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifacts-'));
  const artifactDir = path.join(tempDir, 'artifact-dir');
  const spoolDir = path.join(tempDir, 'spool-dir');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(spoolDir, { recursive: true });
  const reportPath = path.join(artifactDir, 'changes-summary.pdf');
  const alternatePath = path.join(artifactDir, 'report.pdf');
  fs.writeFileSync(reportPath, 'pdf');
  fs.writeFileSync(alternatePath, 'pdf');

  const previousLimit = process.env.CODEXBRIDGE_MAX_OUTPUT_ARTIFACTS;
  process.env.CODEXBRIDGE_MAX_OUTPUT_ARTIFACTS = '1';
  try {
    const result = finalizeTurnArtifacts({
      result: {
        outputText: `已完成。\n\n\`\`\`codexbridge-artifacts\n${JSON.stringify([
          { path: reportPath, kind: 'file', displayName: 'changes-summary.pdf' },
          { path: alternatePath, kind: 'file', displayName: 'report.pdf' },
        ])}\n\`\`\``,
      },
      context: makeContext({
        artifactDir,
        spoolDir,
        requestedFormat: 'pdf',
        requestedExtension: '.pdf',
        requestedFileName: 'changes-summary.pdf',
      }),
    });

    assert.equal(result.outputArtifacts?.length, 1);
    assert.equal(result.outputArtifacts?.[0]?.displayName, 'changes-summary.pdf');
    assert.equal(result.artifactDelivery?.noticeCode, 'count_limited');
    assert.equal(result.artifactDelivery?.stage, 'limited');
    assert.equal(result.artifactDelivery?.rejectedArtifacts.some((item) => item.reason === 'count_limit'), true);
  } finally {
    restoreEnv('CODEXBRIDGE_MAX_OUTPUT_ARTIFACTS', previousLimit);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('finalizeTurnArtifacts keeps only deliverables that match the requested format when better matches exist', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifacts-'));
  const artifactDir = path.join(tempDir, 'artifact-dir');
  const spoolDir = path.join(tempDir, 'spool-dir');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(spoolDir, { recursive: true });
  const reportPath = path.join(artifactDir, 'changes-summary.pdf');
  const notesPath = path.join(artifactDir, 'notes.txt');
  fs.writeFileSync(reportPath, 'pdf');
  fs.writeFileSync(notesPath, 'txt');

  try {
    const result = finalizeTurnArtifacts({
      result: {
        outputText: `已完成。\n\n\`\`\`codexbridge-artifacts\n${JSON.stringify([
          { path: reportPath, kind: 'file', displayName: 'changes-summary.pdf' },
          { path: notesPath, kind: 'file', displayName: 'notes.txt' },
        ])}\n\`\`\``,
      },
      context: makeContext({
        artifactDir,
        spoolDir,
        requestedFormat: 'pdf',
        requestedExtension: '.pdf',
        requestedFileName: 'changes-summary.pdf',
      }),
    });

    assert.deepEqual(
      result.outputArtifacts?.map((artifact) => artifact.displayName),
      ['changes-summary.pdf'],
    );
    assert.equal(result.artifactDelivery?.noticeCode, null);
    assert.equal(result.artifactDelivery?.stage, 'ready');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('finalizeTurnArtifacts auto-selects the best fallback candidate when one filename clearly matches the requested deliverable', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifacts-'));
  const artifactDir = path.join(tempDir, 'artifact-dir');
  const spoolDir = path.join(tempDir, 'spool-dir');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(spoolDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'changes-summary.pdf'), 'pdf');
  fs.writeFileSync(path.join(artifactDir, 'notes.pdf'), 'pdf');

  try {
    const result = finalizeTurnArtifacts({
      result: {
        outputText: '已完成。',
      },
      context: makeContext({
        artifactDir,
        spoolDir,
        requestedFormat: 'pdf',
        requestedExtension: '.pdf',
        requestedFileName: 'changes-summary.pdf',
      }),
    });

    assert.deepEqual(
      result.outputArtifacts?.map((artifact) => artifact.displayName),
      ['changes-summary.pdf'],
    );
    assert.equal(result.artifactDelivery?.noticeCode, null);
    assert.equal(result.artifactDelivery?.stage, 'fallback_ready');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('finalizeTurnArtifacts rejects oversized deliverables before they are copied into the spool directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-artifacts-'));
  const artifactDir = path.join(tempDir, 'artifact-dir');
  const spoolDir = path.join(tempDir, 'spool-dir');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(spoolDir, { recursive: true });
  const reportPath = path.join(artifactDir, 'summary.pdf');
  fs.writeFileSync(reportPath, '0123456789');

  const previousLimit = process.env.CODEXBRIDGE_MAX_ARTIFACT_SIZE_BYTES;
  process.env.CODEXBRIDGE_MAX_ARTIFACT_SIZE_BYTES = '4';
  try {
    const result = finalizeTurnArtifacts({
      result: {
        outputText: `已完成。\n\n\`\`\`codexbridge-artifacts\n${JSON.stringify([
          { path: reportPath, kind: 'file', displayName: 'summary.pdf' },
        ])}\n\`\`\``,
      },
      context: makeContext({
        artifactDir,
        spoolDir,
        requestedFormat: 'pdf',
        requestedExtension: '.pdf',
      }),
    });

    assert.deepEqual(result.outputArtifacts, []);
    assert.equal(result.artifactDelivery?.noticeCode, 'size_limited');
    assert.equal(result.artifactDelivery?.stage, 'missing');
    assert.equal(result.artifactDelivery?.rejectedArtifacts.some((item) => item.reason === 'size_limit'), true);
    assert.deepEqual(fs.readdirSync(spoolDir), []);
  } finally {
    restoreEnv('CODEXBRIDGE_MAX_ARTIFACT_SIZE_BYTES', previousLimit);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeContext({
  artifactDir,
  spoolDir,
  requestedFormat = 'pdf',
  requestedExtension = '.pdf',
  requestedFileName = null,
}: {
  artifactDir: string;
  spoolDir: string;
  requestedFormat?: string | null;
  requestedExtension?: string | null;
  requestedFileName?: string | null;
}): TurnArtifactContext {
  return {
    requestId: 'req-1',
    bridgeSessionId: 'session-1',
    artifactDir,
    spoolDir,
    turnId: null,
    intent: {
      requested: true,
      preferredKind: 'file',
      requestedFormat,
      requestedExtension,
      requestedFileName,
      userDescription: '请把结果发我',
      requiresClarification: false,
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (typeof value === 'string') {
    process.env[name] = value;
    return;
  }
  delete process.env[name];
}
