import { DirectMissionControlApi } from './api.js';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import {
  createMissionStopRequest,
  materializeMissionStop,
  resolveMissionStopReason,
} from './control_actions.js';
import {
  createMissionChecklistSnapshot,
  createMissionGeneration,
  createMissionWorkItem,
  normalizeMissionRecord,
} from './domain_records.js';
import {
  applyMissionVerifierResultToChecklistSnapshot,
  completeChecklistSnapshot,
  createMissionCycleResult,
  getActiveFormalChecklistItem,
  getLatestMissionCycleResult,
  listMissionCycleResults,
  mapMissionStatusToMissionControlOutcome,
  type MissionCycleResult,
} from './cycle_result.js';
import {
  applyMissionProviderStartToAttempt,
  type MissionProvider,
  type MissionProviderArtifact,
  type MissionProviderResult,
} from './provider.js';
import { type MissionRepository } from './repository.js';
import { transitionMission } from './state_machine.js';
import type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionCheckpoint,
  MissionEnvironmentStamp,
  MissionEvent,
} from './types.js';
import {
  applyMissionVerifierResultToAttempt,
  applyMissionVerifierResultToMission,
  applyMissionVerifierResultToWorkpad,
  createMissionRepairPrompt,
  createMissionVerifierResult,
  evaluateMissionVerifierBudget,
  resolveMissionPlanChangeSuggestion,
  resolveMissionVerifierBudget,
  type ResolvedMissionPlanChangeSuggestion,
  type MissionVerifier,
  type MissionVerifierResult,
} from './verifier.js';
import { MissionWorkflowLoader, type LoadedMissionWorkflow } from './workflow.js';
import { MissionWorkflowResolver } from './workflow_resolver.js';
import { MissionLeaseCoordinator } from './lease_coordinator.js';
import { MissionWorkspaceService, type MissionWorkspaceAssignment } from './workspace.js';
import {
  createMissionAttemptPromptContract,
  renderMissionAttemptPromptContract,
} from './prompt_contract.js';
import type { MissionHostAdapter } from './host_adapter.js';
import type { MissionWorkflowResolverReason } from './types.js';

export interface MissionRuntimeOptions {
  repository: MissionRepository;
  provider: MissionProvider;
  verifier: MissionVerifier;
  hostAdapter?: MissionHostAdapter | null;
  workflowLoader?: MissionWorkflowLoader;
  workflowResolver?: MissionWorkflowResolver;
  workspaceService?: MissionWorkspaceService;
  leaseCoordinator?: MissionLeaseCoordinator;
  now?: () => number;
  generateId?: () => string;
}

export interface MissionRunOptions {
  ownerId: string;
  readOnly?: boolean;
  allowSharedCwd?: boolean;
  waitTimeoutMs?: number;
}

export interface MissionRunResult {
  mission: Mission;
  attempt: MissionAttempt | null;
  workflow: LoadedMissionWorkflow | null;
  providerResult: MissionProviderResult | null;
  verifierResult: MissionVerifierResult | null;
  latestCycleResult: MissionCycleResult | null;
  cycleResults: MissionCycleResult[];
  turnsUsed: number;
}

export class MissionRuntime {
  private readonly repository: MissionRepository;

  private readonly provider: MissionProvider;

  private readonly verifier: MissionVerifier;

  private readonly hostAdapter: MissionHostAdapter | null;

  private readonly workflowLoader: MissionWorkflowLoader;

  private readonly workflowResolver: MissionWorkflowResolver;

  private readonly workspaceService: MissionWorkspaceService;

  private readonly leaseCoordinator: MissionLeaseCoordinator;

  private readonly now: () => number;

  private readonly generateId: () => string;

  private readonly readApi: DirectMissionControlApi;

  constructor({
    repository,
    provider,
    verifier,
    hostAdapter = null,
    workflowLoader = new MissionWorkflowLoader(),
    workflowResolver = new MissionWorkflowResolver(),
    workspaceService = new MissionWorkspaceService(),
    leaseCoordinator = new MissionLeaseCoordinator(repository),
    now = () => Date.now(),
    generateId = () => crypto.randomUUID(),
  }: MissionRuntimeOptions) {
    this.repository = repository;
    this.provider = provider;
    this.verifier = verifier;
    this.hostAdapter = hostAdapter;
    this.workflowLoader = workflowLoader;
    this.workflowResolver = workflowResolver;
    this.workspaceService = workspaceService;
    this.leaseCoordinator = leaseCoordinator;
    this.now = now;
    this.generateId = generateId;
    this.readApi = new DirectMissionControlApi({
      repository,
      now,
      generateId,
      workflowLoader,
      workflowResolver,
    });
  }

  async runMission(
    missionId: string,
    options: MissionRunOptions,
  ): Promise<MissionRunResult> {
    let mission = this.ensureMissionDomainRecords(this.requireMission(missionId));
    const initialEventCount = this.repository.listEvents(mission.id).length;
    let workflow: LoadedMissionWorkflow | null = null;
    let lastAttempt: MissionAttempt | null = null;
    let lastProviderResult: MissionProviderResult | null = null;
    let lastVerifierResult: MissionVerifierResult | null = null;
    mission = this.leaseCoordinator.claimMission(mission.id, {
      ownerId: options.ownerId,
    });
    const claimedStop = await this.consumePersistedStopRequest(mission.id, options.ownerId, {
      interruptProvider: true,
    });
    if (claimedStop.stopped) {
      return this.finalizeRun(claimedStop.mission, options.ownerId, initialEventCount, {
        attempt: claimedStop.attempt,
        workflow: null,
        providerResult: null,
        verifierResult: null,
      });
    }
    mission = claimedStop.mission;
    lastAttempt = claimedStop.attempt;

    try {
      const workflowSelection = this.workflowResolver.resolve(mission);
      mission = this.persistWorkflowTrace(mission, {
        workflowPath: workflowSelection.workflowPath,
        workflowHash: null,
        resolverReason: workflowSelection.resolverReason,
      });
      const workflowResult = this.workflowLoader.tryLoad({
        explicitPath: workflowSelection.explicitPath ?? undefined,
        cwd: mission.cwd,
        workspacePath: mission.workspacePath,
      });
      if (!workflowResult.workflow) {
        const summary = workflowResult.error.message;
        mission = this.failMissionFromCurrentState(mission, summary, null, this.now());
        this.saveMission(mission);
        const cycleResult = this.buildMissionCycleResult({
          mission,
          attempt: null,
          status: 'failed',
          stage: 'workflow.load',
          progress: summary,
          blocker: summary,
          evidence: {
            workflowPath: workflowResult.error.workflowPath,
            workflowHash: null,
            resolverReason: workflowSelection.resolverReason,
            issues: [...workflowResult.error.issues],
          },
        });
        this.appendMissionEvent(mission, 'mission.failed', summary, null, {
          workflowPath: workflowResult.error.workflowPath,
          workflowHash: null,
          resolverReason: workflowSelection.resolverReason,
          issues: [...workflowResult.error.issues],
          cycleResult,
        });
        this.saveCheckpointRecord(mission, null, 'workflow.load_failed', summary, {
          workflowPath: workflowResult.error.workflowPath,
          workflowHash: null,
          resolverReason: workflowSelection.resolverReason,
          issues: [...workflowResult.error.issues],
        });
        await this.emitHostNotification(mission, null, cycleResult);
        return this.finalizeRun(mission, options.ownerId, initialEventCount, {
          attempt: null,
          workflow: null,
          providerResult: null,
          verifierResult: null,
        });
      }
      workflow = workflowResult.workflow;
      mission = this.persistWorkflowTrace(mission, {
        workflowPath: workflow.source.path,
        workflowHash: workflow.hash,
        resolverReason: workflowSelection.resolverReason,
      });

      const workspace = this.workspaceService.ensureWorkspace(mission, {
        readOnly: options.readOnly,
        allowSharedCwd: options.allowSharedCwd,
      });
      mission = this.updateMissionFields(mission, {
        workspacePath: workspace.workspacePath,
      });
      this.saveCheckpointRecord(mission, null, 'workspace.ready', 'Workspace ready for mission execution.', {
        workspacePath: workspace.workspacePath,
        mode: workspace.mode,
        workflowPath: workflow.source.path,
      });
      const workspaceStop = await this.consumePersistedStopRequest(mission.id, options.ownerId, {
        interruptProvider: true,
      });
      if (workspaceStop.stopped) {
        return this.finalizeRun(workspaceStop.mission, options.ownerId, initialEventCount, {
          attempt: workspaceStop.attempt,
          workflow,
          providerResult: null,
          verifierResult: null,
        });
      }
      mission = workspaceStop.mission;
      lastAttempt = workspaceStop.attempt;

      for (;;) {
        mission = this.requireMission(mission.id);
        const loopStop = await this.consumePersistedStopRequest(mission.id, options.ownerId, {
          interruptProvider: true,
        });
        if (loopStop.stopped) {
          return this.finalizeRun(loopStop.mission, options.ownerId, initialEventCount, {
            attempt: loopStop.attempt,
            workflow,
            providerResult: lastProviderResult,
            verifierResult: lastVerifierResult,
          });
        }
        mission = loopStop.mission;
        const maxLoopsReached = await this.materializeMaxLoopsReached(mission);
        if (maxLoopsReached) {
          return this.finalizeRun(maxLoopsReached, options.ownerId, initialEventCount, {
            attempt: lastAttempt,
            workflow,
            providerResult: lastProviderResult,
            verifierResult: lastVerifierResult,
          });
        }
        if (mission.status === 'verifying') {
          const verifyingAttempt = this.requireActiveAttempt(mission);
          lastAttempt = verifyingAttempt;
          const providerResult: MissionProviderResult = lastProviderResult
            ?? this.restoreProviderResultFromAttempt(mission, verifyingAttempt);
          const verification = await this.verifyAttempt({
            mission,
            attempt: verifyingAttempt,
            workflow,
            providerResult,
            ownerId: options.ownerId,
          });
          mission = verification.mission;
          lastAttempt = verification.attempt;
          lastProviderResult = providerResult;
          lastVerifierResult = verification.verifierResult;
          if (verification.continueMission || mission.status === 'repairing') {
            continue;
          }
          return this.finalizeRun(mission, options.ownerId, initialEventCount, {
            attempt: verification.attempt,
            workflow,
            providerResult,
            verifierResult: verification.verifierResult,
          });
        }

        const execution = this.prepareExecution({
          mission,
          workflow,
        });
        mission = execution.mission;
        lastAttempt = execution.attempt;
        this.saveEnvironmentStamp(mission, execution.attempt, workspace);
        this.saveCheckpointRecord(
          mission,
          execution.attempt,
          'attempt.started',
          `Attempt #${execution.attempt.index} is ready to run.`,
          {
            workflowPath: workflow.source.path,
            workflowHash: workflow.hash,
            providerThreadId: execution.attempt.providerThreadId,
            promptDigest: execution.attempt.promptDigest,
            workspacePath: workspace.workspacePath,
          },
        );

        const providerRun = await this.runProviderUntilCandidateOrTerminal({
          mission,
          attempt: execution.attempt,
          workflow,
          workspace,
          promptText: execution.promptText,
          ownerId: options.ownerId,
          waitTimeoutMs: options.waitTimeoutMs,
        });
        mission = providerRun.mission;
        lastAttempt = providerRun.attempt;
        lastProviderResult = providerRun.providerResult;
        if (providerRun.providerResult === null || mission.status !== 'verifying') {
          return this.finalizeRun(mission, options.ownerId, initialEventCount, {
            attempt: providerRun.attempt,
            workflow,
            providerResult: providerRun.providerResult,
            verifierResult: null,
          });
        }
      }
    } catch (error) {
      const summary = formatErrorMessage(error);
      mission = this.failMissionFromCurrentState(mission, summary, lastAttempt, this.now());
      this.saveMission(mission);
      if (lastAttempt) {
        this.repository.saveAttempt({
          ...lastAttempt,
          status: 'failed',
          error: summary,
          endedAt: lastAttempt.endedAt ?? this.now(),
          updatedAt: this.now(),
        });
      }
      const cycleResult = this.buildMissionCycleResult({
        mission,
        attempt: lastAttempt,
        status: 'failed',
        stage: 'runtime.exception',
        progress: summary,
        blocker: summary,
        evidence: {
          error: summary,
        },
      });
      this.appendMissionEvent(mission, 'mission.failed', summary, lastAttempt, {
        error: summary,
        cycleResult,
      });
      this.saveCheckpointRecord(mission, lastAttempt, 'runtime.exception', summary, {
        error: summary,
      });
      await this.emitHostNotification(mission, lastAttempt, cycleResult);
      return this.finalizeRun(mission, options.ownerId, initialEventCount, {
        attempt: lastAttempt,
        workflow,
        providerResult: lastProviderResult,
        verifierResult: lastVerifierResult,
      });
    }
  }

  async stopMission(
    missionId: string,
    options: {
      ownerId: string;
      reason?: string | null;
    },
  ): Promise<Mission> {
    const mission = this.requireMission(missionId);
    if (
      mission.status === 'stopped'
      || mission.status === 'completed'
      || mission.status === 'failed'
      || mission.status === 'archived'
    ) {
      return mission;
    }
    const reason = normalizeText(options.reason) ?? 'Mission stopped.';
    const requested = createMissionStopRequest(mission, {
      at: this.now(),
      actorId: options.ownerId,
      actorType: 'system',
      reason,
    });
    this.saveMission(requested);
    this.appendMissionEvent(requested, 'mission.stop_requested', reason, null, {
      ownerId: options.ownerId,
    });
    return (await this.consumePersistedStopRequest(requested.id, options.ownerId, {
      interruptProvider: true,
    })).mission;
  }

  private prepareExecution(input: {
    mission: Mission;
    workflow: LoadedMissionWorkflow;
  }): {
    mission: Mission;
    attempt: MissionAttempt;
    promptText: string;
  } {
    const at = this.now();
    let mission = input.mission;
    if (mission.status === 'queued') {
      mission = transitionMission(mission, 'planning', {
        at,
        reason: 'Workflow loaded and workspace ready.',
      });
      this.saveMission(mission);
      this.appendMissionEvent(mission, 'mission.planning', 'Mission planning started.', null, {
        workflowPath: input.workflow.source.path,
        workflowHash: input.workflow.hash,
        resolverReason: mission.workflowResolverReason,
      });
    }

    if (mission.status === 'repairing') {
      const previousAttempt = this.requireActiveAttempt(mission);
      const nextAttempt = this.createAttempt(mission, mission.attemptCount + 1, 'running', at);
      const promptText = createMissionRepairPrompt({
        mission,
        attempt: previousAttempt,
        checklistSnapshot: this.repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId),
        workflow: input.workflow,
        verifierResult: {
          summary: previousAttempt.verifierSummary ?? mission.statusReason ?? 'Verifier requested a repair.',
          missingAcceptanceCriteria: previousAttempt.missingAcceptanceCriteria,
        },
      });
      const runningMission = this.persistAttemptStart(mission, nextAttempt, promptText, at);
      return {
        mission: runningMission,
        attempt: this.requireAttempt(nextAttempt.id),
        promptText,
      };
    }

    if (mission.status !== 'planning' && mission.status !== 'running') {
      throw new Error(`mission ${mission.id} is not runnable from status ${mission.status}`);
    }

    if (mission.activeAttemptId) {
      const existingAttempt = this.repository.getAttemptById(mission.activeAttemptId);
      if (existingAttempt && existingAttempt.status === 'running' && existingAttempt.startedAt === null) {
        const promptText = renderMissionAttemptPromptContract(createMissionAttemptPromptContract({
          mission,
          attempt: existingAttempt,
          workflow: input.workflow,
          checklistSnapshot: this.repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId),
        }));
        return {
          mission,
          attempt: existingAttempt,
          promptText,
        };
      }
      if (mission.status === 'running') {
        throw new Error(
          `mission ${mission.id} cannot resume a persisted running attempt without a host-specific recovery adapter yet`,
        );
      }
    }

    const attempt = this.createAttempt(mission, mission.attemptCount + 1, 'running', at);
    const promptText = renderMissionAttemptPromptContract(createMissionAttemptPromptContract({
      mission,
      attempt,
      workflow: input.workflow,
      checklistSnapshot: this.repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId),
    }));
    const runningMission = this.persistAttemptStart(mission, attempt, promptText, at);
    return {
      mission: runningMission,
      attempt: this.requireAttempt(attempt.id),
      promptText,
    };
  }

  private persistAttemptStart(
    mission: Mission,
    attempt: MissionAttempt,
    promptText: string,
    at: number,
  ): Mission {
    this.repository.saveAttempt({
      ...attempt,
      promptDigest: digestPrompt(promptText),
      updatedAt: at,
    });
    this.appendAttemptEvent(mission, attempt, 'attempt.created', `Attempt #${attempt.index} created.`, {
      promptDigest: digestPrompt(promptText),
    });
    const runningMission = mission.status === 'running'
      ? {
        ...mission,
        lastRunAt: at,
        statusReason: `Attempt #${attempt.index} started.`,
        activeAttemptId: attempt.id,
        lastError: null,
        updatedAt: at,
      }
      : transitionMission(mission, 'running', {
        at,
        reason: `Attempt #${attempt.index} started.`,
        activeAttemptId: attempt.id,
        lastError: null,
      });
    const savedMission = this.saveMission({
      ...runningMission,
      attemptCount: attempt.index,
    });
    this.appendMissionEvent(savedMission, 'mission.started', `Attempt #${attempt.index} started.`, attempt, {
      attemptIndex: attempt.index,
    });
    return savedMission;
  }

  private async runProviderUntilCandidateOrTerminal(input: {
    mission: Mission;
    attempt: MissionAttempt;
    workflow: LoadedMissionWorkflow;
    workspace: MissionWorkspaceAssignment;
    promptText: string;
    ownerId: string;
    waitTimeoutMs?: number;
  }): Promise<{
    mission: Mission;
    attempt: MissionAttempt;
    providerResult: MissionProviderResult | null;
  }> {
    let mission = input.mission;
    let attempt = input.attempt;
    let promptText = input.promptText;
    let turnIndex = 0;

    for (;;) {
      const turnBudget = this.resolveBudgetUsage(mission.id, attempt, this.now());
      const budget = resolveMissionVerifierBudget({
        mission,
        workflow: input.workflow,
      });
      const turnIssues = evaluateMissionVerifierBudget(budget, {
        attemptCount: turnBudget.attemptCount,
        turnCount: turnBudget.turnCount,
        runtimeMs: turnBudget.runtimeMs,
        artifactCount: turnBudget.artifactCount,
        artifactBytes: turnBudget.artifactBytes,
      }).filter((issue) => issue.startsWith('max turns exhausted') || issue.startsWith('max runtime exhausted'));
      if (turnIssues.length > 0) {
        const failedResult = createMissionVerifierResult({
          verdict: 'failed',
          budgetExceededReasons: turnIssues,
        });
        const failedAttempt = applyMissionVerifierResultToAttempt(attempt, failedResult, this.now());
        this.repository.saveAttempt(failedAttempt);
        mission = applyMissionVerifierResultToMission(mission, failedResult, {
          at: this.now(),
        });
        this.saveMission(mission);
        const cycleResult = this.buildMissionCycleResult({
          mission,
          attempt: failedAttempt,
          status: 'failed',
          stage: 'runtime.turn_budget',
          progress: failedResult.summary,
          verifierSummary: failedResult.summary,
          blocker: failedResult.summary,
          evidence: {
            budgetExceededReasons: [...turnIssues],
          },
        });
        this.appendMissionEvent(mission, 'mission.failed', failedResult.summary, failedAttempt, {
          budgetExceededReasons: [...turnIssues],
          cycleResult,
        });
        this.saveCheckpointRecord(mission, failedAttempt, 'runtime.turn_budget', failedResult.summary, {
          budgetExceededReasons: [...turnIssues],
        });
        await this.emitHostNotification(mission, failedAttempt, cycleResult);
        return {
          mission,
          attempt: failedAttempt,
          providerResult: null,
        };
      }

      turnIndex += 1;
      const executionInput = {
        mission,
        attempt,
        workflow: input.workflow,
        workspace: input.workspace,
        promptText,
      };
      const started = turnIndex === 1 && !attempt.providerRunId
        ? await this.provider.start(executionInput)
        : await this.provider.continue(executionInput);
      const startedAt = this.now();
      attempt = this.repository.saveAttempt({
        ...applyMissionProviderStartToAttempt({
          ...attempt,
          promptDigest: digestPrompt(promptText),
        }, started, startedAt),
        status: 'running',
      });
      mission = this.updateMissionFields(mission, {
        codexThreadId: started.providerThreadId ?? mission.codexThreadId,
        activeAttemptId: attempt.id,
      });
      this.appendAttemptEvent(mission, attempt, 'attempt.started', `Provider turn ${turnIndex} started.`, {
        providerRunId: started.providerRunId,
        providerThreadId: started.providerThreadId,
        providerTurn: true,
        turnIndex,
      });
      const startedStop = await this.consumePersistedStopRequest(mission.id, input.ownerId, {
        interruptProvider: true,
      });
      if (startedStop.stopped) {
        return {
          mission: startedStop.mission,
          attempt: startedStop.attempt ?? attempt,
          providerResult: null,
        };
      }
      mission = startedStop.mission;
      attempt = startedStop.attempt ?? attempt;

      const providerResult = await this.provider.wait(started.providerRunId, {
        timeoutMs: input.waitTimeoutMs,
      });
      const artifactBytes = computeArtifactBytes(providerResult.artifacts);
      const preview = normalizeText(providerResult.text) ?? normalizeText(providerResult.previewText);
      attempt = this.repository.saveAttempt({
        ...attempt,
        outputPreview: preview,
        error: providerResult.errorMessage,
        updatedAt: this.now(),
      });
      this.appendAttemptEvent(mission, attempt, 'attempt.progress', `Provider turn ${turnIndex} completed.`, {
        providerRunId: attempt.providerRunId,
        providerThreadId: attempt.providerThreadId,
        providerTurn: true,
        turnIndex,
        outcome: providerResult.outcome,
        rawState: providerResult.rawState,
        continuationEligible: providerResult.continuationEligible,
        artifactCount: providerResult.artifacts.length,
        artifactBytes,
      });
      const waitedStop = await this.consumePersistedStopRequest(mission.id, input.ownerId, {
        interruptProvider: false,
      });
      if (waitedStop.stopped) {
        return {
          mission: waitedStop.mission,
          attempt: waitedStop.attempt ?? attempt,
          providerResult,
        };
      }
      mission = waitedStop.mission;
      attempt = waitedStop.attempt ?? attempt;

      if ((providerResult.outcome === 'partial' || providerResult.outcome === 'missing')
        && input.workflow.policy.continuation === 'allow') {
        promptText = buildContinuationPrompt({
          mission,
          attempt,
          checklistSnapshot: this.repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId),
          workflow: input.workflow,
          providerResult,
          turnIndex,
        });
        attempt = this.repository.saveAttempt({
          ...attempt,
          promptDigest: digestPrompt(promptText),
          updatedAt: this.now(),
        });
        const cycleResult = this.buildMissionCycleResult({
          mission,
          attempt,
          status: 'continue',
          stage: 'provider.continuation',
          progress: 'Mission scheduled a continuation turn.',
          nextStep: 'Continue the same attempt with another provider turn.',
          blocker: null,
          evidence: {
            turnIndex,
            outcome: providerResult.outcome,
            providerRunId: attempt.providerRunId,
          },
        });
        this.appendMissionEvent(mission, 'mission.progress', 'Mission scheduled a continuation turn.', attempt, {
          turnIndex,
          outcome: providerResult.outcome,
          cycleResult,
        });
        this.saveCheckpointRecord(mission, attempt, 'provider.continuation', 'Mission scheduled a continuation turn.', {
          turnIndex,
          outcome: providerResult.outcome,
          providerRunId: attempt.providerRunId,
          continuationEligible: providerResult.continuationEligible,
        });
        await this.emitHostNotification(mission, attempt, cycleResult);
        continue;
      }

      if (providerResult.handoffState || providerResult.outcome === 'blocked') {
        const nextStatus = providerResult.handoffState ?? (providerResult.requiresHuman ? 'needs_human' : 'blocked');
        const endedAttempt = this.repository.saveAttempt({
          ...attempt,
          status: nextStatus,
          error: providerResult.errorMessage ?? providerResult.stopReason,
          endedAt: this.now(),
          updatedAt: this.now(),
        });
        mission = transitionMission(mission, nextStatus, {
          at: this.now(),
          reason: providerResult.stopReason ?? providerResult.text ?? providerResult.previewText,
          activeAttemptId: endedAttempt.id,
          lastError: providerResult.errorMessage ?? providerResult.stopReason,
          lastResultPreview: preview,
        });
        this.saveMission(mission);
        const cycleResult = this.buildMissionCycleResult({
          mission,
          attempt: endedAttempt,
          status: nextStatus,
          stage: 'provider.terminal',
          progress: providerResult.stopReason ?? providerResult.previewText ?? providerResult.text ?? 'Mission blocked.',
          blocker: providerResult.errorMessage ?? providerResult.stopReason,
          needUserAction: nextStatus === 'waiting_user'
            ? (providerResult.stopReason ?? providerResult.previewText ?? providerResult.text)
            : null,
          evidence: {
            providerRunId: endedAttempt.providerRunId,
            handoffState: providerResult.handoffState,
            outcome: providerResult.outcome,
          },
        });
        this.appendMissionEvent(
          mission,
          mapMissionTerminalStatusToEventKind(nextStatus),
          providerResult.stopReason ?? providerResult.previewText ?? providerResult.text ?? 'Mission blocked.',
          endedAttempt,
          {
            providerRunId: endedAttempt.providerRunId,
            handoffState: providerResult.handoffState,
            cycleResult,
          },
        );
        this.saveCheckpointRecord(
          mission,
          endedAttempt,
          `provider.${nextStatus}`,
          providerResult.stopReason ?? providerResult.previewText ?? providerResult.text ?? 'Mission blocked.',
          {
            providerRunId: endedAttempt.providerRunId,
            handoffState: providerResult.handoffState,
            outcome: providerResult.outcome,
          },
        );
        await this.emitHostNotification(mission, endedAttempt, cycleResult);
        return {
          mission,
          attempt: endedAttempt,
          providerResult,
        };
      }

      if (providerResult.outcome === 'interrupted' || providerResult.outcome === 'stopped') {
        const endedAttempt = this.repository.saveAttempt({
          ...attempt,
          status: 'stopped',
          error: providerResult.stopReason ?? providerResult.errorMessage,
          endedAt: this.now(),
          updatedAt: this.now(),
        });
        mission = transitionMission(mission, 'stopped', {
          at: this.now(),
          reason: providerResult.stopReason ?? 'Mission stopped.',
          activeAttemptId: endedAttempt.id,
          lastError: providerResult.errorMessage ?? providerResult.stopReason,
          lastResultPreview: preview,
        });
        this.saveMission(mission);
        const cycleResult = this.buildMissionCycleResult({
          mission,
          attempt: endedAttempt,
          status: 'stopped',
          stage: 'provider.stopped',
          progress: providerResult.stopReason ?? 'Mission stopped.',
          blocker: providerResult.errorMessage ?? providerResult.stopReason,
          evidence: {
            providerRunId: endedAttempt.providerRunId,
            outcome: providerResult.outcome,
          },
        });
        this.appendMissionEvent(mission, 'mission.stopped', providerResult.stopReason ?? 'Mission stopped.', endedAttempt, {
          providerRunId: endedAttempt.providerRunId,
          cycleResult,
        });
        this.saveCheckpointRecord(mission, endedAttempt, 'provider.stopped', providerResult.stopReason ?? 'Mission stopped.', {
          providerRunId: endedAttempt.providerRunId,
          outcome: providerResult.outcome,
        });
        await this.emitHostNotification(mission, endedAttempt, cycleResult);
        return {
          mission,
          attempt: endedAttempt,
          providerResult,
        };
      }

      if (providerResult.outcome === 'failed' || providerResult.outcome === 'provider_error') {
        const summary = providerResult.errorMessage ?? providerResult.stopReason ?? 'Mission provider failed.';
        const endedAttempt = this.repository.saveAttempt({
          ...attempt,
          status: 'failed',
          error: summary,
          endedAt: this.now(),
          updatedAt: this.now(),
        });
        mission = transitionMission(mission, 'failed', {
          at: this.now(),
          reason: summary,
          activeAttemptId: endedAttempt.id,
          lastError: summary,
          lastResultPreview: preview,
        });
        this.saveMission(mission);
        const cycleResult = this.buildMissionCycleResult({
          mission,
          attempt: endedAttempt,
          status: 'failed',
          stage: 'provider.failed',
          progress: summary,
          blocker: summary,
          evidence: {
            providerRunId: endedAttempt.providerRunId,
            outcome: providerResult.outcome,
          },
        });
        this.appendMissionEvent(mission, 'mission.failed', summary, endedAttempt, {
          providerRunId: endedAttempt.providerRunId,
          outcome: providerResult.outcome,
          cycleResult,
        });
        this.saveCheckpointRecord(mission, endedAttempt, 'provider.failed', summary, {
          providerRunId: endedAttempt.providerRunId,
          outcome: providerResult.outcome,
        });
        await this.emitHostNotification(mission, endedAttempt, cycleResult);
        return {
          mission,
          attempt: endedAttempt,
          providerResult,
        };
      }

      if (providerResult.outcome !== 'completed'
        && providerResult.outcome !== 'partial'
        && providerResult.outcome !== 'missing') {
        throw new Error(`unsupported provider outcome: ${providerResult.outcome}`);
      }

      const verifyingAttempt = this.repository.saveAttempt({
        ...attempt,
        status: 'verifying',
        outputPreview: preview,
        error: providerResult.errorMessage,
        updatedAt: this.now(),
      });
      mission = transitionMission(mission, 'verifying', {
        at: this.now(),
        reason: 'Provider returned a candidate result for verification.',
        activeAttemptId: verifyingAttempt.id,
        lastResultPreview: preview,
        lastError: providerResult.errorMessage,
      });
      mission = this.updateMissionFields(mission, {
        resultArtifacts: [...providerResult.artifacts],
      });
      this.appendAttemptEvent(mission, verifyingAttempt, 'attempt.verifying', 'Attempt moved to verification.', {
        providerRunId: verifyingAttempt.providerRunId,
        artifactCount: providerResult.artifacts.length,
        artifactBytes,
      });
      this.appendMissionEvent(mission, 'mission.verifying', 'Mission is waiting for verifier output.', verifyingAttempt, {
        providerRunId: verifyingAttempt.providerRunId,
      });
      this.saveCheckpointRecord(
        mission,
        verifyingAttempt,
        'provider.candidate_ready',
        'Provider returned a candidate result for verification.',
        {
          providerRunId: verifyingAttempt.providerRunId,
          artifactCount: providerResult.artifacts.length,
          artifactBytes,
          outcome: providerResult.outcome,
        },
      );
      return {
        mission,
        attempt: verifyingAttempt,
        providerResult,
      };
    }
  }

  private async verifyAttempt(input: {
    mission: Mission;
    attempt: MissionAttempt;
    workflow: LoadedMissionWorkflow;
    providerResult: MissionProviderResult;
    ownerId: string;
  }): Promise<{
    mission: Mission;
    attempt: MissionAttempt;
    verifierResult: MissionVerifierResult;
    continueMission: boolean;
  }> {
    const currentChecklistSnapshot = this.repository.getChecklistSnapshotById(
      input.mission.currentChecklistSnapshotId,
    );
    const activeChecklistItem = getActiveFormalChecklistItem(currentChecklistSnapshot);
    const usage = this.resolveBudgetUsage(input.mission.id, input.attempt, this.now());
    const verifierResult = await this.verifier.verify({
      mission: input.mission,
      attempt: input.attempt,
      checklistSnapshot: currentChecklistSnapshot,
      activeChecklistItem,
      workflow: input.workflow,
      providerResult: input.providerResult,
      attemptCount: usage.attemptCount,
      turnCount: usage.turnCount,
      runtimeMs: usage.runtimeMs,
      artifactBytes: usage.artifactBytes,
    });
    const requestedStop = await this.consumePersistedStopRequest(input.mission.id, input.ownerId, {
      interruptProvider: false,
    });
    if (requestedStop.stopped) {
      return {
        mission: requestedStop.mission,
        attempt: requestedStop.attempt ?? input.attempt,
        verifierResult,
        continueMission: false,
      };
    }
    const budget = resolveMissionVerifierBudget({
      mission: input.mission,
      workflow: input.workflow,
    });
    const budgetIssues = verifierResult.verdict === 'complete'
      ? []
      : evaluateMissionVerifierBudget(budget, usage);
    const effectiveResult = budgetIssues.length > 0
      ? createMissionVerifierResult({
        verdict: 'failed',
        budgetExceededReasons: budgetIssues,
      })
      : verifierResult;
    const resolvedPlanChangeSuggestion = resolveMissionPlanChangeSuggestion(
      input.mission,
      effectiveResult.planChangeSuggestion,
    );

    let updatedChecklistSnapshot = currentChecklistSnapshot
      ? applyMissionVerifierResultToChecklistSnapshot(
        currentChecklistSnapshot,
        effectiveResult,
        this.now(),
        {
          activeItemId: activeChecklistItem?.id ?? null,
        },
      )
      : null;
    const activeChecklistItemAfterVerification = updatedChecklistSnapshot && activeChecklistItem
      ? updatedChecklistSnapshot.items.find((item) => item.id === activeChecklistItem.id) ?? null
      : null;
    const activeChecklistItemCompleted = currentChecklistSnapshot
      ? activeChecklistItemAfterVerification?.status === 'completed'
      : effectiveResult.verdict === 'complete';
    const hasPlanChecklistItems = currentChecklistSnapshot?.items.some((item) => item.kind === 'plan') ?? false;
    const hasRemainingPlanChecklistItems = updatedChecklistSnapshot?.items.some(
      (item) => item.kind === 'plan' && item.status !== 'completed' && item.status !== 'skipped',
    ) ?? false;
    const hasAcceptanceItems = currentChecklistSnapshot?.items.some((item) => item.kind === 'acceptance') ?? false;
    const hasRemainingAcceptanceItems = updatedChecklistSnapshot?.items.some(
      (item) => item.kind === 'acceptance' && item.status !== 'completed' && item.status !== 'skipped',
    ) ?? false;
    const hasRemainingChecklistItems = updatedChecklistSnapshot?.items.some(
      (item) => item.status !== 'completed' && item.status !== 'skipped',
    ) ?? false;
    const canFinalizeMission = effectiveResult.verdict === 'complete'
      && activeChecklistItemCompleted
      && (
        !updatedChecklistSnapshot
        || (hasPlanChecklistItems
          ? !hasRemainingPlanChecklistItems
          : hasAcceptanceItems
            ? !hasRemainingAcceptanceItems
            : !hasRemainingChecklistItems)
      );
    if (updatedChecklistSnapshot && canFinalizeMission) {
      updatedChecklistSnapshot = completeChecklistSnapshot(
        updatedChecklistSnapshot,
        effectiveResult.summary,
        this.now(),
      );
    }
    if (updatedChecklistSnapshot) {
      this.repository.saveChecklistSnapshot(updatedChecklistSnapshot);
    }

    let updatedAttempt = applyMissionVerifierResultToAttempt(
      input.attempt,
      effectiveResult,
      this.now(),
    );
    if (
      activeChecklistItemCompleted
      && (effectiveResult.verdict === 'complete' || effectiveResult.verdict === 'repair')
    ) {
      updatedAttempt = {
        ...updatedAttempt,
        status: 'completed',
        error: null,
        endedAt: this.now(),
        updatedAt: this.now(),
      };
    }
    updatedAttempt = this.repository.saveAttempt(updatedAttempt);

    if (resolvedPlanChangeSuggestion) {
      const planChangeMeta = this.buildRuntimeCommandMeta(
        input.mission.id,
        `verifier-plan-change:${updatedAttempt.id}`,
      );
      this.readApi.commands.proposePlanChange({
        meta: planChangeMeta,
        input: {
          missionId: input.mission.id,
          rationale: resolvedPlanChangeSuggestion.rationale,
          proposedExpectedOutput: resolvedPlanChangeSuggestion.proposedExpectedOutput,
          proposedAcceptanceCriteria: resolvedPlanChangeSuggestion.proposedAcceptanceCriteria,
          proposedPlan: resolvedPlanChangeSuggestion.proposedPlan,
          actor: {
            actorId: 'mission-runtime',
            actorType: 'system',
          },
        },
      });
      const pendingMission = this.requireMission(input.mission.id);
      const pendingPlanChangeRequest = this.repository
        .listPlanChangeRequests(input.mission.id)
        .filter((changeRequest) => changeRequest.status === 'proposed')
        .sort((left, right) => left.createdAt - right.createdAt)
        .at(-1) ?? null;
      const cycleProgressSummary = effectiveResult.progressSummary
        ?? resolvedPlanChangeSuggestion.rationale;
      const cycleResult = this.buildMissionCycleResult({
        mission: pendingMission,
        attempt: updatedAttempt,
        checklistSnapshot: updatedChecklistSnapshot,
        status: 'waiting_user',
        stage: 'verifier.plan_change',
        progress: cycleProgressSummary,
        nextStep: effectiveResult.nextStep
          ?? 'Review and resolve the proposed formal checklist refinement before continuing the mission.',
        verifierSummary: effectiveResult.summary,
        blocker: 'Resolve the proposed checklist scope change before continuing the mission.',
        needUserAction: effectiveResult.latestBlocker
          ?? 'Review and approve or reject the proposed formal checklist refinement.',
        planChangeSuggestion: buildRuntimePlanChangeSuggestionRecord(
          resolvedPlanChangeSuggestion,
          pendingPlanChangeRequest?.id ?? null,
        ),
        evidence: {
          verdict: effectiveResult.verdict,
          planChangeRequestId: pendingPlanChangeRequest?.id ?? null,
          missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
          budgetExceededReasons: [...effectiveResult.budgetExceededReasons],
        },
      });
      this.appendMissionEvent(
        pendingMission,
        'mission.progress',
        cycleProgressSummary,
        updatedAttempt,
        {
          verdict: effectiveResult.verdict,
          planChangeRequestId: pendingPlanChangeRequest?.id ?? null,
          missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
          budgetExceededReasons: [...effectiveResult.budgetExceededReasons],
          planChangeSuggestion: buildRuntimePlanChangeSuggestionRecord(
            resolvedPlanChangeSuggestion,
            pendingPlanChangeRequest?.id ?? null,
          ),
          cycleResult,
        },
      );
      this.saveCheckpointRecord(pendingMission, updatedAttempt, 'verifier.plan_change', cycleProgressSummary, {
        verdict: effectiveResult.verdict,
        planChangeRequestId: pendingPlanChangeRequest?.id ?? null,
        proposedExpectedOutput: resolvedPlanChangeSuggestion.proposedExpectedOutput,
        proposedAcceptanceCriteria: [...resolvedPlanChangeSuggestion.proposedAcceptanceCriteria],
        proposedPlan: [...resolvedPlanChangeSuggestion.proposedPlan],
      });
      await this.emitHostNotification(pendingMission, updatedAttempt, cycleResult);
      return {
        mission: pendingMission,
        attempt: updatedAttempt,
        verifierResult: effectiveResult,
        continueMission: false,
      };
    }

    const continueMission = activeChecklistItemCompleted
      && !canFinalizeMission
      && (effectiveResult.verdict === 'complete' || effectiveResult.verdict === 'repair');
    const cycleProgressSummary = effectiveResult.progressSummary ?? effectiveResult.summary;

    let mission: Mission;
    if (continueMission) {
      const continuationSummary = cycleProgressSummary || (activeChecklistItem
        ? `Checklist item complete: ${activeChecklistItem.title}`
        : 'Checklist item complete. Continue the mission loop.');
      mission = transitionMission(input.mission, 'queued', {
        at: this.now(),
        reason: continuationSummary,
        activeAttemptId: updatedAttempt.id,
        lastError: null,
        lastResultPreview: input.providerResult.previewText
          ?? input.providerResult.text
          ?? input.mission.lastResultPreview,
        workpad: {
          ...applyMissionVerifierResultToWorkpad(input.mission.workpad, effectiveResult, this.now()),
          latestBlocker: null,
          finalResultSummary: input.mission.workpad.finalResultSummary,
          updatedAt: this.now(),
        },
      });
      mission = this.saveMission(mission);
      const cycleResult = this.buildMissionCycleResult({
        mission,
        attempt: updatedAttempt,
        checklistSnapshot: updatedChecklistSnapshot,
        status: 'continue',
        stage: `verifier.${effectiveResult.verdict}`,
        progress: continuationSummary,
        nextStep: effectiveResult.nextStep ?? 'Advance to the next checklist item within the same mission generation.',
        verifierSummary: effectiveResult.summary,
        evidence: {
          verdict: effectiveResult.verdict,
          completedItemId: activeChecklistItem?.id ?? null,
          completedItemTitle: activeChecklistItem?.title ?? null,
          missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
          budgetExceededReasons: [...effectiveResult.budgetExceededReasons],
        },
      });
      this.appendMissionEvent(mission, 'mission.progress', continuationSummary, updatedAttempt, {
        verdict: effectiveResult.verdict,
        completedItemId: activeChecklistItem?.id ?? null,
        completedItemTitle: activeChecklistItem?.title ?? null,
        missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
        budgetExceededReasons: [...effectiveResult.budgetExceededReasons],
        cycleResult,
      });
      this.saveCheckpointRecord(mission, updatedAttempt, 'verifier.continue_item', continuationSummary, {
        verdict: effectiveResult.verdict,
        completedItemId: activeChecklistItem?.id ?? null,
        completedItemTitle: activeChecklistItem?.title ?? null,
        missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
        budgetExceededReasons: [...effectiveResult.budgetExceededReasons],
      });
      await this.emitHostNotification(mission, updatedAttempt, cycleResult);
      return {
        mission,
        attempt: updatedAttempt,
        verifierResult: effectiveResult,
        continueMission: true,
      };
    }

    mission = applyMissionVerifierResultToMission(input.mission, effectiveResult, {
      at: this.now(),
      resultText: effectiveResult.verdict === 'complete'
        ? input.providerResult.text
        : input.mission.resultText,
      resultArtifacts: effectiveResult.verdict === 'complete'
        ? input.providerResult.artifacts
        : input.mission.resultArtifacts,
    });
    mission = this.saveMission(mission);

    if (effectiveResult.verdict === 'repair') {
      const cycleResult = this.buildMissionCycleResult({
        mission,
        attempt: updatedAttempt,
        checklistSnapshot: updatedChecklistSnapshot,
        status: 'retry',
        stage: 'verifier.repair',
        progress: cycleProgressSummary,
        nextStep: effectiveResult.nextStep ?? 'Render a repair prompt and retry the mission within budget.',
        verifierSummary: effectiveResult.summary,
        blocker: effectiveResult.latestBlocker ?? effectiveResult.summary,
        evidence: {
          missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
        },
      });
      this.appendMissionEvent(mission, 'mission.retrying', cycleProgressSummary, updatedAttempt, {
        missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
        cycleResult,
      });
      this.saveCheckpointRecord(mission, updatedAttempt, 'verifier.repair', cycleProgressSummary, {
        verdict: effectiveResult.verdict,
        missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
      });
      await this.emitHostNotification(mission, updatedAttempt, cycleResult);
    } else {
      const cycleStatus = mapMissionStatusToMissionControlOutcome(mission.status) ?? 'failed';
      const cycleResult = this.buildMissionCycleResult({
        mission,
        attempt: updatedAttempt,
        checklistSnapshot: updatedChecklistSnapshot,
        status: cycleStatus,
        stage: `verifier.${effectiveResult.verdict}`,
        progress: cycleProgressSummary,
        nextStep: cycleStatus === 'done'
          ? (effectiveResult.nextStep ?? null)
          : cycleStatus === 'waiting_user'
            ? (effectiveResult.nextStep ?? 'Wait for user input before resuming the mission.')
            : cycleStatus === 'needs_human' || cycleStatus === 'handoff'
              ? (effectiveResult.nextStep ?? 'Wait for human intervention before resuming the mission.')
              : effectiveResult.nextStep ?? null,
        verifierSummary: effectiveResult.summary,
        blocker: cycleStatus === 'done' ? null : effectiveResult.latestBlocker ?? effectiveResult.summary,
        needUserAction: cycleStatus === 'waiting_user'
          ? effectiveResult.latestBlocker ?? effectiveResult.summary
          : null,
        evidence: {
          verdict: effectiveResult.verdict,
          missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
          budgetExceededReasons: [...effectiveResult.budgetExceededReasons],
        },
      });
      this.appendMissionEvent(
        mission,
        mapMissionTerminalStatusToEventKind(mission.status),
        cycleProgressSummary,
        updatedAttempt,
        {
          verdict: effectiveResult.verdict,
          missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
          budgetExceededReasons: [...effectiveResult.budgetExceededReasons],
          cycleResult,
        },
      );
      this.saveCheckpointRecord(mission, updatedAttempt, `verifier.${effectiveResult.verdict}`, cycleProgressSummary, {
        verdict: effectiveResult.verdict,
        missionStatus: mission.status,
        missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
        budgetExceededReasons: [...effectiveResult.budgetExceededReasons],
      });
      await this.emitHostNotification(mission, updatedAttempt, cycleResult);
    }

    return {
      mission,
      attempt: updatedAttempt,
      verifierResult: effectiveResult,
      continueMission: false,
    };
  }

  private resolveBudgetUsage(missionId: string, activeAttempt: MissionAttempt | null, now: number) {
    const mission = this.requireMission(missionId);
    const attempts = this.repository
      .listAttempts(missionId)
      .filter((attempt) => !mission.activeGenerationId
        || attempt.generationId === mission.activeGenerationId
        || attempt.generationId === null
        || attempt.generationId === undefined);
    const events = this.repository
      .listEvents(missionId)
      .filter((event) => !mission.activeGenerationId
        || event.generationId === mission.activeGenerationId
        || event.generationId === null
        || event.generationId === undefined);
    let runtimeMs = 0;
    for (const attempt of attempts) {
      if (attempt.startedAt === null) {
        continue;
      }
      const endedAt = attempt.endedAt ?? (activeAttempt?.id === attempt.id ? now : attempt.startedAt);
      runtimeMs += Math.max(0, endedAt - attempt.startedAt);
    }
    let turnCount = 0;
    let artifactCount = 0;
    let artifactBytes = 0;
    for (const event of events) {
      if (event.kind !== 'attempt.progress' && event.kind !== 'attempt.started') {
        continue;
      }
      if (event.metadata.providerTurn !== true) {
        continue;
      }
      if (event.kind === 'attempt.started') {
        turnCount += 1;
      }
      artifactCount += normalizeFiniteNumber(event.metadata.artifactCount);
      artifactBytes += normalizeFiniteNumber(event.metadata.artifactBytes);
    }

    return {
      attemptCount: attempts.length,
      turnCount,
      runtimeMs,
      artifactCount,
      artifactBytes,
    };
  }

  private restoreProviderResultFromAttempt(
    mission: Mission,
    attempt: MissionAttempt,
  ): MissionProviderResult {
    const text = normalizeText(attempt.outputPreview) ?? normalizeText(mission.lastResultPreview);
    return {
      outcome: 'completed',
      text,
      artifacts: [],
      previewText: text,
      errorMessage: attempt.error,
      requiresHuman: false,
      handoffState: null,
      continuationEligible: false,
      stopReason: null,
      rawState: 'complete',
    };
  }

  private finalizeRun(
    mission: Mission,
    ownerId: string,
    initialEventCount: number,
    result: Omit<MissionRunResult, 'mission' | 'turnsUsed' | 'latestCycleResult' | 'cycleResults'>,
  ): MissionRunResult {
    const released = this.releaseLeaseSafely(mission.id, ownerId);
    const cycleResults = listMissionCycleResults(
      this.repository.listEvents(mission.id).slice(initialEventCount),
    );
    return {
      mission: released,
      attempt: result.attempt,
      workflow: result.workflow,
      providerResult: result.providerResult,
      verifierResult: result.verifierResult,
      latestCycleResult: cycleResults.at(-1) ?? getLatestMissionCycleResult(this.repository.listEvents(mission.id)),
      cycleResults,
      turnsUsed: this.resolveBudgetUsage(mission.id, result.attempt, this.now()).turnCount,
    };
  }

  private releaseLeaseSafely(missionId: string, ownerId: string): Mission {
    const mission = this.requireMission(missionId);
    if (!mission.lease) {
      return mission;
    }
    if (mission.lease.ownerId !== ownerId && mission.lease.releasedAt === null && mission.lease.expiresAt > this.now()) {
      return mission;
    }
    return this.leaseCoordinator.releaseMission(mission.id, {
      ownerId,
      reason: mission.statusReason,
    });
  }

  private updateMissionFields(
    mission: Mission,
    updates: Partial<Pick<
      Mission,
      'workflowPath'
      | 'workflowHash'
      | 'workflowResolverReason'
      | 'workspacePath'
      | 'codexThreadId'
      | 'resultArtifacts'
      | 'activeAttemptId'
    >>,
  ): Mission {
    const next: Mission = {
      ...normalizeMissionRecord(mission),
      workflowPath: updates.workflowPath !== undefined ? updates.workflowPath : mission.workflowPath,
      workflowHash: updates.workflowHash !== undefined ? updates.workflowHash : mission.workflowHash,
      workflowResolverReason: updates.workflowResolverReason !== undefined
        ? updates.workflowResolverReason
        : mission.workflowResolverReason,
      workspacePath: updates.workspacePath !== undefined ? updates.workspacePath : mission.workspacePath,
      codexThreadId: updates.codexThreadId !== undefined ? updates.codexThreadId : mission.codexThreadId,
      resultArtifacts: updates.resultArtifacts !== undefined ? [...updates.resultArtifacts] : [...mission.resultArtifacts],
      activeAttemptId: updates.activeAttemptId !== undefined ? updates.activeAttemptId : mission.activeAttemptId,
      updatedAt: this.now(),
    };
    return this.saveMission(next);
  }

  private persistWorkflowTrace(
    mission: Mission,
    trace: {
      workflowPath: string | null;
      workflowHash: string | null;
      resolverReason: MissionWorkflowResolverReason | null;
    },
  ): Mission {
    const nextMission = this.updateMissionFields(mission, {
      workflowPath: trace.workflowPath,
      workflowHash: trace.workflowHash,
      workflowResolverReason: trace.resolverReason,
    });
    const existingGeneration = this.repository.getGenerationById(nextMission.activeGenerationId);
    if (existingGeneration) {
      this.repository.saveGeneration({
        ...existingGeneration,
        workflowPath: trace.workflowPath,
        workflowHash: trace.workflowHash,
        resolverReason: trace.resolverReason,
        updatedAt: this.now(),
      });
      return nextMission;
    }
    this.repository.saveGeneration(createMissionGeneration(nextMission, {
      at: this.now(),
      id: nextMission.activeGenerationId,
      index: nextMission.activeGenerationIndex,
      checklistSnapshotId: nextMission.currentChecklistSnapshotId,
      workflowPath: trace.workflowPath,
      workflowHash: trace.workflowHash,
      resolverReason: trace.resolverReason,
      trigger: nextMission.activeGenerationIndex === 1 ? 'initial' : 'retry',
    }));
    return nextMission;
  }

  private failMissionFromCurrentState(
    mission: Mission,
    summary: string,
    attempt: MissionAttempt | null,
    at: number,
  ): Mission {
    if (mission.status === 'failed') {
      return {
        ...mission,
        lastError: summary,
        statusReason: summary,
        updatedAt: at,
      };
    }
    if (mission.status === 'queued') {
      mission = transitionMission(mission, 'planning', {
        at,
        reason: summary,
        activeAttemptId: attempt?.id ?? mission.activeAttemptId,
      });
    }
    if (mission.status === 'planning'
      || mission.status === 'running'
      || mission.status === 'verifying'
      || mission.status === 'repairing'
      || mission.status === 'blocked') {
      return transitionMission(mission, 'failed', {
        at,
        reason: summary,
        activeAttemptId: attempt?.id ?? mission.activeAttemptId,
        lastError: summary,
        lastResultPreview: attempt?.outputPreview ?? mission.lastResultPreview,
      });
    }
    throw new Error(`mission ${mission.id} cannot fail from status ${mission.status}`);
  }

  private createAttempt(
    mission: Mission,
    index: number,
    status: MissionAttempt['status'],
    at: number,
  ): MissionAttempt {
    const normalizedMission = normalizeMissionRecord(mission);
    return {
      id: this.generateId(),
      missionId: normalizedMission.id,
      generationId: normalizedMission.activeGenerationId,
      generationIndex: normalizedMission.activeGenerationIndex,
      checklistSnapshotId: normalizedMission.currentChecklistSnapshotId,
      index,
      status,
      providerRunId: null,
      providerThreadId: normalizedMission.codexThreadId,
      workflowPath: normalizedMission.workflowPath,
      workflowHash: normalizedMission.workflowHash,
      resolverReason: normalizedMission.workflowResolverReason,
      promptDigest: null,
      verifierVerdict: null,
      verifierSummary: null,
      missingAcceptanceCriteria: [],
      outputPreview: null,
      error: null,
      startedAt: null,
      endedAt: null,
      createdAt: at,
      updatedAt: at,
    };
  }

  private requireMission(missionId: string): Mission {
    const mission = this.repository.getMissionById(missionId);
    if (!mission) {
      throw new Error(`unknown mission: ${missionId}`);
    }
    return normalizeMissionRecord(mission);
  }

  private requireAttempt(attemptId: string): MissionAttempt {
    const attempt = this.repository.getAttemptById(attemptId);
    if (!attempt) {
      throw new Error(`unknown attempt: ${attemptId}`);
    }
    return attempt;
  }

  private requireActiveAttempt(mission: Mission): MissionAttempt {
    if (!mission.activeAttemptId) {
      throw new Error(`mission ${mission.id} has no active attempt`);
    }
    return this.requireAttempt(mission.activeAttemptId);
  }

  private async materializeMaxLoopsReached(mission: Mission): Promise<Mission | null> {
    if (mission.status !== 'queued' && mission.status !== 'planning' && mission.status !== 'repairing') {
      return null;
    }
    const latestAttempt = mission.activeAttemptId
      ? this.repository.getAttemptById(mission.activeAttemptId)
      : this.repository
        .listAttempts(mission.id)
        .sort((left, right) => {
          const leftGeneration = left.generationIndex ?? 0;
          const rightGeneration = right.generationIndex ?? 0;
          if (leftGeneration !== rightGeneration) {
            return rightGeneration - leftGeneration;
          }
          if (left.index !== right.index) {
            return right.index - left.index;
          }
          return right.updatedAt - left.updatedAt;
        })[0] ?? null;
    const maxCycles = mission.loopPolicy.maxCycles;
    if (maxCycles !== null && mission.attemptCount >= maxCycles) {
      return this.materializeLoopBudgetExhausted(mission, latestAttempt, {
        stage: 'runtime.max_cycles',
        summary: `Mission loop budget exhausted: max cycles reached (${mission.attemptCount}/${maxCycles}).`,
        evidence: {
          maxCycles,
          attemptCount: mission.attemptCount,
        },
      });
    }

    const maxNoProgressCycles = mission.loopPolicy.maxNoProgressCycles;
    const noProgressCycles = maxNoProgressCycles === null
      ? 0
      : countConsecutiveNoProgressCycles(
        listMissionCycleResults(this.listActiveGenerationEvents(mission)),
      );
    if (maxNoProgressCycles !== null && noProgressCycles >= maxNoProgressCycles) {
      return this.materializeLoopBudgetExhausted(mission, latestAttempt, {
        stage: 'runtime.max_no_progress_cycles',
        summary: `Mission loop budget exhausted: max no-progress cycles reached (${noProgressCycles}/${maxNoProgressCycles}).`,
        evidence: {
          maxNoProgressCycles,
          noProgressCycles,
        },
      });
    }

    return null;
  }

  private async materializeLoopBudgetExhausted(
    mission: Mission,
    latestAttempt: MissionAttempt | null,
    input: {
      stage: string;
      summary: string;
      evidence: Record<string, unknown>;
    },
  ): Promise<Mission> {
    const at = this.now();
    const halted = transitionMission(mission, 'max_loops_reached', {
      at,
      reason: input.summary,
      lastError: input.summary,
      workpad: {
        ...mission.workpad,
        latestBlocker: input.summary,
        latestVerifierSummary: input.summary,
        updatedAt: at,
      },
    });
    const savedMission = this.saveMission(halted);
    const cycleResult = this.buildMissionCycleResult({
      mission: savedMission,
      attempt: latestAttempt,
      status: 'failed',
      stage: input.stage,
      progress: input.summary,
      nextStep: 'Retry the mission to open a new generation with a fresh cycle budget.',
      verifierSummary: input.summary,
      blocker: input.summary,
      evidence: input.evidence,
    });
    this.appendMissionEvent(savedMission, 'mission.max_loops_reached', input.summary, latestAttempt, {
      ...input.evidence,
      cycleResult,
    });
    this.saveCheckpointRecord(savedMission, latestAttempt, input.stage, input.summary, input.evidence);
    await this.emitHostNotification(savedMission, latestAttempt, cycleResult);
    return savedMission;
  }

  private listActiveGenerationEvents(mission: Mission): MissionEvent[] {
    return this.repository
      .listEvents(mission.id)
      .filter((event) => event.generationId === mission.activeGenerationId || event.generationId === null);
  }

  private saveMission(mission: Mission): Mission {
    const normalizedMission = normalizeMissionRecord(mission);
    const persistedMission = this.repository.getMissionById(normalizedMission.id);
    const mergedMission = persistedMission
      && persistedMission.workpad.updatedAt > normalizedMission.workpad.updatedAt
      ? {
        ...normalizedMission,
        workpad: persistedMission.workpad,
      }
      : normalizedMission;
    const savedMission = this.repository.saveMission(mergedMission);
    this.syncMissionDomainRecords(savedMission);
    return savedMission;
  }

  private buildMissionCycleResult(input: {
    mission: Mission;
    attempt: MissionAttempt | null;
    checklistSnapshot?: ChecklistSnapshot | null;
    status: MissionCycleResult['status'];
    stage: string;
    progress: string;
    nextStep?: string | null;
    verifierSummary?: string | null;
    blocker?: string | null;
    needUserAction?: string | null;
    planChangeSuggestion?: Record<string, unknown> | null;
    evidence?: Record<string, unknown>;
  }): MissionCycleResult {
    const checklistSnapshot = input.checklistSnapshot !== undefined
      ? input.checklistSnapshot
      : this.repository.getChecklistSnapshotById(input.mission.currentChecklistSnapshotId);
    const existingEvents = this.repository.listEvents(input.mission.id);
    return createMissionCycleResult({
      mission: input.mission,
      attempt: input.attempt,
      checklistSnapshot,
      cycle: listMissionCycleResults(existingEvents).length + 1,
      status: input.status,
      stage: input.stage,
      progress: input.progress,
      nextStep: input.nextStep,
      verifierSummary: input.verifierSummary,
      blocker: input.blocker,
      needUserAction: input.needUserAction,
      planChangeSuggestion: input.planChangeSuggestion,
      evidence: input.evidence,
      eventSeq: existingEvents.length + 1,
      updatedAt: this.now(),
    });
  }

  private buildRuntimeCommandMeta(
    missionId: string,
    action: string,
  ) {
    return {
      requestId: this.generateId(),
      correlationId: `runtime:${missionId}:${action}`,
      idempotencyKey: `${missionId}:${action}`,
    };
  }

  private saveEnvironmentStamp(
    mission: Mission,
    attempt: MissionAttempt,
    workspace: MissionWorkspaceAssignment,
  ): MissionEnvironmentStamp {
    const capturedAt = this.now();
    const git = resolveMissionGitMetadata(workspace.workspacePath, mission.cwd);
    return this.repository.saveEnvironmentStamp({
      id: buildMissionEnvironmentStampId(mission.id, attempt.id),
      missionId: mission.id,
      generationId: attempt.generationId ?? mission.activeGenerationId,
      generationIndex: attempt.generationIndex ?? mission.activeGenerationIndex,
      attemptId: attempt.id,
      cycle: attempt.index,
      cwd: mission.cwd,
      workspacePath: workspace.workspacePath,
      gitSha: git.gitSha,
      gitBranch: git.gitBranch,
      workflowHash: mission.workflowHash,
      providerProfileId: mission.providerProfileId,
      capturedAt,
    });
  }

  private saveCheckpointRecord(
    mission: Mission,
    attempt: MissionAttempt | null,
    stage: string,
    summary: string,
    payload: Record<string, unknown>,
  ): MissionCheckpoint {
    const createdAt = this.now();
    const generationId = attempt?.generationId ?? mission.activeGenerationId;
    const generationIndex = attempt?.generationIndex ?? mission.activeGenerationIndex;
    const cycle = attempt?.index ?? Math.max(1, mission.attemptCount);
    return this.repository.saveCheckpoint({
      id: buildMissionCheckpointId(mission.id, this.repository.listCheckpoints(mission.id).length + 1),
      missionId: mission.id,
      attemptId: attempt?.id ?? null,
      generationId,
      generationIndex,
      cycle,
      stage,
      summary,
      payload: {
        ...payload,
        missionStatus: mission.status,
        statusReason: mission.statusReason,
        checklistSnapshotId: mission.currentChecklistSnapshotId,
        checklistSnapshotVersion: mission.currentChecklistSnapshotVersion,
        workflowPath: mission.workflowPath,
        workflowHash: mission.workflowHash,
        resolverReason: mission.workflowResolverReason,
      },
      createdAt,
    });
  }

  private appendMissionEvent(
    mission: Mission,
    kind: MissionEvent['kind'],
    summary: string,
    attempt: MissionAttempt | null,
    metadata: Record<string, unknown>,
  ): MissionEvent {
    const normalizedMission = normalizeMissionRecord(mission);
    return this.repository.appendEvent({
      id: this.generateId(),
      missionId: normalizedMission.id,
      attemptId: attempt?.id ?? null,
      generationId: attempt?.generationId ?? normalizedMission.activeGenerationId,
      generationIndex: attempt?.generationIndex ?? normalizedMission.activeGenerationIndex,
      kind,
      summary,
      detail: null,
      metadata: { ...metadata },
      createdAt: this.now(),
    });
  }

  private appendAttemptEvent(
    mission: Mission,
    attempt: MissionAttempt,
    kind: MissionEvent['kind'],
    summary: string,
    metadata: Record<string, unknown>,
  ): MissionEvent {
    return this.appendMissionEvent(mission, kind, summary, attempt, metadata);
  }

  private ensureMissionDomainRecords(mission: Mission): Mission {
    const normalizedMission = normalizeMissionRecord(mission);
    const persistedMission = this.repository.saveMission(normalizedMission);
    if (!this.repository.getWorkItemById(persistedMission.workItemId)) {
      this.repository.saveWorkItem(createMissionWorkItem(persistedMission, {
        at: persistedMission.updatedAt,
      }));
    }
    if (!this.repository.getChecklistSnapshotById(persistedMission.currentChecklistSnapshotId)) {
      this.repository.saveChecklistSnapshot(createMissionChecklistSnapshot(persistedMission, {
        at: persistedMission.updatedAt,
      }));
    }
    if (!this.repository.getGenerationById(persistedMission.activeGenerationId)) {
      this.repository.saveGeneration(createMissionGeneration(persistedMission, {
        at: persistedMission.updatedAt,
        trigger: persistedMission.activeGenerationIndex === 1 ? 'initial' : 'retry',
      }));
    } else {
      this.syncMissionDomainRecords(persistedMission);
    }
    return persistedMission;
  }

  private async consumePersistedStopRequest(
    missionId: string,
    ownerId: string,
    options: {
      interruptProvider: boolean;
    },
  ): Promise<{
    mission: Mission;
    attempt: MissionAttempt | null;
    stopped: boolean;
  }> {
    const mission = this.requireMission(missionId);
    if (!mission.stopRequest) {
      const attempt = mission.activeAttemptId ? this.repository.getAttemptById(mission.activeAttemptId) : null;
      return {
        mission,
        attempt,
        stopped: false,
      };
    }
    const reason = resolveMissionStopReason(mission);
    let attempt = mission.activeAttemptId
      ? this.repository.getAttemptById(mission.activeAttemptId)
      : findLatestStoppableAttempt(this.repository, mission.id);
    if (options.interruptProvider && attempt?.providerRunId) {
      await this.provider.interrupt(attempt.providerRunId);
    }
    if (attempt && !isTerminalAttemptStatus(attempt.status)) {
      attempt = this.repository.saveAttempt({
        ...attempt,
        status: 'stopped',
        error: reason,
        endedAt: attempt.endedAt ?? this.now(),
        updatedAt: this.now(),
      });
      this.appendAttemptEvent(mission, attempt, 'attempt.stopped', reason, {
        providerRunId: attempt.providerRunId,
        stopRequestId: mission.stopRequest.requestId,
        actorId: mission.stopRequest.actorId,
        actorType: mission.stopRequest.actorType,
      });
    }
    let stoppedMission = materializeMissionStop(mission, {
      at: this.now(),
      reason,
      lastError: reason,
      activeAttemptId: attempt?.id ?? mission.activeAttemptId,
    });
    stoppedMission = this.saveMission(stoppedMission);
    this.appendMissionEvent(stoppedMission, 'mission.stopped', reason, attempt, {
      stopRequestId: mission.stopRequest.requestId,
      actorId: mission.stopRequest.actorId,
      actorType: mission.stopRequest.actorType,
    });
    this.saveCheckpointRecord(stoppedMission, attempt, 'control.stop_consumed', reason, {
      stopRequestId: mission.stopRequest.requestId,
      actorId: mission.stopRequest.actorId,
      actorType: mission.stopRequest.actorType,
      interruptedProvider: options.interruptProvider,
    });
    stoppedMission = this.releaseLeaseSafely(stoppedMission.id, ownerId);
    return {
      mission: stoppedMission,
      attempt,
      stopped: true,
    };
  }

  private syncMissionDomainRecords(mission: Mission): void {
    const normalizedMission = normalizeMissionRecord(mission);
    const existingWorkItem = this.repository.getWorkItemById(normalizedMission.workItemId);
    const nextWorkItem = createMissionWorkItem(normalizedMission, {
      at: normalizedMission.updatedAt,
      sourceRevision: existingWorkItem?.sourceRevision ?? null,
      metadata: existingWorkItem?.metadata ?? null,
    });
    if (!existingWorkItem || JSON.stringify(existingWorkItem) !== JSON.stringify(nextWorkItem)) {
      this.repository.saveWorkItem(nextWorkItem);
    }

    const existingGeneration = this.repository.getGenerationById(normalizedMission.activeGenerationId);
    const nextGeneration = createMissionGeneration(normalizedMission, {
      at: normalizedMission.updatedAt,
      id: normalizedMission.activeGenerationId,
      index: normalizedMission.activeGenerationIndex,
      checklistSnapshotId: normalizedMission.currentChecklistSnapshotId,
      trigger: normalizedMission.activeGenerationIndex === 1 ? 'initial' : 'retry',
    });
    if (!existingGeneration || JSON.stringify(existingGeneration) !== JSON.stringify(nextGeneration)) {
      this.repository.saveGeneration(nextGeneration);
    }
  }

  private async emitHostNotification(
    mission: Mission,
    attempt: MissionAttempt | null,
    cycleResult: MissionCycleResult | null,
  ): Promise<void> {
    if (!this.hostAdapter) {
      return;
    }
    try {
      const loopSnapshot = this.readApi.queries.getMissionLoopSnapshot({
        meta: {
          requestId: `mission-host-notify:${mission.id}:${cycleResult?.audit.eventSeq ?? 'current'}`,
          correlationId: null,
          idempotencyKey: null,
        },
        input: {
          missionId: mission.id,
        },
      }).data;
      if (!loopSnapshot) {
        return;
      }
      await this.hostAdapter.notify({
        missionId: mission.id,
        attemptId: attempt?.id ?? null,
        status: mission.status,
        kind: 'cycle_update',
        notificationKey: cycleResult
          ? `${mission.id}:cycle:${cycleResult.audit.eventSeq}`
          : `${mission.id}:status:${loopSnapshot.updatedAt}`,
        summary: cycleResult?.progress ?? mission.statusReason ?? 'Mission loop updated.',
        loopSnapshot,
        cycleResult,
        details: {
          workflowPath: mission.workflowPath,
          workflowHash: mission.workflowHash,
          resolverReason: mission.workflowResolverReason,
        },
      });
    } catch {
      // Host notification delivery is best-effort and must not mutate runtime truth.
    }
  }
}

function buildContinuationPrompt(input: {
  mission: Mission;
  attempt: MissionAttempt;
  checklistSnapshot: ChecklistSnapshot | null;
  workflow: LoadedMissionWorkflow;
  providerResult: MissionProviderResult;
  turnIndex: number;
}): string {
  const basePrompt = renderMissionAttemptPromptContract(createMissionAttemptPromptContract({
    mission: input.mission,
    attempt: input.attempt,
    workflow: input.workflow,
    checklistSnapshot: input.checklistSnapshot,
  }));
  const lines = [
    basePrompt,
    '',
    'Continuation contract',
    `Previous provider outcome: ${input.providerResult.outcome}`,
    `Completed provider turns in this attempt: ${input.turnIndex}`,
  ];
  if (input.providerResult.previewText) {
    lines.push(`Previous preview: ${input.providerResult.previewText}`);
  }
  if (input.providerResult.text) {
    lines.push(`Previous output: ${input.providerResult.text}`);
  }
  lines.push('Continue the same attempt without resetting context or claiming completion prematurely.');
  return lines.join('\n').trim();
}

function mapMissionTerminalStatusToEventKind(status: Mission['status']): MissionEvent['kind'] {
  switch (status) {
    case 'waiting_user':
      return 'mission.waiting_user';
    case 'needs_human':
      return 'mission.needs_human';
    case 'scope_change_pending':
      return 'mission.scope_change_pending';
    case 'handoff':
      return 'mission.handoff';
    case 'blocked':
      return 'mission.blocked';
    case 'max_loops_reached':
      return 'mission.max_loops_reached';
    case 'completed':
      return 'mission.completed';
    case 'failed':
      return 'mission.failed';
    case 'stopped':
      return 'mission.stopped';
    default:
      return 'mission.progress';
  }
}

function buildMissionEnvironmentStampId(missionId: string, attemptId: string): string {
  return `${missionId}:env:${attemptId}`;
}

function buildMissionCheckpointId(missionId: string, ordinal: number): string {
  return `${missionId}:checkpoint:${Math.max(1, Math.trunc(ordinal))}`;
}

function resolveMissionGitMetadata(
  workspacePath: string | null,
  cwd: string | null,
): {
  gitSha: string | null;
  gitBranch: string | null;
} {
  const candidates = [normalizeText(workspacePath), normalizeText(cwd)].filter(
    (value): value is string => value !== null,
  );
  for (const candidate of candidates) {
    const gitSha = runGitMetadataCommand(candidate, ['rev-parse', 'HEAD']);
    if (!gitSha) {
      continue;
    }
    const gitBranch = runGitMetadataCommand(candidate, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return {
      gitSha,
      gitBranch,
    };
  }
  return {
    gitSha: null,
    gitBranch: null,
  };
}

function runGitMetadataCommand(cwd: string, args: string[]): string | null {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) {
      return null;
    }
    return normalizeText(result.stdout);
  } catch {
    return null;
  }
}

function computeArtifactBytes(artifacts: readonly MissionProviderArtifact[]): number {
  let total = 0;
  for (const artifact of artifacts) {
    const filePath = normalizeText(artifact.path);
    if (!filePath) {
      continue;
    }
    try {
      total += fs.statSync(filePath).size;
    } catch {
      continue;
    }
  }
  return total;
}

function countConsecutiveNoProgressCycles(
  cycleResults: readonly MissionCycleResult[],
): number {
  let streak = 0;
  for (let index = cycleResults.length - 1; index >= 0; index -= 1) {
    const current = cycleResults[index];
    if (!current || (current.status !== 'retry' && current.status !== 'continue')) {
      break;
    }
    const previous = index > 0 ? cycleResults[index - 1] ?? null : null;
    if (didMissionCycleAdvanceProgress(previous, current)) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function didMissionCycleAdvanceProgress(
  previous: MissionCycleResult | null,
  current: MissionCycleResult,
): boolean {
  const currentOverallCompletion = typeof current.overallCompletion === 'number'
    ? current.overallCompletion
    : 0;
  const previousOverallCompletion = typeof previous?.overallCompletion === 'number'
    ? previous.overallCompletion
    : 0;
  if (currentOverallCompletion > previousOverallCompletion) {
    return true;
  }
  const completedItemIdValue = asRecord(current.evidence)?.completedItemId;
  const completedItemId = typeof completedItemIdValue === 'string'
    ? normalizeText(completedItemIdValue)
    : null;
  if (completedItemId) {
    return true;
  }
  const currentMissingCount = getMissingAcceptanceCriteriaCount(current);
  const previousMissingCount = previous ? getMissingAcceptanceCriteriaCount(previous) : null;
  return currentMissingCount !== null
    && previousMissingCount !== null
    && currentMissingCount < previousMissingCount;
}

function getMissingAcceptanceCriteriaCount(result: MissionCycleResult): number | null {
  const evidence = asRecord(result.evidence);
  if (!evidence || !Array.isArray(evidence.missingAcceptanceCriteria)) {
    return null;
  }
  return evidence.missingAcceptanceCriteria.filter((value) => typeof value === 'string').length;
}

function buildRuntimePlanChangeSuggestionRecord(
  suggestion: ResolvedMissionPlanChangeSuggestion,
  planChangeRequestId: string | null,
): Record<string, unknown> {
  return {
    rationale: suggestion.rationale,
    proposedExpectedOutput: suggestion.proposedExpectedOutput,
    proposedAcceptanceCriteria: [...suggestion.proposedAcceptanceCriteria],
    proposedPlan: [...suggestion.proposedPlan],
    planChangeRequestId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeFiniteNumber(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function digestPrompt(promptText: string): string {
  return crypto.createHash('sha256').update(promptText).digest('hex');
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isTerminalAttemptStatus(status: MissionAttempt['status']): boolean {
  return (
    status === 'completed'
    || status === 'failed'
    || status === 'stopped'
    || status === 'waiting_user'
    || status === 'needs_human'
    || status === 'handoff'
    || status === 'blocked'
  );
}

function findLatestStoppableAttempt(
  repository: MissionRepository,
  missionId: string,
): MissionAttempt | null {
  const attempts = repository.listAttempts(missionId)
    .filter((attempt) => !isTerminalAttemptStatus(attempt.status))
    .sort((left, right) => {
      const leftGeneration = left.generationIndex ?? 0;
      const rightGeneration = right.generationIndex ?? 0;
      if (leftGeneration !== rightGeneration) {
        return rightGeneration - leftGeneration;
      }
      if (left.index !== right.index) {
        return right.index - left.index;
      }
      return right.updatedAt - left.updatedAt;
    });
  return attempts[0] ?? null;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
