import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MissionWorkflowError,
  MissionWorkflowLoader,
  MissionWorkflowResolver,
  createMission,
  createMissionAttemptPromptContract,
  createMissionChecklistSnapshot,
  createMissionWorkpadStatusView,
  renderMissionAttemptPromptContract,
  renderMissionWorkpadStatusView,
} from '../src/index.js';
import type { MissionAttempt } from '../src/index.js';

test('workflow loader falls back to built-in defaults when WORKFLOW.md is missing', () => {
  const loader = new MissionWorkflowLoader();
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-workflow-default-'));
  const workflow = loader.load({ workspacePath });

  assert.equal(workflow.source.kind, 'built-in-default');
  assert.match(workflow.source.label, /built-in defaults/);
  assert.equal(workflow.policy.continuation, 'allow');
  assert.equal(workflow.policy.requirePlanUpdate, true);
  assert.equal(workflow.policy.requireWorkpadUpdate, true);
  assert.deepEqual(workflow.policy.finalReportSections, ['summary', 'verification', 'artifacts', 'next_steps']);
  assert.ok(workflow.policy.promptBody.includes('bounded CodexBridge mission attempt'));
});

test('workflow loader parses front matter and prompt body from WORKFLOW.md', () => {
  const loader = new MissionWorkflowLoader();
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-workflow-file-'));
  const workflowPath = path.join(workspacePath, '.codexbridge', 'mission', 'WORKFLOW.md');
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, `---
version: 1
maxTurns: 7
maxAttempts: 3
maxRuntimeMinutes: 15
maxArtifactCount: 4
maxArtifactBytes: 8192
continuation: allow
requirePlanUpdate: true
requireWorkpadUpdate: false
defaultHandoffState: handoff
stopConditions:
  - Ask for approval before destructive changes.
  - Stop and report if verification fails twice.
finalReportSections:
  - summary
  - verification
  - handoff
---
Keep the plan updated after each meaningful checkpoint.
Report when the mission requires a handoff.
`);

  const workflow = loader.load({ workspacePath });
  assert.equal(workflow.source.kind, 'file');
  assert.equal(workflow.policy.maxTurns, 7);
  assert.equal(workflow.policy.maxAttempts, 3);
  assert.equal(workflow.policy.maxRuntimeMs, 15 * 60_000);
  assert.equal(workflow.policy.maxArtifactCount, 4);
  assert.equal(workflow.policy.maxArtifactBytes, 8192);
  assert.equal(workflow.policy.requireWorkpadUpdate, false);
  assert.equal(workflow.policy.defaultHandoffState, 'handoff');
  assert.deepEqual(workflow.policy.stopConditions, [
    'Ask for approval before destructive changes.',
    'Stop and report if verification fails twice.',
  ]);
  assert.deepEqual(workflow.policy.finalReportSections, ['summary', 'verification', 'handoff']);
  assert.match(workflow.policy.promptBody, /Keep the plan updated/);
});

test('workflow loader surfaces invalid WORKFLOW.md without blocking startup helpers', () => {
  const loader = new MissionWorkflowLoader();
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-workflow-invalid-'));
  const workflowPath = path.join(workspacePath, '.codexbridge', 'mission', 'WORKFLOW.md');
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, `---
version: 2
maxTurns: many
---
Broken workflow.
`);

  const result = loader.tryLoad({ workspacePath });
  assert.equal(result.workflow, null);
  assert.ok(result.error instanceof MissionWorkflowError);
  assert.equal(result.error?.workflowPath, workflowPath);
  assert.ok(result.error?.issues.some((issue) => issue.includes('version') || issue.includes('maxTurns')));
});

test('workflow resolver stays deterministic across explicit overrides, source/risk rules, and built-in fallback', () => {
  const resolver = new MissionWorkflowResolver({
    rules: [
      {
        id: 'local-todo-high-risk',
        relativePath: '.codexbridge/mission/HIGH_RISK_WORKFLOW.md',
        sources: ['local-todo'],
        riskLevels: ['high'],
        requireWorkspacePath: true,
      },
    ],
  });

  const explicit = resolver.resolve({
    source: 'manual',
    riskLevel: 'medium',
    cwd: '/repo',
    workspacePath: null,
    workflowPath: './ops/WORKFLOW.md',
    workflowResolverReason: 'explicit_override',
  });
  assert.deepEqual(explicit, {
    explicitPath: path.resolve('/repo', './ops/WORKFLOW.md'),
    workflowPath: path.resolve('/repo', './ops/WORKFLOW.md'),
    resolverReason: 'explicit_override',
    matchedRuleId: null,
  });

  const ruleDriven = resolver.resolve({
    source: 'local-todo',
    riskLevel: 'high',
    cwd: '/repo',
    workspacePath: '/workspace/mission-high-risk',
    workflowPath: null,
    workflowResolverReason: null,
  });
  assert.deepEqual(ruleDriven, {
    explicitPath: path.resolve('/workspace/mission-high-risk', '.codexbridge/mission/HIGH_RISK_WORKFLOW.md'),
    workflowPath: path.resolve('/workspace/mission-high-risk', '.codexbridge/mission/HIGH_RISK_WORKFLOW.md'),
    resolverReason: 'rule:local-todo-high-risk',
    matchedRuleId: 'local-todo-high-risk',
  });
  assert.deepEqual(ruleDriven, resolver.resolve({
    source: 'local-todo',
    riskLevel: 'high',
    cwd: '/repo',
    workspacePath: '/workspace/mission-high-risk',
    workflowPath: null,
    workflowResolverReason: null,
  }));

  const builtIn = resolver.resolve({
    source: 'manual',
    riskLevel: 'low',
    cwd: null,
    workspacePath: null,
    workflowPath: null,
    workflowResolverReason: null,
  });
  assert.deepEqual(builtIn, {
    explicitPath: null,
    workflowPath: null,
    resolverReason: 'built_in_default',
    matchedRuleId: null,
  });
});

test('attempt prompt contract keeps workflow policy and runtime state separated', () => {
  const loader = new MissionWorkflowLoader();
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-prompt-contract-'));
  const workflowPath = path.join(workspacePath, '.codexbridge', 'mission', 'WORKFLOW.md');
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, `---
version: 1
stopConditions:
  - Ask for approval before modifying secrets.
finalReportSections:
  - summary
  - verification
  - artifacts
---
Prefer small, verifiable changes and report blockers explicitly.
`);

  const mission = createMission({
    id: 'mission-workflow-1',
    source: 'weixin',
    platform: 'weixin',
    externalScopeId: 'wx-user-10',
    title: 'Fix production preview bug',
    goal: 'Fix the preview freeze and explain the result.',
    expectedOutput: 'A verified fix summary and changed files.',
    providerProfileId: 'codex-default',
    acceptanceCriteria: ['Preview no longer freezes', 'Relevant tests pass'],
    plan: ['Inspect the failing flow', 'Apply a fix', 'Verify the result'],
    workflowPath,
    now: 1_700_100_000_000,
  });
  const attempt: MissionAttempt = {
    id: 'attempt-workflow-1',
    missionId: mission.id,
    index: 2,
    status: 'running',
    providerRunId: 'run-workflow-1',
    providerThreadId: 'thread-workflow-1',
    workflowPath: mission.workflowPath,
    workflowHash: mission.workflowHash,
    resolverReason: mission.workflowResolverReason,
    promptDigest: 'digest-workflow-1',
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: null,
    error: null,
    startedAt: 1_700_100_000_100,
    endedAt: null,
    createdAt: 1_700_100_000_000,
    updatedAt: 1_700_100_000_100,
  };
  mission.workpad.summary = 'Attempt 1 found a preview cache regression.';
  mission.workpad.latestBlocker = 'Need to verify the candidate fix.';
  mission.workpad.notes.push('Attempt 2 should re-run the preview flow after patching.');
  const workflow = loader.load({ workspacePath });
  const checklistSnapshot = createMissionChecklistSnapshot(mission, {
    at: mission.updatedAt,
    generationId: mission.activeGenerationId,
  });

  const contract = createMissionAttemptPromptContract({
    mission,
    attempt,
    workflow,
    checklistSnapshot,
  });
  const rendered = renderMissionAttemptPromptContract(contract);

  assert.equal(contract.workflowSourceLabel, workflowPath);
  assert.equal(contract.checklistVersion, checklistSnapshot.version);
  assert.equal(contract.activeChecklistItem?.title, 'Inspect the failing flow');
  assert.equal(contract.immutablePrompt, mission.immutablePrompt);
  assert.deepEqual(contract.finalReportSections, ['summary', 'verification', 'artifacts']);
  assert.ok(contract.stopConditions.includes('Ask for approval before modifying secrets.'));
  assert.match(rendered, /Workflow source:/);
  assert.match(rendered, /Immutable mission prompt/);
  assert.match(rendered, /Acceptance criteria/);
  assert.match(rendered, /Checklist focus/);
  assert.match(rendered, /Current checklist item: \[plan\] Inspect the failing flow/);
  assert.match(rendered, /Current workpad context/);
  assert.match(rendered, /Final report contract/);
  assert.match(rendered, /Workflow instructions/);
  assert.match(rendered, /Prefer small, verifiable changes/);
});

test('workpad status view exposes workflow source, blocker, and attempt history', () => {
  const mission = createMission({
    id: 'mission-view-1',
    source: 'manual',
    platform: 'weixin',
    externalScopeId: 'wx-user-11',
    title: 'Daily release audit',
    goal: 'Audit the release and summarize any blockers.',
    expectedOutput: 'A daily release audit summary.',
    providerProfileId: 'codex-default',
    workflowPath: '/repo/.codexbridge/mission/WORKFLOW.md',
    now: 1_700_200_000_000,
  });
  mission.workpad.summary = 'Release audit is in progress.';
  mission.workpad.latestBlocker = 'Waiting for log collection to finish.';
  mission.workpad.latestVerifierSummary = 'No verification yet.';
  mission.workpad.finalResultSummary = 'No final result yet.';
  mission.workpad.notes.push('Started from a recurring audit request.');
  const attempts: MissionAttempt[] = [
    {
      id: 'attempt-view-1',
      missionId: mission.id,
      index: 1,
      status: 'failed',
      providerRunId: 'run-view-1',
      providerThreadId: 'thread-view-1',
      workflowPath: mission.workflowPath,
      workflowHash: mission.workflowHash,
      resolverReason: mission.workflowResolverReason,
      promptDigest: 'digest-view-1',
      verifierVerdict: 'repair',
      verifierSummary: 'The first pass did not gather all logs.',
      missingAcceptanceCriteria: ['Collect all deployment logs'],
      outputPreview: 'Missing one of the deployment logs.',
      error: 'collector timed out',
      startedAt: 1_700_200_000_100,
      endedAt: 1_700_200_000_200,
      createdAt: 1_700_200_000_000,
      updatedAt: 1_700_200_000_200,
    },
    {
      id: 'attempt-view-2',
      missionId: mission.id,
      index: 2,
      status: 'running',
      providerRunId: 'run-view-2',
      providerThreadId: 'thread-view-2',
      workflowPath: mission.workflowPath,
      workflowHash: mission.workflowHash,
      resolverReason: mission.workflowResolverReason,
      promptDigest: 'digest-view-2',
      verifierVerdict: null,
      verifierSummary: null,
      missingAcceptanceCriteria: [],
      outputPreview: 'Retrying log collection with a narrower scope.',
      error: null,
      startedAt: 1_700_200_000_300,
      endedAt: null,
      createdAt: 1_700_200_000_250,
      updatedAt: 1_700_200_000_300,
    },
  ];

  const view = createMissionWorkpadStatusView({
    mission,
    attempts,
  });
  const rendered = renderMissionWorkpadStatusView(view);

  assert.equal(view.workflowSourceLabel, 'configured workflow (/repo/.codexbridge/mission/WORKFLOW.md)');
  assert.equal(view.attemptHistory.length, 2);
  assert.match(rendered, /Workflow: configured workflow/);
  assert.match(rendered, /Latest blocker: Waiting for log collection to finish/);
  assert.match(rendered, /Attempts:/);
  assert.match(rendered, /#1 failed/);
  assert.match(rendered, /#2 running/);
});
