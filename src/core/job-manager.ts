import { createHash, randomUUID } from "node:crypto";

import type { WorkerConfig } from "../config/worker-config.js";
import type {
  JobActivity,
  JobProgress,
  JobResult,
  ProposalArtifact,
  PublicJobSnapshot,
  ResolvedJobRequest,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeResult,
  StartJobInput,
  UsageSummary,
  WorkerFailure,
  WorkerRuntime,
} from "./types.js";
import { REASONING_EFFORTS, RUN_MODES } from "./types.js";
import { ERROR_CODES, WorkerError, toWorkerError } from "./errors.js";
import type { LeaseHandle, LeaseManager } from "./lease-manager.js";
import { resolveWorkingSet } from "../security/path-policy.js";
import { normalizePublicRuntimeFailure } from "../security/redaction-policy.js";
import type {
  PreparedProposal,
  ProposalWorkspace,
} from "../runtime/proposal-workspace.js";
import type {
  PreparedReviewWorkspace,
  ReviewWorkspace,
} from "../runtime/review-workspace.js";
import {
  validateSddReviewInput,
  type SddReviewArtifact,
  type SddReviewService,
  type StartSddReviewInput,
} from "../sdd/review-job.js";

interface InternalJob {
  readonly id: string;
  readonly fingerprint: string;
  readonly request: ResolvedJobRequest;
  readonly createdAt: string;
  status: PublicJobSnapshot["status"];
  revision: number;
  progress: JobProgress;
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  usage?: UsageSummary;
  finalMessage?: string;
  proposal?: ProposalArtifact;
  review?: SddReviewArtifact;
  resultTruncated: boolean;
  failure?: WorkerFailure;
  cancellationRequested: boolean;
  readonly waiters: Set<() => void>;
}

export interface ListJobsInput {
  readonly status?: PublicJobSnapshot["status"];
  readonly limit?: number;
}

export class JobManager {
  readonly #config: WorkerConfig;
  readonly #runtime: WorkerRuntime;
  readonly #proposalWorkspace: ProposalWorkspace;
  readonly #reviewWorkspace: ReviewWorkspace;
  readonly #leases: LeaseManager;
  readonly #reviews: SddReviewService;
  readonly #jobs = new Map<string, InternalJob>();
  readonly #idempotency = new Map<string, string>();
  readonly #queue: string[] = [];
  readonly #handles = new Map<string, RuntimeHandle>();
  readonly #executions = new Map<string, Promise<void>>();
  #activeCount = 0;
  #pumpRunning = false;
  #shuttingDown = false;
  #shutdownPromise?: Promise<void>;

  public constructor(dependencies: {
    readonly config: WorkerConfig;
    readonly runtime: WorkerRuntime;
    readonly proposalWorkspace: ProposalWorkspace;
    readonly reviewWorkspace: ReviewWorkspace;
    readonly leases: LeaseManager;
    readonly reviews: SddReviewService;
  }) {
    this.#config = dependencies.config;
    this.#runtime = dependencies.runtime;
    this.#proposalWorkspace = dependencies.proposalWorkspace;
    this.#reviewWorkspace = dependencies.reviewWorkspace;
    this.#leases = dependencies.leases;
    this.#reviews = dependencies.reviews;
  }

  public async initialize(): Promise<void> {
    await Promise.all([
      this.#proposalWorkspace.initialize(),
      this.#reviewWorkspace.initialize(),
      this.#leases.initialize(),
    ]);
  }

  public async submit(input: StartJobInput): Promise<PublicJobSnapshot>;
  public async submit(input: unknown): Promise<PublicJobSnapshot> {
    this.#assertAcceptingJobs();
    assertStartJobInput(input);
    const request = await this.#resolveRequest(input);
    this.#assertAcceptingJobs();
    return this.#enqueue(request);
  }

  public async submitReview(
    input: StartSddReviewInput,
  ): Promise<PublicJobSnapshot>;
  public async submitReview(input: unknown): Promise<PublicJobSnapshot> {
    this.#assertAcceptingJobs();
    const validated = validateSddReviewInput(input, this.#config);
    const baseRequest = await this.#resolveRequest({
      task: "Prepare an independent structured SDD review",
      mode: "analyze",
      ...(validated.cwd === undefined ? {} : { cwd: validated.cwd }),
      ...(validated.model === undefined ? {} : { model: validated.model }),
      ...(validated.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: validated.reasoningEffort }),
      ...(validated.timeoutMs === undefined
        ? {}
        : { timeoutMs: validated.timeoutMs }),
      ...(validated.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: validated.idempotencyKey }),
    });
    this.#assertAcceptingJobs();
    const review = await this.#reviews.prepare(
      validated,
      baseRequest.repositoryRoot,
    );
    this.#assertAcceptingJobs();
    const request: ResolvedJobRequest = {
      ...baseRequest,
      task: review.task,
      taskHash: createHash("sha256").update(review.task).digest("hex"),
      ...(review.seal.revision === null
        ? {}
        : { expectedRevision: review.seal.revision }),
      sddReview: review,
    };
    return this.#enqueue(request);
  }

  #enqueue(request: ResolvedJobRequest): PublicJobSnapshot {
    this.#assertAcceptingJobs();
    const fingerprint = requestFingerprint(request);

    if (request.idempotencyKey !== undefined) {
      const existingId = this.#idempotency.get(request.idempotencyKey);
      if (existingId !== undefined) {
        const existing = this.#jobs.get(existingId);
        if (existing?.fingerprint === fingerprint) {
          return this.#snapshot(existing);
        }
        throw new WorkerError(
          ERROR_CODES.DUPLICATE_IDEMPOTENCY_KEY,
          "The idempotency key is already bound to a different request",
        );
      }
    }

    if (this.#queue.length >= this.#config.maxQueued) {
      throw new WorkerError(ERROR_CODES.QUEUE_FULL, "The worker queue is full");
    }

    const now = new Date().toISOString();
    const job: InternalJob = {
      id: randomUUID(),
      fingerprint,
      request,
      createdAt: now,
      status: "queued",
      revision: 1,
      progress: {
        phase: "queued",
        activity: "queued",
        activityLabel: activityLabel("queued"),
        eventCount: 0,
        commandCount: 0,
        messageCount: 0,
        updatedAt: now,
        elapsedMs: 0,
        sinceLastUpdateMs: 0,
      },
      resultTruncated: false,
      cancellationRequested: false,
      waiters: new Set(),
    };
    this.#jobs.set(job.id, job);
    if (request.idempotencyKey !== undefined) {
      this.#idempotency.set(request.idempotencyKey, job.id);
    }
    this.#queue.push(job.id);
    this.#schedulePump();
    this.#evictHistory();
    return this.#snapshot(job);
  }

  public async status(
    id: string,
    waitMs = 0,
    afterRevision?: number,
  ): Promise<PublicJobSnapshot> {
    const job = this.#requireJob(id);
    if (
      afterRevision !== undefined &&
      (!Number.isInteger(afterRevision) ||
        afterRevision < 1 ||
        afterRevision > job.revision)
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "afterRevision must be a previously observed job revision",
      );
    }
    const shouldWait =
      waitMs > 0 &&
      !isTerminal(job.status) &&
      (afterRevision === undefined || afterRevision === job.revision);
    if (shouldWait) {
      await this.#waitForUpdate(job, Math.min(waitMs, 30_000));
    }
    return this.#snapshot(job);
  }

  public result(id: string): JobResult {
    const job = this.#requireJob(id);
    const snapshot = this.#snapshot(job);
    if (!isTerminal(job.status)) {
      return { ready: false, job: snapshot };
    }
    return {
      ready: true,
      job: snapshot,
      ...(job.finalMessage === undefined
        ? {}
        : { finalMessage: job.finalMessage }),
      ...(job.proposal === undefined ? {} : { proposal: job.proposal }),
      ...(job.review === undefined ? {} : { review: job.review }),
    };
  }

  public list(input: ListJobsInput = {}): readonly PublicJobSnapshot[] {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    return [...this.#jobs.values()]
      .filter(
        (job) => input.status === undefined || job.status === input.status,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((job) => this.#snapshot(job));
  }

  public async cancel(id: string): Promise<PublicJobSnapshot> {
    const job = this.#requireJob(id);
    if (isTerminal(job.status)) {
      return this.#snapshot(job);
    }

    job.cancellationRequested = true;
    if (job.status === "queued") {
      const index = this.#queue.indexOf(job.id);
      if (index >= 0) {
        this.#queue.splice(index, 1);
        this.#touchQueuedJobs(index);
      }
      this.#markCancelled(job);
      return this.#snapshot(job);
    }

    const handle = this.#handles.get(job.id);
    if (handle !== undefined) {
      await handle.cancel("user");
    }
    this.#touch(job);
    return this.#snapshot(job);
  }

  public shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) {
      return this.#shutdownPromise;
    }

    this.#shuttingDown = true;
    const queuedIds = this.#queue.splice(0);
    for (const id of queuedIds) {
      const job = this.#jobs.get(id);
      if (job?.status === "queued") {
        job.cancellationRequested = true;
        this.#markCancelled(job);
      }
    }
    for (const job of this.#jobs.values()) {
      if (job.status === "running") {
        job.cancellationRequested = true;
      }
    }

    const handles = [...this.#handles.values()];
    const executions = [...this.#executions.values()];
    this.#shutdownPromise = this.#drainShutdown(handles, executions);
    return this.#shutdownPromise;
  }

  async #drainShutdown(
    handles: readonly RuntimeHandle[],
    executions: readonly Promise<void>[],
  ): Promise<void> {
    await Promise.allSettled(
      handles.map(async (handle) => {
        await handle.cancel("shutdown");
      }),
    );
    await Promise.all(executions);
  }

  async #resolveRequest(input: StartJobInput): Promise<ResolvedJobRequest> {
    const task = input.task.trim();
    if (
      task === "" ||
      task.length > this.#config.maxTaskChars ||
      task.includes("\0")
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        `task must contain 1-${this.#config.maxTaskChars} characters and no null byte`,
      );
    }

    const mode = input.mode ?? "analyze";
    if (mode === "proposal" && !this.#config.enableProposals) {
      throw new WorkerError(
        ERROR_CODES.PROPOSALS_DISABLED,
        "Proposal mode is disabled; restart with CCW_ENABLE_PROPOSALS=true",
      );
    }
    if (
      input.resumeSessionId !== undefined &&
      !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        input.resumeSessionId,
      )
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "resumeSessionId must be a Codex session UUID",
      );
    }
    if (mode === "analyze" && input.expectedRevision !== undefined) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "expectedRevision is valid only for proposal jobs",
      );
    }
    if (
      mode === "proposal" &&
      (input.expectedRevision === undefined ||
        !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(input.expectedRevision))
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "Proposal jobs require a full 40- or 64-character Git object ID",
      );
    }

    if (
      input.model !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.model)
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "model contains unsupported characters",
      );
    }
    if (
      input.model !== undefined &&
      !this.#config.allowedModels.includes(input.model)
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "model is not listed in CCW_ALLOWED_MODELS; omit it to use the Codex default",
      );
    }
    if (
      input.idempotencyKey !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.idempotencyKey)
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "idempotencyKey contains unsupported characters",
      );
    }

    const timeoutMs = input.timeoutMs ?? this.#config.defaultTimeoutMs;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > this.#config.maxTimeoutMs
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        `timeoutMs must be an integer from 1000 to ${this.#config.maxTimeoutMs}`,
      );
    }
    if (
      input.writePaths !== undefined &&
      (input.writePaths.length > this.#config.maxChangedFiles ||
        input.writePaths.some((path) => path.length > 4_096))
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        `writePaths must contain at most ${this.#config.maxChangedFiles} bounded strings`,
      );
    }

    const workingSet = await resolveWorkingSet({
      cwd: input.cwd ?? this.#config.allowedRoots[0] ?? process.cwd(),
      mode,
      ...(input.writePaths === undefined
        ? {}
        : { writePaths: input.writePaths }),
      allowedRoots: this.#config.allowedRoots,
    });
    const taskHash = createHash("sha256").update(task).digest("hex");

    return {
      task,
      taskHash,
      cwd: workingSet.cwd,
      repositoryRoot: workingSet.repositoryRoot,
      executionRoot: workingSet.executionRoot,
      mode,
      timeoutMs,
      ...(workingSet.writePaths === undefined
        ? {}
        : { writePaths: workingSet.writePaths }),
      ...(input.expectedRevision === undefined
        ? {}
        : { expectedRevision: input.expectedRevision.toLowerCase() }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: input.reasoningEffort }),
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
      ...(input.resumeSessionId === undefined
        ? {}
        : { resumeSessionId: input.resumeSessionId.toLowerCase() }),
      ...(input.persistSession === true ? { persistSession: true } : {}),
    };
  }

  #schedulePump(): void {
    if (this.#shuttingDown) {
      return;
    }
    queueMicrotask(() => {
      if (this.#shuttingDown) {
        return;
      }
      void this.#pump();
    });
  }

  async #pump(): Promise<void> {
    if (this.#pumpRunning || this.#shuttingDown) {
      return;
    }
    this.#pumpRunning = true;
    try {
      while (
        this.#activeCount < this.#config.maxConcurrent &&
        this.#queue.length > 0
      ) {
        const id = this.#queue.shift();
        if (id === undefined) {
          break;
        }
        this.#touchQueuedJobs();
        const job = this.#jobs.get(id);
        if (job?.status !== "queued") {
          continue;
        }
        this.#activeCount += 1;
        const execution = this.#execute(job);
        this.#executions.set(job.id, execution);
        void execution.then(
          () => this.#executions.delete(job.id),
          () => this.#executions.delete(job.id),
        );
      }
    } finally {
      this.#pumpRunning = false;
    }
  }

  async #execute(job: InternalJob): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.#setActivity(job, "starting", "starting");
    this.#touch(job);

    let lease: LeaseHandle | undefined;
    let prepared: PreparedProposal | undefined;
    let preparedReview: PreparedReviewWorkspace | undefined;
    let runtimeResult: RuntimeResult | undefined;
    let proposal: ProposalArtifact | undefined;
    let review: SddReviewArtifact | undefined;
    let failure: WorkerFailure | undefined;

    try {
      let runtimeRequest = job.request;
      if (job.request.mode === "proposal") {
        this.#setActivity(job, "starting", "preparing_workspace");
        this.#touch(job);
        lease = await this.#leases.acquire(job.request.repositoryRoot, job.id);
        prepared = await this.#proposalWorkspace.prepare(job.request);
        runtimeRequest = prepared.request;
      } else if (job.request.sddReview?.seal.mode === "strict") {
        this.#setActivity(job, "starting", "preparing_review_workspace");
        this.#touch(job);
        preparedReview = await this.#reviewWorkspace.prepare(job.request);
        runtimeRequest = preparedReview.request;
      }

      if (job.cancellationRequested) {
        runtimeResult = { outcome: "cancelled", resultTruncated: false };
      } else {
        try {
          const handle = this.#runtime.start(runtimeRequest, (event) => {
            this.#applyRuntimeEvent(job, event);
          });
          this.#handles.set(job.id, handle);
          this.#setActivity(job, "working", "codex_started");
          this.#touch(job);
          runtimeResult = await handle.completion;
          this.#handles.delete(job.id);
        } catch {
          runtimeResult = {
            outcome: "failed",
            resultTruncated: false,
            failure: normalizePublicRuntimeFailure(undefined),
          };
        }
      }

      if (
        runtimeResult.outcome === "completed" &&
        !job.cancellationRequested &&
        prepared !== undefined
      ) {
        this.#setActivity(job, "finalizing", "validating_proposal");
        this.#touch(job);
        proposal = await prepared.finalize();
      }
      if (
        runtimeResult.outcome === "completed" &&
        !job.cancellationRequested &&
        job.request.sddReview !== undefined &&
        runtimeResult.finalMessage !== undefined
      ) {
        this.#setActivity(job, "finalizing", "validating_review");
        this.#touch(job);
        review = await this.#reviews.finalize(
          job.request.sddReview,
          runtimeResult.finalMessage,
          job.request.model,
          job.request.reasoningEffort,
        );
      }
    } catch (error) {
      const workerError = toWorkerError(error);
      failure = { code: workerError.code, message: workerError.message };
    }

    try {
      await prepared?.cleanup();
    } catch (error) {
      const workerError = toWorkerError(error);
      failure ??= { code: workerError.code, message: workerError.message };
    }
    try {
      await preparedReview?.cleanup();
    } catch (error) {
      const workerError = toWorkerError(error);
      failure ??= { code: workerError.code, message: workerError.message };
    }
    try {
      await lease?.release();
    } catch (error) {
      const workerError = toWorkerError(error);
      failure ??= { code: workerError.code, message: workerError.message };
    }

    if (runtimeResult !== undefined) {
      job.resultTruncated = runtimeResult.resultTruncated;
    }

    if (job.cancellationRequested && failure === undefined) {
      runtimeResult = { outcome: "cancelled", resultTruncated: false };
      proposal = undefined;
      review = undefined;
    }

    if (failure !== undefined) {
      this.#markFailed(job, failure);
    } else if (runtimeResult?.outcome === "completed") {
      job.status = "completed";
      if (review !== undefined) {
        job.review = review;
        job.finalMessage = review.codexEvidence.summary;
      } else if (runtimeResult.finalMessage !== undefined) {
        job.finalMessage = runtimeResult.finalMessage;
      }
      if (proposal !== undefined) {
        job.proposal = proposal;
      }
      if (runtimeResult.sessionId !== undefined) {
        job.sessionId = runtimeResult.sessionId;
      }
      if (runtimeResult.usage !== undefined) {
        job.usage = runtimeResult.usage;
      }
      this.#markTerminal(job);
    } else if (runtimeResult?.outcome === "cancelled") {
      this.#markCancelled(job);
    } else {
      this.#markFailed(
        job,
        normalizePublicRuntimeFailure(runtimeResult?.failure),
      );
    }

    this.#activeCount -= 1;
    this.#handles.delete(job.id);
    this.#evictHistory();
    this.#schedulePump();
  }

  #assertAcceptingJobs(): void {
    if (this.#shuttingDown) {
      throw new WorkerError(
        ERROR_CODES.WORKER_SHUTTING_DOWN,
        "The worker is shutting down and cannot accept new jobs",
      );
    }
  }

  #applyRuntimeEvent(job: InternalJob, event: RuntimeEvent): void {
    const activity = event.activity ?? job.progress.activity;
    job.progress = {
      phase: event.type === "turn.completed" ? "finalizing" : "working",
      activity,
      activityLabel: activityLabel(activity),
      eventCount: job.progress.eventCount + 1,
      commandCount:
        job.progress.commandCount + (event.commandCompleted === true ? 1 : 0),
      messageCount:
        job.progress.messageCount + (event.agentMessage === undefined ? 0 : 1),
      lastEventType: event.type,
      updatedAt: job.progress.updatedAt,
      elapsedMs: job.progress.elapsedMs,
      sinceLastUpdateMs: job.progress.sinceLastUpdateMs,
    };
    if (event.sessionId !== undefined) {
      job.sessionId = event.sessionId;
    }
    if (event.usage !== undefined) {
      job.usage = event.usage;
    }
    this.#touch(job);
  }

  #markFailed(job: InternalJob, failure: WorkerFailure): void {
    job.status = "failed";
    job.failure = failure;
    this.#markTerminal(job);
  }

  #markCancelled(job: InternalJob): void {
    job.status = "cancelled";
    job.failure = {
      code: ERROR_CODES.CANCELLED,
      message: "The job was cancelled",
    };
    this.#markTerminal(job);
  }

  #markTerminal(job: InternalJob): void {
    job.completedAt = new Date().toISOString();
    const activity: JobActivity =
      job.status === "completed"
        ? "completed"
        : job.status === "cancelled"
          ? "cancelled"
          : "failed";
    this.#setActivity(job, "terminal", activity);
    this.#touch(job);
  }

  #touch(job: InternalJob): void {
    job.progress = {
      ...job.progress,
      updatedAt: new Date().toISOString(),
    };
    job.revision += 1;
    for (const wake of job.waiters) {
      wake();
    }
    job.waiters.clear();
  }

  async #waitForUpdate(job: InternalJob, waitMs: number): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      let done = false;
      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        job.waiters.delete(finish);
        resolvePromise();
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref();
      job.waiters.add(finish);
    });
  }

  #requireJob(id: string): InternalJob {
    const job = this.#jobs.get(id);
    if (job === undefined) {
      throw new WorkerError(ERROR_CODES.JOB_NOT_FOUND, "Job not found");
    }
    return job;
  }

  #setActivity(
    job: InternalJob,
    phase: JobProgress["phase"],
    activity: JobActivity,
  ): void {
    job.progress = {
      ...job.progress,
      phase,
      activity,
      activityLabel: activityLabel(activity),
    };
  }

  #snapshot(job: InternalJob): PublicJobSnapshot {
    const queueIndex =
      job.status === "queued" ? this.#queue.indexOf(job.id) : -1;
    return {
      id: job.id,
      revision: job.revision,
      status: job.status,
      mode: job.request.mode,
      cwd: job.request.cwd,
      repositoryRoot: job.request.repositoryRoot,
      ...(job.request.writePaths === undefined
        ? {}
        : { writePaths: job.request.writePaths }),
      ...(job.request.expectedRevision === undefined
        ? {}
        : { expectedRevision: job.request.expectedRevision }),
      ...(job.request.model === undefined ? {} : { model: job.request.model }),
      ...(job.request.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: job.request.reasoningEffort }),
      ...(job.request.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: job.request.idempotencyKey }),
      ...(job.request.sddReview === undefined
        ? {}
        : {
            sddReview: {
              phase: job.request.sddReview.phase,
              mode: job.request.sddReview.seal.mode,
              sealId: job.request.sddReview.seal.sealId,
              hostEvidenceDigest: job.request.sddReview.hostEvidenceDigest,
            },
          }),
      createdAt: job.createdAt,
      ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
      ...(job.completedAt === undefined
        ? {}
        : { completedAt: job.completedAt }),
      ...(queueIndex < 0 ? {} : { queuePosition: queueIndex + 1 }),
      progress: {
        ...job.progress,
        elapsedMs: elapsedMilliseconds(job),
        sinceLastUpdateMs: millisecondsSinceLastUpdate(job),
      },
      ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }),
      ...(job.usage === undefined ? {} : { usage: job.usage }),
      resultAvailable:
        job.status === "completed" && job.finalMessage !== undefined,
      resultTruncated: job.resultTruncated,
      ...(job.failure === undefined ? {} : { error: job.failure }),
    };
  }

  #touchQueuedJobs(startIndex = 0): void {
    for (const id of this.#queue.slice(startIndex)) {
      const job = this.#jobs.get(id);
      if (job?.status === "queued") {
        this.#touch(job);
      }
    }
  }

  #evictHistory(): void {
    const terminalJobs = [...this.#jobs.values()]
      .filter((job) => isTerminal(job.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    // The bound applies to retained history only. Queued and running jobs are
    // never evicted and must never displace a result the caller can still read.
    let retained = terminalJobs.length;
    for (const job of terminalJobs) {
      if (retained <= this.#config.maxHistory) {
        break;
      }
      this.#jobs.delete(job.id);
      if (job.request.idempotencyKey !== undefined) {
        this.#idempotency.delete(job.request.idempotencyKey);
      }
      retained -= 1;
    }
  }
}

function requestFingerprint(request: ResolvedJobRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        policyVersion: 1,
        taskHash: request.taskHash,
        cwd: request.cwd,
        repositoryRoot: request.repositoryRoot,
        mode: request.mode,
        writePaths: request.writePaths ?? [],
        expectedRevision: request.expectedRevision ?? null,
        model: request.model ?? null,
        reasoningEffort: request.reasoningEffort ?? null,
        timeoutMs: request.timeoutMs,
        sddReview:
          request.sddReview === undefined
            ? null
            : {
                phase: request.sddReview.phase,
                sealId: request.sddReview.seal.sealId,
                hostEvidenceDigest: request.sddReview.hostEvidenceDigest,
              },
      }),
    )
    .digest("hex");
}

function isTerminal(status: PublicJobSnapshot["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

const ACTIVITY_LABELS: Readonly<Record<JobActivity, string>> = {
  queued: "Waiting for an available worker slot",
  starting: "Starting the bounded job",
  preparing_workspace: "Preparing the isolated proposal workspace",
  preparing_review_workspace: "Preparing the revision-pinned review workspace",
  codex_started: "Codex started",
  reasoning: "Codex is reasoning",
  planning: "Codex is updating its plan",
  running_command: "Codex is running a sandboxed command",
  command_completed: "Codex completed a command",
  preparing_changes: "Codex is preparing isolated changes",
  using_tool: "Codex is using a tool",
  researching: "Codex is researching",
  working: "Codex is working",
  composing_response: "Codex is composing the response",
  response_ready: "Codex produced a response",
  validating_proposal: "Validating the isolated patch",
  validating_review: "Validating the structured independent review",
  completed: "Job completed",
  failed: "Job failed",
  cancelled: "Job cancelled",
};

function activityLabel(activity: JobActivity): string {
  return ACTIVITY_LABELS[activity];
}

function elapsedMilliseconds(job: InternalJob): number {
  const started = Date.parse(job.createdAt);
  const ended = Date.parse(job.completedAt ?? new Date().toISOString());
  return Math.max(0, ended - started);
}

function millisecondsSinceLastUpdate(job: InternalJob): number {
  return Math.max(0, Date.now() - Date.parse(job.progress.updatedAt));
}

function assertStartJobInput(input: unknown): asserts input is StartJobInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      "job input must be an object",
    );
  }
  const value = input as Record<string, unknown>;
  if (typeof value.task !== "string") {
    throw new WorkerError(ERROR_CODES.INVALID_REQUEST, "task must be a string");
  }
  if (
    value.cwd !== undefined &&
    (typeof value.cwd !== "string" || value.cwd.length > 4_096)
  ) {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      "cwd must be a bounded string",
    );
  }
  if (
    value.mode !== undefined &&
    !RUN_MODES.some((mode) => mode === value.mode)
  ) {
    throw new WorkerError(ERROR_CODES.INVALID_REQUEST, "mode is invalid");
  }
  if (
    value.writePaths !== undefined &&
    (!Array.isArray(value.writePaths) ||
      !value.writePaths.every((path) => typeof path === "string"))
  ) {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      "writePaths must be an array of strings",
    );
  }
  for (const name of ["expectedRevision", "model", "idempotencyKey"] as const) {
    if (value[name] !== undefined && typeof value[name] !== "string") {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        `${name} must be a string`,
      );
    }
  }
  if (
    value.reasoningEffort !== undefined &&
    !REASONING_EFFORTS.some((effort) => effort === value.reasoningEffort)
  ) {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      "reasoningEffort is invalid",
    );
  }
  if (value.timeoutMs !== undefined && typeof value.timeoutMs !== "number") {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      "timeoutMs must be a number",
    );
  }
}
