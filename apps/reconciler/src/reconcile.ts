import type {
  AnnouncedInputReturn,
  ReconciledInterrupt,
  ReconciledLease,
  ReconciledOrphan,
} from "@agent-platform/db";

export type ReconcileOptions = {
  dryRun: boolean;
  limit: number;
  // Unset: the store judges deadlines on the database clock.
  now?: Date;
};

export type LeaseReconcileOptions = ReconcileOptions & { now: Date };

export type ReconcilerRun = {
  orphans: ReconciledOrphan[];
  leases: ReconciledLease[];
  interrupts: ReconciledInterrupt[];
  interruptsOverdue: number;
  terminationsOverdue: number;
  inputReturns: AnnouncedInputReturn[];
};

export type ReconcilerLogger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

export type ReconcilerEnvironment = {
  // Present only to be refused: see runReconciler.
  HEARTBEAT_TTL_SEC?: string;
  RECONCILER_BATCH_SIZE?: string;
  RECONCILER_DRY_RUN?: string;
};

export async function runReconciler(input: {
  environment?: ReconcilerEnvironment;
  logger: ReconcilerLogger;
  now?: Date;
  reconcile(options: ReconcileOptions): Promise<ReconciledOrphan[]>;
  // Gateway-bound sessions: fence the attempt and ask for its execution to
  // go. Their judgement waits for the scheduler to confirm the removal.
  reconcileLeases(options: LeaseReconcileOptions): Promise<ReconciledLease[]>;
  // Terminate receipts past their deadline become unknown. The scheduler
  // sweeps too, but it may not run at all while Docker is down.
  expireTerminations(options: { now: Date; dryRun: boolean }): Promise<number>;
  // Interrupts left unsettled past their deadline by a worker that keeps its
  // lease: its execution goes down the terminate path. Runs after the lease
  // pass so an attempt that pass already fenced is not fenced twice.
  reconcileInterrupts(
    options: LeaseReconcileOptions,
  ): Promise<ReconciledInterrupt[]>;
  // Interrupt receipts still open past their later deadline become unknown,
  // for when nothing confirms the kill above.
  expireInterrupts(options: { now: Date; dryRun: boolean }): Promise<number>;
  // Waits for input the stream still reports after they ended with nothing
  // written (expiry, a lost attempt). Last, so the lease pass above has
  // already fenced what it fences and this reports the result in one go.
  announceInputReturns(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<AnnouncedInputReturn[]>;
}): Promise<ReconcilerRun> {
  const environment = input.environment ?? process.env;
  // Every lease this judges carries the deadline its writer stamped from the
  // API's HEARTBEAT_TTL_SEC. A value here could only disagree with that one,
  // and silently ignoring it would let an operator believe it applies
  // (94S-132).
  if (environment.HEARTBEAT_TTL_SEC !== undefined) {
    throw new Error(
      "HEARTBEAT_TTL_SEC is read by the API only; the reconciler judges the lease deadlines stored with each heartbeat. Unset it here.",
    );
  }
  const limit = positiveInteger(
    environment.RECONCILER_BATCH_SIZE ?? "100",
    "RECONCILER_BATCH_SIZE",
  );
  const dryRun = booleanFlag(
    environment.RECONCILER_DRY_RUN ?? "false",
    "RECONCILER_DRY_RUN",
  );
  const reconciled = await input.reconcile({
    dryRun,
    limit,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const now = input.now ?? new Date();
  input.logger.info("Orphan session reconciliation completed", {
    blocked_count: reconciled.filter(({ action }) => action === "blocked")
      .length,
    dry_run: dryRun,
    reconciled_count: reconciled.length,
    released_count: reconciled.filter(({ action }) => action === "released")
      .length,
    requeued_count: reconciled.filter(({ action }) => action === "requeued")
      .length,
    session_ids: reconciled.map(({ sessionId }) => sessionId),
  });
  const leases = await input.reconcileLeases({ dryRun, limit, now });
  input.logger.info("Expired lease reconciliation completed", {
    dry_run: dryRun,
    ended_count: leases.filter(({ action }) => action === "ended").length,
    fenced_count: leases.filter(({ action }) => action === "fenced").length,
    reconciled_count: leases.length,
    session_ids: leases.map(({ sessionId }) => sessionId),
  });
  const interrupts = await input.reconcileInterrupts({ dryRun, limit, now });
  input.logger.info("Overdue interrupt executions sent to terminate", {
    dry_run: dryRun,
    fenced_count: interrupts.length,
    session_ids: interrupts.map(({ sessionId }) => sessionId),
  });
  const interruptsOverdue = await input.expireInterrupts({ dryRun, now });
  input.logger.info("Overdue interrupt receipts marked unknown", {
    dry_run: dryRun,
    overdue_count: interruptsOverdue,
  });
  const terminationsOverdue = await input.expireTerminations({ dryRun, now });
  input.logger.info("Overdue terminate receipts marked unknown", {
    dry_run: dryRun,
    overdue_count: terminationsOverdue,
  });
  const inputReturns = await input.announceInputReturns({ dryRun, limit });
  input.logger.info("Ended input waits announced", {
    dry_run: dryRun,
    announced_count: inputReturns.length,
    session_ids: inputReturns.map(({ sessionId }) => sessionId),
  });
  return {
    orphans: reconciled,
    leases,
    interrupts,
    interruptsOverdue,
    terminationsOverdue,
    inputReturns,
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function booleanFlag(value: string, name: string): boolean {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}
