import type {
  ExecutionBackend,
  ExecutionObservation,
  ExecutionRef,
  ExecutionResources,
  LaunchIntent,
  ManagedWorkspace,
  TerminateExecutionResult,
} from "../ports/execution-backend.ts";
import type {
  ActiveExecution,
  ReplaceReason,
  SchedulerStore,
  StoredLaunchIntent,
} from "../ports/scheduler-store.ts";

export const DEFAULT_EXECUTION_SLOT_LIMIT = 10;
/**
 * How many times one launch may be rebuilt before the scheduler gives up on
 * it. Three covers a teardown that needed a retry and a create that failed
 * once; a launch that needs more is being judged replaceable by something
 * that will judge its replacement the same way.
 */
export const DEFAULT_REPLACEMENT_LIMIT = 3;

export type SchedulerLogger = {
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

export type SchedulerOptions = {
  backend: ExecutionBackend;
  image: string;
  logger: SchedulerLogger;
  now?: () => Date;
  /** Replacements per launch before it is closed instead; see the default. */
  replacementLimit?: number;
  resources: ExecutionResources;
  slotLimit: number;
  store: SchedulerStore;
};

export type ReclaimOptions = Pick<
  SchedulerOptions,
  "backend" | "logger" | "store"
>;

export type SchedulerRunSummary = {
  /** true when another pass held the lock and this one did nothing. */
  skipped: boolean;
  activeAfter: number;
  activeBefore: number;
  /** Executions whose row lists them as live but the provider had lost. */
  failedLaunches: ExecutionRef[];
  launched: ExecutionRef[];
  orphansTerminated: ExecutionRef[];
  /** Orphans the provider would not terminate; each still holds a slot. */
  orphansUnresolved: ExecutionRef[];
  /** Exited resources whose reclaim failed; each row stays `terminating`. */
  reclaimFailed: ExecutionRef[];
  /** Rows whose reconcile threw; they stay live and are retried next pass. */
  reconcileFailed: ExecutionRef[];
  /** Intents re-ensured after the resource was missing or not yet observed. */
  reensured: ExecutionRef[];
  /** Resources torn down and built again; see `ReplaceReason` for why. */
  replaced: ExecutionRef[];
  /**
   * Launches that have been rebuilt as many times as the limit allows and
   * would need it again. Each is left exactly as it is — its slot, its
   * resource — and reported every pass until someone looks: something keeps
   * rejecting what the scheduler builds, and building it once more is not
   * the answer.
   */
  replacementsExhausted: ExecutionRef[];
  slotLimit: number;
  terminatedObserved: ExecutionRef[];
  /**
   * true when GC could not even draw up its candidate list — listing the
   * workspaces or asking the store which sessions are retained threw. Nothing
   * was removed, and unlike the outcomes below this is a fault, not a
   * judgement, so the exit code carries it.
   */
  workspaceScanFailed: boolean;
  /** Workspaces whose removal threw; neither reclaimed nor deliberately kept. */
  workspacesFailed: string[];
  /** Workspaces of finished sessions, reclaimed by this pass. */
  workspacesReclaimed: string[];
  /**
   * Workspaces GC decided to reclaim and deliberately left alone: still
   * mounted, or no longer this installation's. Not part of the exit code — a
   * volume mounted by a container that is still shutting down is the normal
   * state during a teardown, and the next pass takes it.
   */
  workspacesUnresolved: string[];
};

/**
 * One scheduling pass. Each step is its own set of transactions so a crash
 * between them leaves only intents the next pass can pick up again:
 *
 * 1. Every live execution row is inspected; a missing resource is re-ensured
 *    from the stored intent, an exited one is recorded and reclaimed.
 * 2. Provider resources without a matching row are logged and terminated.
 * 3. Remaining slots are filled: reserve (commit) then ensure, never inside
 *    the transaction.
 * 4. Workspaces of sessions nothing will come back to are reclaimed. Last,
 *    so a slow daemon listing never delays a launch.
 */
export async function runScheduler(
  options: SchedulerOptions,
): Promise<SchedulerRunSummary> {
  if (!Number.isInteger(options.slotLimit) || options.slotLimit < 0) {
    throw new Error("slotLimit must be a non-negative integer");
  }
  const replacementLimit =
    options.replacementLimit ?? DEFAULT_REPLACEMENT_LIMIT;
  if (!Number.isInteger(replacementLimit) || replacementLimit < 1) {
    throw new Error("replacementLimit must be a positive integer");
  }
  const release = await options.store.acquirePassLock();
  if (release === null) {
    options.logger.warn("Another scheduling pass holds the lock; skipping");
    return { ...emptySummary(options.slotLimit), skipped: true };
  }
  try {
    return await pass(options);
  } finally {
    await release();
  }
}

/**
 * Step 4 on its own, under the same lock: reclaim the workspaces of sessions
 * nothing will come back to, and touch nothing else. It is for the caller
 * that has just been refused admission — a daemon whose quota preflight
 * failed, which on a full disk is the same daemon that needs the space back.
 * A whole pass with no free slots would not do: it still re-ensures missing
 * resources and replaces stale ones, which is the launching that the refusal
 * forbids.
 */
export async function reclaimWorkspaces(
  options: ReclaimOptions,
): Promise<SchedulerRunSummary> {
  const release = await options.store.acquirePassLock();
  if (release === null) {
    options.logger.warn("Another scheduling pass holds the lock; skipping");
    return { ...emptySummary(0), skipped: true };
  }
  const summary = emptySummary(0);
  try {
    await collectWorkspaces(options, summary);
    options.logger.info("Workspace reclaim completed", {
      workspace_failed_count: summary.workspacesFailed.length,
      workspace_reclaimed_count: summary.workspacesReclaimed.length,
      workspace_scan_failed: summary.workspaceScanFailed,
      workspace_unresolved_count: summary.workspacesUnresolved.length,
    });
    return summary;
  } finally {
    await release();
  }
}

/**
 * Reclaim the workspace volumes of sessions nothing will come back to. Runs
 * as the last step of a pass, and on its own from `reclaimWorkspaces`.
 */
async function collectWorkspaces(
  options: ReclaimOptions,
  summary: SchedulerRunSummary,
): Promise<void> {
  const { backend, logger, store } = options;
  const { listWorkspaces, removeWorkspace } = backend;
  // A backend whose workspaces it does not own leaves both out; there is
  // then nothing here to reclaim.
  if (!listWorkspaces || !removeWorkspace) return;
  let workspaces: ManagedWorkspace[];
  let retained: Set<string>;
  try {
    // Workspaces first, then the rows. A session created between the two
    // calls is in the retained set, so its brand-new workspace is kept;
    // asking the database first would make that same workspace look
    // unowned by the time it was listed.
    workspaces = await listWorkspaces.call(backend);
    if (workspaces.length === 0) return;
    const labelled = workspaces
      .map((workspace) => workspace.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== null);
    retained =
      labelled.length === 0
        ? new Set<string>()
        : new Set(await store.filterRetainedSessions(labelled));
  } catch (error) {
    // Nothing was removed, so nothing is inconsistent; the next pass
    // reclaims whatever this one could not even look at. It is still a
    // failure, and a pass that keeps failing here keeps leaking disk.
    summary.workspaceScanFailed = true;
    logger.error("Listing workspaces for reclaim failed; none reclaimed", {
      error: messageOf(error),
    });
    return;
  }
  for (const workspace of workspaces) {
    const { id, sessionId } = workspace;
    if (sessionId === null) {
      // Fail-safe, as with an unparseable container: a workspace whose
      // owner cannot be read is left in place and reported, never guessed
      // at from its name.
      logger.warn("Workspace carries no session; left in place", {
        created_at: workspace.createdAt.toISOString(),
        workspace_id: id,
      });
      continue;
    }
    if (retained.has(sessionId)) continue;
    let outcome: string;
    try {
      outcome = (await removeWorkspace.call(backend, id)).outcome;
    } catch (error) {
      summary.workspacesFailed.push(id);
      logger.error("Reclaiming workspace failed", {
        error: messageOf(error),
        session_id: sessionId,
        workspace_id: id,
      });
      continue;
    }
    if (outcome === "removed" || outcome === "absent") {
      summary.workspacesReclaimed.push(id);
      logger.info("Workspace reclaimed", {
        outcome,
        session_id: sessionId,
        workspace_id: id,
      });
      continue;
    }
    summary.workspacesUnresolved.push(id);
    logger.warn("Workspace was not reclaimed", {
      outcome,
      session_id: sessionId,
      workspace_id: id,
    });
  }
}

function emptySummary(slotLimit: number): SchedulerRunSummary {
  return {
    activeAfter: 0,
    activeBefore: 0,
    failedLaunches: [],
    launched: [],
    orphansTerminated: [],
    orphansUnresolved: [],
    reclaimFailed: [],
    reconcileFailed: [],
    reensured: [],
    replaced: [],
    replacementsExhausted: [],
    skipped: false,
    slotLimit,
    terminatedObserved: [],
    workspaceScanFailed: false,
    workspacesFailed: [],
    workspacesReclaimed: [],
    workspacesUnresolved: [],
  };
}

async function pass(options: SchedulerOptions): Promise<SchedulerRunSummary> {
  const now = options.now ?? (() => new Date());
  const replacementLimit =
    options.replacementLimit ?? DEFAULT_REPLACEMENT_LIMIT;
  const { backend, logger, store } = options;
  const intentOf = (stored: StoredLaunchIntent): LaunchIntent => ({
    executionId: stored.executionId,
    generation: stored.generation,
    image: options.image,
    // Only the create path calls this, so the credential a running worker
    // holds is never rotated out from under it.
    issueBootstrapNonce: () => store.issueBootstrapNonce(refOf(stored), now()),
    operationId: stored.operationId,
    resources: options.resources,
    sessionId: stored.sessionId,
  });
  const summary = emptySummary(options.slotLimit);

  // 1. Reconcile rows against the provider.
  const active = await store.listActiveExecutions(backend.kind);
  summary.activeBefore = active.length;
  for (const execution of active) {
    const ref = refOf(execution);
    try {
      await reconcile(execution);
    } catch (error) {
      // A resource-local failure (ownership conflict, a stuck inspect) must
      // not take the rest of the pass down with it. The row stays live, so
      // it keeps its slot until a later pass resolves it.
      summary.reconcileFailed.push(ref);
      logger.error("Reconciling execution failed; row left as is", {
        ...fieldsOf(ref),
        error: messageOf(error),
        session_id: execution.sessionId,
      });
    }
  }

  async function reconcile(execution: ActiveExecution): Promise<void> {
    const ref = refOf(execution);
    if (execution.backend !== backend.kind) {
      // The store is scoped; a row leaking through anyway must never be
      // recreated on this provider.
      logger.error("Execution row belongs to another backend; skipping", {
        ...fieldsOf(ref),
        row_backend: execution.backend,
        session_id: execution.sessionId,
      });
      return;
    }
    const observed = await backend.inspect(ref);
    const up = observed.found && observed.state !== "terminated";
    if (up && observed.stale) {
      // The resource runs under an isolation contract this host no longer
      // promises, and an upgrade cannot reach inside a running resource. It
      // is torn down here and re-created from the stored intent.
      logger.warn("Execution resource predates the isolation contract", {
        ...fieldsOf(ref),
        provider_ref: observed.providerRef,
        session_id: execution.sessionId,
        state: observed.state,
      });
      await replace(execution, "stale_isolation", observed);
      return;
    }
    if (
      up &&
      !execution.claimed &&
      execution.nonceExpiresAt !== null &&
      execution.nonceExpiresAt.getTime() <= now().getTime()
    ) {
      // The bootstrap door shut before anyone came through it. The resource
      // cannot be handed a second credential while it runs — the one it holds
      // is fixed in its environment — so leaving it up would keep a slot and
      // a session that nothing can ever bind. It is replaced instead.
      //
      // `claimed` is a snapshot taken before the provider was inspected, so a
      // worker may have bound itself since. Revoking decides and shuts the
      // door in one write: it loses to a claim that got there first, and once
      // it wins no claim can follow, so the teardown never orphans a binding.
      if (await store.revokeBootstrapNonce(ref, now())) {
        logger.warn("Launch nonce expired before the resource claimed", {
          ...fieldsOf(ref),
          nonce_expires_at: execution.nonceExpiresAt.toISOString(),
          provider_ref: observed.providerRef,
          session_id: execution.sessionId,
          state: observed.state,
        });
        await replace(execution, "nonce_expired", observed);
        return;
      }
      // A worker came through the door while this pass was inspecting. It
      // owns the session now, so the resource is left alone and handled below
      // like any other live one.
      logger.info("Expired launch had already been claimed; left running", {
        ...fieldsOf(ref),
        provider_ref: observed.providerRef,
        session_id: execution.sessionId,
      });
    }
    const running = up && observed.state !== "pending";
    // A replacement an earlier pass committed to and did not get to finish:
    // its teardown half happened, or the host died between the two halves.
    // A claimed launch is never rebuilt, so its flag says nothing.
    const pending = execution.claimed ? null : execution.pendingReplacement;
    if (pending !== null) {
      // Whatever is up here is neither stale nor past its credential, or it
      // would have been taken above: it is the replacement itself, built by
      // a pass that died before it could say so.
      if (observed.state === "pending") {
        // Created and never started. Ensure adopts and starts it, and
        // settles on success; it is not a rebuild, so it is not counted.
        await reensure(execution, pending);
        return;
      }
      if (observed.state === "running" || observed.state === "suspended") {
        // Only a state that proves the replacement viable settles it. A
        // resource on its way out (`terminating`) or in a state the provider
        // cannot name would be settled straight into the ordinary exit path,
        // which is the loss this record exists to prevent.
        await store.settleReplacement(ref);
        await store.recordObservation(ref, observed);
        logger.info("Pending replacement found already running; settled", {
          ...fieldsOf(ref),
          provider_ref: observed.providerRef,
          reason: pending,
          replacement_count: execution.replacementCount,
          session_id: execution.sessionId,
        });
        return;
      }
      // Stopped, going, unknown, or already gone: whatever is there is the
      // old resource or nothing, and the intent still has to be rebuilt.
      // Reading an exited one as an ordinary exit here is exactly what would
      // lose the replacement and hand the session a new launch.
      await replace(execution, pending, observed);
      return;
    }
    if (running) {
      await store.recordObservation(ref, observed);
      return;
    }
    if (observed.found && observed.state === "terminated") {
      // Mark, reclaim, then record. `terminating` keeps the row live so a
      // failed or interrupted removal is retried, and tells the next pass
      // that an absent resource means "reclaimed", not "relaunch me".
      await store.recordObservation(ref, {
        ...observed,
        state: "terminating",
      });
      let outcome: TerminateExecutionResult;
      try {
        outcome = await backend.terminate(ref);
      } catch (error) {
        logger.error("Reclaiming exited execution resource failed", {
          ...fieldsOf(ref),
          error: messageOf(error),
          session_id: execution.sessionId,
        });
        summary.reclaimFailed.push(ref);
        return;
      }
      if (outcome.outcome === "generation_mismatch") {
        // The resource was left untouched, so the slot stays occupied; the
        // row remains `terminating` and the next pass tries again.
        logger.error(
          "Reclaiming exited execution resource hit a generation mismatch",
          {
            ...fieldsOf(ref),
            found_generation: outcome.foundGeneration,
            session_id: execution.sessionId,
          },
        );
        summary.reclaimFailed.push(ref);
        return;
      }
      // The one place the slot and the session come back, so an exit the
      // scheduler sees is accounted exactly like one the gateway sees.
      await store.confirmExecutionGone(ref.executionId, now());
      summary.terminatedObserved.push(ref);
      logger.info("Execution exited; resource reclaimed", {
        ...fieldsOf(ref),
        exit_code: observed.exitCode ?? null,
        session_id: execution.sessionId,
      });
      return;
    }
    if (!observed.found && execution.observedState === "terminating") {
      // The previous pass removed the resource but crashed before recording.
      await store.confirmExecutionGone(ref.executionId, now());
      summary.terminatedObserved.push(ref);
      return;
    }
    if (!observed.found && execution.claimed) {
      // A worker traded this launch's nonce for a binding and its resource
      // is gone. Re-creating it would put a second container on a session an
      // attempt still owns, so the binding is ended instead.
      await store.confirmExecutionGone(ref.executionId, now());
      summary.terminatedObserved.push(ref);
      logger.warn("Claimed execution resource vanished; binding released", {
        ...fieldsOf(ref),
        previous_state: execution.observedState,
        session_id: execution.sessionId,
      });
      return;
    }
    // Row says live but the provider has nothing, or has a resource that was
    // created and never started. The stored intent covers both: ensure is
    // idempotent and starts a pending resource it already owns.
    await reensure(execution, "missing");
  }

  /**
   * Tears the resource down and builds it again from the stored intent. The
   * new one gets a new bootstrap credential, which is why the launch must not
   * already have bound a worker: that binding spent its credential, and a
   * replacement could never be given one.
   */
  async function replace(
    execution: ActiveExecution,
    reason: ReplaceReason,
    observed: ExecutionObservation,
  ): Promise<void> {
    const ref = refOf(execution);
    const stored = storedIntentOf(execution);
    if (execution.claimed || stored === null) {
      // Nothing to rebuild from: a claimed launch spent its credential on a
      // binding, a pre-intent row never had one. Teardown and close.
      if (!(await teardown(execution, reason, observed))) return;
      summary.replaced.push(ref);
      await store.confirmExecutionGone(ref.executionId, now());
      summary.terminatedObserved.push(ref);
      logger.warn("Replaced an execution nothing can rebuild; closed", {
        ...fieldsOf(ref),
        claimed: execution.claimed,
        reason,
        session_id: execution.sessionId,
      });
      return;
    }
    if (execution.replacementCount >= replacementLimit) {
      // Whatever gets built keeps being rejected, so building it once more
      // is not the answer. Nothing is touched: the resource stays, the slot
      // stays, and the pass fails loudly until someone looks. Closing the
      // launch instead would hand the session a fresh launch with a fresh
      // count, and move the loop one generation along.
      summary.replacementsExhausted.push(ref);
      logger.error(
        "Replacement limit reached; launch left as it is. Clear " +
          "replacement_reason and replacement_count on its worker_launches " +
          "row to let the scheduler try again",
        {
          ...fieldsOf(ref),
          limit: replacementLimit,
          reason,
          replacement_count: execution.replacementCount,
          session_id: execution.sessionId,
        },
      );
      return;
    }
    // Replacement is a teardown followed by a create, and only the create can
    // fail on what the provider knows. Asked here that costs a pass; asked
    // after the terminate it costs the worker. Asked before the record, a
    // refusal leaves the resource with its credential intact.
    if (backend.assertReplaceable) {
      try {
        await backend.assertReplaceable(intentOf(stored));
      } catch (error) {
        summary.reconcileFailed.push(ref);
        logger.error("Replacement would not launch; resource left as is", {
          ...fieldsOf(ref),
          error: messageOf(error),
          reason,
          replacement_count: execution.replacementCount,
          session_id: execution.sessionId,
        });
        return;
      }
    }
    // Committed before anything is torn down, so a teardown that half
    // happens or a host that dies after it leaves a row the next pass
    // rebuilds from the same intent, never one it reads as an exit. The same
    // write shuts the bootstrap door, so a worker cannot bind to the
    // resource while it is on its way out.
    const attempts = await store.requestReplacement(ref, reason, now());
    if (attempts === null) {
      // A worker claimed, or the launch gave its slot back, since the rows
      // were read. Either way the resource is not this pass's to tear down.
      logger.info("Replacement refused; launch moved on since it was read", {
        ...fieldsOf(ref),
        reason,
        session_id: execution.sessionId,
      });
      return;
    }
    if (!(await teardown(execution, reason, observed))) return;
    summary.replaced.push(ref);
    await reensure(execution, reason);
  }

  /**
   * The teardown half of a replacement. True once nothing of the old
   * resource is left, which includes there having been nothing to begin
   * with; false leaves the row as it is — its slot, and any pending
   * replacement — for the next pass to retry.
   */
  async function teardown(
    execution: ActiveExecution,
    reason: ReplaceReason,
    observed: ExecutionObservation,
  ): Promise<boolean> {
    const ref = refOf(execution);
    if (!observed.found) return true;
    let outcome: TerminateExecutionResult;
    try {
      outcome = await backend.terminate(ref);
    } catch (error) {
      summary.reconcileFailed.push(ref);
      logger.error("Replacing an execution resource failed", {
        ...fieldsOf(ref),
        error: messageOf(error),
        reason,
        session_id: execution.sessionId,
      });
      return false;
    }
    if (outcome.outcome === "terminated" || outcome.outcome === "absent") {
      return true;
    }
    // Left untouched, so the row keeps its slot and the next pass retries.
    summary.reconcileFailed.push(ref);
    logger.error("An execution resource would not terminate for replacement", {
      ...fieldsOf(ref),
      outcome: outcome.outcome,
      reason,
      session_id: execution.sessionId,
    });
    return false;
  }

  async function reensure(
    execution: ActiveExecution,
    reason: "missing" | ReplaceReason,
  ): Promise<void> {
    const ref = refOf(execution);
    const stored = storedIntentOf(execution);
    if (stored === null) {
      // Pre-intent row: nothing to relaunch from, so close it out instead of
      // letting it hold a slot forever.
      await store.confirmExecutionGone(ref.executionId, now());
      summary.terminatedObserved.push(ref);
      logger.warn(
        "Execution row has no launch intent; closed without relaunch",
        {
          ...fieldsOf(ref),
          previous_state: execution.observedState,
          session_id: execution.sessionId,
        },
      );
      return;
    }
    try {
      const ensured = await backend.ensureExecution(intentOf(stored));
      await store.recordObservation(ref, {
        found: true,
        observedAt: now(),
        providerRef: ensured.providerRef,
        state: ensured.state,
      });
      if (!isLaunched(ensured.state)) {
        summary.failedLaunches.push(ref);
        logger.error("Re-created execution resource did not stay up", {
          ...fieldsOf(ref),
          provider_ref: ensured.providerRef,
          session_id: execution.sessionId,
          state: ensured.state,
        });
        return;
      }
      if (reason !== "missing") await store.settleReplacement(ref);
      summary.reensured.push(ref);
      logger.warn("Execution resource re-created from intent", {
        ...fieldsOf(ref),
        previous_state: execution.observedState,
        provider_ref: ensured.providerRef,
        reason,
        session_id: execution.sessionId,
      });
    } catch (error) {
      summary.failedLaunches.push(ref);
      await store.recordObservation(ref, unknownObservation(now()));
      logger.error("Re-creating execution resource failed", {
        ...fieldsOf(ref),
        error: messageOf(error),
        session_id: execution.sessionId,
      });
    }
  }

  // 2. Resources nobody owns.
  const managed = await backend.listManaged();
  const known = new Set(
    (await store.filterKnown(managed.map(refOf), backend.kind)).map(keyOf),
  );
  for (const resource of managed) {
    if (known.has(keyOf(resource))) continue;
    logger.warn("Execution resource has no launch intent; terminating", {
      ...fieldsOf(resource),
      provider_ref: resource.providerRef,
      session_id: resource.sessionId,
    });
    let outcome: TerminateExecutionResult;
    try {
      outcome = await backend.terminate(refOf(resource));
    } catch (error) {
      // One stuck resource must not stop the rest of the pass; it still
      // occupies the host, so it is counted against capacity below.
      logger.error("Terminating orphan resource failed", {
        ...fieldsOf(resource),
        error: messageOf(error),
        provider_ref: resource.providerRef,
      });
      summary.orphansUnresolved.push(refOf(resource));
      continue;
    }
    if (outcome.outcome !== "terminated") {
      logger.warn("Orphan resource was not terminated", {
        ...fieldsOf(refOf(resource)),
        outcome: outcome.outcome,
      });
      if (outcome.outcome === "generation_mismatch") {
        summary.orphansUnresolved.push(refOf(resource));
      }
      continue;
    }
    summary.orphansTerminated.push(refOf(resource));
  }

  // 3. Fill free slots.
  const demand = await store.inspectDemand({ limit: options.slotLimit });
  // Rows are the ledger, but a still-running orphan occupies the host too.
  let free = Math.max(
    0,
    options.slotLimit -
      demand.activeExecutionCount -
      summary.orphansUnresolved.length,
  );
  for (const sessionId of demand.eligibleSessionIds) {
    if (free <= 0) break;
    const stored = await store.reserveLaunch({
      backend: backend.kind,
      now: now(),
      sessionId,
      slotLimit: options.slotLimit,
    });
    if (stored === null) continue;
    free -= 1;
    const ref = refOf(stored);
    try {
      const ensured = await backend.ensureExecution(intentOf(stored));
      await store.recordObservation(ref, {
        found: true,
        observedAt: now(),
        providerRef: ensured.providerRef,
        state: ensured.state,
      });
      if (!isLaunched(ensured.state)) {
        // Created, but already dead (bad image, crashing entrypoint). The row
        // is recorded as observed; next pass reclaims the resource. Not a
        // success, so the process exits non-zero.
        summary.failedLaunches.push(ref);
        logger.error("Execution resource exited right after launch", {
          ...fieldsOf(ref),
          provider_ref: ensured.providerRef,
          session_id: sessionId,
          state: ensured.state,
        });
        continue;
      }
      summary.launched.push(ref);
      logger.info("Execution launched", {
        ...fieldsOf(ref),
        created: ensured.created,
        provider_ref: ensured.providerRef,
        session_id: sessionId,
      });
    } catch (error) {
      // The intent stays committed; step 1 of the next pass retries it.
      summary.failedLaunches.push(ref);
      await store.recordObservation(ref, unknownObservation(now()));
      logger.error("Launching execution failed; intent kept for retry", {
        ...fieldsOf(ref),
        error: messageOf(error),
        session_id: sessionId,
      });
    }
  }
  // 4. Workspaces nothing will come back to.
  await collectWorkspaces(options, summary);

  summary.activeAfter = (
    await store.inspectDemand({ limit: 0 })
  ).activeExecutionCount;
  logger.info("Scheduling pass completed", {
    active_after: summary.activeAfter,
    active_before: summary.activeBefore,
    failed_count: summary.failedLaunches.length,
    launched_count: summary.launched.length,
    orphan_count: summary.orphansTerminated.length,
    orphan_unresolved_count: summary.orphansUnresolved.length,
    reclaim_failed_count: summary.reclaimFailed.length,
    reconcile_failed_count: summary.reconcileFailed.length,
    reensured_count: summary.reensured.length,
    replaced_count: summary.replaced.length,
    replacement_exhausted_count: summary.replacementsExhausted.length,
    slot_limit: summary.slotLimit,
    terminated_count: summary.terminatedObserved.length,
    workspace_failed_count: summary.workspacesFailed.length,
    workspace_reclaimed_count: summary.workspacesReclaimed.length,
    workspace_scan_failed: summary.workspaceScanFailed,
    workspace_unresolved_count: summary.workspacesUnresolved.length,
  });
  return summary;
}

/** Only these states mean the launch took; anything else is a failure. */
function isLaunched(state: ExecutionObservation["state"]): boolean {
  return state === "running" || state === "pending";
}

function storedIntentOf(execution: ActiveExecution): StoredLaunchIntent | null {
  if (execution.operationId === null) return null;
  return {
    executionId: execution.executionId,
    generation: execution.generation,
    operationId: execution.operationId,
    sessionId: execution.sessionId,
  };
}

function refOf(ref: ExecutionRef): ExecutionRef {
  return { executionId: ref.executionId, generation: ref.generation };
}

function keyOf(ref: ExecutionRef): string {
  return `${ref.executionId}#${ref.generation}`;
}

function fieldsOf(ref: ExecutionRef) {
  return { execution_id: ref.executionId, generation: ref.generation };
}

function unknownObservation(observedAt: Date): ExecutionObservation {
  return { found: false, observedAt, providerRef: null, state: "unknown" };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
