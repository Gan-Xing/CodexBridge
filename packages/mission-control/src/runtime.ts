import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  applyMissionProviderStartToAttempt,
  type MissionProvider,
  type MissionProviderArtifact,
  type MissionProviderResult,
} from './provider.js';
import { type MissionRepository } from './repository.js';
import { transitionMission } from './state_machine.js';
import type { Mission, MissionAttempt, MissionEvent } from './types.js';
import {
  applyMissionVerifierResultToAttempt,
  applyMissionVerifierResultToMission,
  createMissionRepairPrompt,
  createMissionVerifierResult,
  evaluateMissionVerifierBudget,
  resolveMissionVerifierBudget,
  type MissionVerifier,
  type MissionVerifierResult,
} from './verifier.js';
import { MissionWorkflowLoader, type LoadedMissionWorkflow } from './workflow.js';
import { MissionLeaseCoordinator } from './lease_coordinator.js';
import { MissionWorkspaceService, type MissionWorkspaceAssignment } from './workspace.js';
import {
  createMissionAttemptPromptContract,
  renderMissionAttemptPromptContract,
} from './prompt_contract.js';

export interface MissionRuntimeOptions {
  repository: MissionRepository;
  provider: MissionProvider;
  verifier: MissionVerifier;
  workflowLoader?: MissionWorkflowLoader;
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
  turnsUsed: number;
}

export class MissionRuntime {
  private readonly repository: MissionRepository;

  private readonly provider: MissionProvider;

  private readonly verifier: MissionVerifier;

  private readonly workflowLoader: MissionWorkflowLoader;

  private readonly workspaceService: MissionWorkspaceService;

  private readonly leaseCoordinator: MissionLeaseCoordinator;

  private readonly now: () => number;

  private readonly generateId: () => string;

  constructor({
    repository,
    provider,
    verifier,
    workflowLoader = new MissionWorkflowLoader(),
    workspaceService = new MissionWorkspaceService(),
    leaseCoordinator = new MissionLeaseCoordinator(repository),
    now = () => Date.now(),
    generateId = () => crypto.randomUUID(),
  }: MissionRuntimeOptions) {
    this.repository = repository;
    this.provider = provider;
    this.verifier = verifier;
    this.workflowLoader = workflowLoader;
    this.workspaceService = workspaceService;
    this.leaseCoordinator = leaseCoordinator;
    this.now = now;
    this.generateId = generateId;
  }

  async runMission(
    missionId: string,
    options: MissionRunOptions,
  ): Promise<MissionRunResult> {
    let mission = this.requireMission(missionId);
    mission = this.leaseCoordinator.claimMission(mission.id, {
      ownerId: options.ownerId,
    });

    let workflow: LoadedMissionWorkflow | null = null;
    let lastAttempt: MissionAttempt | null = null;
    let lastProviderResult: MissionProviderResult | null = null;
    let lastVerifierResult: MissionVerifierResult | null = null;

    try {
      const workflowResult = this.workflowLoader.tryLoad({
        explicitPath: mission.workflowPath ?? undefined,
        cwd: mission.cwd,
        workspacePath: mission.workspacePath,
      });
      if (!workflowResult.workflow) {
        const summary = workflowResult.error.message;
        mission = this.failMissionFromCurrentState(mission, summary, null, this.now());
        this.saveMission(mission);
        this.appendMissionEvent(mission, 'mission.failed', summary, null, {
          workflowPath: workflowResult.error.workflowPath,
          issues: [...workflowResult.error.issues],
        });
        return this.finalizeRun(mission, options.ownerId, {
          attempt: null,
          workflow: null,
          providerResult: null,
          verifierResult: null,
        });
      }
      workflow = workflowResult.workflow;
      mission = this.updateMissionFields(mission, {
        workflowPath: workflow.source.path,
      });

      const workspace = this.workspaceService.ensureWorkspace(mission, {
        readOnly: options.readOnly,
        allowSharedCwd: options.allowSharedCwd,
      });
      mission = this.updateMissionFields(mission, {
        workspacePath: workspace.workspacePath,
        workflowPath: workflow.source.path,
      });

      for (;;) {
        mission = this.requireMission(mission.id);
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
          });
          mission = verification.mission;
          lastAttempt = verification.attempt;
          lastProviderResult = providerResult;
          lastVerifierResult = verification.verifierResult;
          if (mission.status === 'repairing') {
            continue;
          }
          return this.finalizeRun(mission, options.ownerId, {
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

        const providerRun = await this.runProviderUntilCandidateOrTerminal({
          mission,
          attempt: execution.attempt,
          workflow,
          workspace,
          promptText: execution.promptText,
          waitTimeoutMs: options.waitTimeoutMs,
        });
        mission = providerRun.mission;
        lastAttempt = providerRun.attempt;
        lastProviderResult = providerRun.providerResult;
        if (providerRun.providerResult === null || mission.status !== 'verifying') {
          return this.finalizeRun(mission, options.ownerId, {
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
      this.appendMissionEvent(mission, 'mission.failed', summary, lastAttempt, {
        error: summary,
      });
      return this.finalizeRun(mission, options.ownerId, {
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
    const attempt = mission.activeAttemptId ? this.repository.getAttemptById(mission.activeAttemptId) : null;
    const reason = normalizeText(options.reason) ?? 'Mission stopped.';
    if (attempt?.providerRunId) {
      await this.provider.interrupt(attempt.providerRunId);
    }
    if (attempt) {
      this.repository.saveAttempt({
        ...attempt,
        status: 'stopped',
        error: reason,
        endedAt: this.now(),
        updatedAt: this.now(),
      });
      this.appendAttemptEvent(mission, attempt, 'attempt.stopped', reason, {
        providerRunId: attempt.providerRunId,
      });
    }
    const next = transitionMission(mission, 'stopped', {
      at: this.now(),
      reason,
      lastError: reason,
      activeAttemptId: attempt?.id ?? mission.activeAttemptId,
    });
    this.saveMission(next);
    this.appendMissionEvent(next, 'mission.stopped', reason, attempt, {
      ownerId: options.ownerId,
    });
    return this.leaseCoordinator.releaseMission(next.id, {
      ownerId: options.ownerId,
      reason,
    });
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
      });
    }

    if (mission.status === 'repairing') {
      const previousAttempt = this.requireActiveAttempt(mission);
      const nextAttempt = this.createAttempt(mission, mission.attemptCount + 1, 'running', at);
      const promptText = createMissionRepairPrompt({
        mission,
        attempt: previousAttempt,
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
        this.appendMissionEvent(mission, 'mission.failed', failedResult.summary, failedAttempt, {
          budgetExceededReasons: [...turnIssues],
        });
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

      if ((providerResult.outcome === 'partial' || providerResult.outcome === 'missing')
        && input.workflow.policy.continuation === 'allow') {
        promptText = buildContinuationPrompt({
          mission,
          attempt,
          workflow: input.workflow,
          providerResult,
          turnIndex,
        });
        attempt = this.repository.saveAttempt({
          ...attempt,
          promptDigest: digestPrompt(promptText),
          updatedAt: this.now(),
        });
        this.appendMissionEvent(mission, 'mission.progress', 'Mission scheduled a continuation turn.', attempt, {
          turnIndex,
          outcome: providerResult.outcome,
        });
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
        this.appendMissionEvent(
          mission,
          mapMissionTerminalStatusToEventKind(nextStatus),
          providerResult.stopReason ?? providerResult.previewText ?? providerResult.text ?? 'Mission blocked.',
          endedAttempt,
          {
            providerRunId: endedAttempt.providerRunId,
            handoffState: providerResult.handoffState,
          },
        );
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
        this.appendMissionEvent(mission, 'mission.stopped', providerResult.stopReason ?? 'Mission stopped.', endedAttempt, {
          providerRunId: endedAttempt.providerRunId,
        });
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
        this.appendMissionEvent(mission, 'mission.failed', summary, endedAttempt, {
          providerRunId: endedAttempt.providerRunId,
          outcome: providerResult.outcome,
        });
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
  }): Promise<{
    mission: Mission;
    attempt: MissionAttempt;
    verifierResult: MissionVerifierResult;
  }> {
    const usage = this.resolveBudgetUsage(input.mission.id, input.attempt, this.now());
    const verifierResult = await this.verifier.verify({
      mission: input.mission,
      attempt: input.attempt,
      workflow: input.workflow,
      providerResult: input.providerResult,
      attemptCount: usage.attemptCount,
      turnCount: usage.turnCount,
      runtimeMs: usage.runtimeMs,
      artifactBytes: usage.artifactBytes,
    });
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

    const updatedAttempt = this.repository.saveAttempt(applyMissionVerifierResultToAttempt(
      input.attempt,
      effectiveResult,
      this.now(),
    ));
    let mission = applyMissionVerifierResultToMission(input.mission, effectiveResult, {
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
      this.appendMissionEvent(mission, 'mission.retrying', effectiveResult.summary, updatedAttempt, {
        missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
      });
    } else {
      this.appendMissionEvent(
        mission,
        mapMissionTerminalStatusToEventKind(mission.status),
        effectiveResult.summary,
        updatedAttempt,
        {
          verdict: effectiveResult.verdict,
          missingAcceptanceCriteria: [...effectiveResult.missingAcceptanceCriteria],
          budgetExceededReasons: [...effectiveResult.budgetExceededReasons],
        },
      );
    }

    return {
      mission,
      attempt: updatedAttempt,
      verifierResult: effectiveResult,
    };
  }

  private resolveBudgetUsage(missionId: string, activeAttempt: MissionAttempt | null, now: number) {
    const attempts = this.repository.listAttempts(missionId);
    const events = this.repository.listEvents(missionId);
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
    result: Omit<MissionRunResult, 'mission' | 'turnsUsed'>,
  ): MissionRunResult {
    const released = this.releaseLeaseSafely(mission.id, ownerId);
    return {
      mission: released,
      attempt: result.attempt,
      workflow: result.workflow,
      providerResult: result.providerResult,
      verifierResult: result.verifierResult,
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
    updates: Partial<Pick<Mission, 'workflowPath' | 'workspacePath' | 'codexThreadId' | 'resultArtifacts' | 'activeAttemptId'>>,
  ): Mission {
    const next: Mission = {
      ...mission,
      workflowPath: updates.workflowPath !== undefined ? updates.workflowPath : mission.workflowPath,
      workspacePath: updates.workspacePath !== undefined ? updates.workspacePath : mission.workspacePath,
      codexThreadId: updates.codexThreadId !== undefined ? updates.codexThreadId : mission.codexThreadId,
      resultArtifacts: updates.resultArtifacts !== undefined ? [...updates.resultArtifacts] : [...mission.resultArtifacts],
      activeAttemptId: updates.activeAttemptId !== undefined ? updates.activeAttemptId : mission.activeAttemptId,
      updatedAt: this.now(),
    };
    return this.saveMission(next);
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
    return {
      id: this.generateId(),
      missionId: mission.id,
      index,
      status,
      providerRunId: null,
      providerThreadId: mission.codexThreadId,
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
    return mission;
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

  private saveMission(mission: Mission): Mission {
    return this.repository.saveMission(mission);
  }

  private appendMissionEvent(
    mission: Mission,
    kind: MissionEvent['kind'],
    summary: string,
    attempt: MissionAttempt | null,
    metadata: Record<string, unknown>,
  ): MissionEvent {
    return this.repository.appendEvent({
      id: this.generateId(),
      missionId: mission.id,
      attemptId: attempt?.id ?? null,
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
}

function buildContinuationPrompt(input: {
  mission: Mission;
  attempt: MissionAttempt;
  workflow: LoadedMissionWorkflow;
  providerResult: MissionProviderResult;
  turnIndex: number;
}): string {
  const basePrompt = renderMissionAttemptPromptContract(createMissionAttemptPromptContract({
    mission: input.mission,
    attempt: input.attempt,
    workflow: input.workflow,
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
    case 'handoff':
      return 'mission.handoff';
    case 'blocked':
      return 'mission.blocked';
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

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
