import type {
  ReconciledInterrupt,
  ReconciledLease,
  ReconciledOrphan,
} from "@agent-platform/db";

export type ReconcileOptions = {
  dryRun: boolean;
  leaseTtlMs: number;
  limit: number;
  now: Date;
};

export type LeaseReconcileOptions = Omit<ReconcileOptions, "leaseTtlMs">;

export type ReconcilerRun = {
  orphans: ReconciledOrphan[];
  leases: ReconciledLease[];
  interrupts: ReconciledInterrupt[];
  terminationsOverdue: number;
};

export type ReconcilerLogger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

export type ReconcilerEnvironment = {
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
}): Promise<ReconcilerRun> {
  const environment = input.environment ?? process.env;
  const leaseTtlSec = positiveNumber(
    environment.HEARTBEAT_TTL_SEC ?? "30",
    "HEARTBEAT_TTL_SEC",
  );
  const limit = positiveInteger(
    environment.RECONCILER_BATCH_SIZE ?? "100",
    "RECONCILER_BATCH_SIZE",
  );
  const dryRun = booleanFlag(
    environment.RECONCILER_DRY_RUN ?? "false",
    "RECONCILER_DRY_RUN",
  );
  const now = input.now ?? new Date();
  const reconciled = await input.reconcile({
    dryRun,
    leaseTtlMs: leaseTtlSec * 1_000,
    limit,
    now,
  });
  input.logger.info("Orphan session reconciliation completed", {
    blocked_count: reconciled.filter(({ action }) => action === "blocked")
      .length,
    dry_run: dryRun,
    lease_ttl_sec: leaseTtlSec,
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
  const terminationsOverdue = await input.expireTerminations({ dryRun, now });
  input.logger.info("Overdue terminate receipts marked unknown", {
    dry_run: dryRun,
    overdue_count: terminationsOverdue,
  });
  return { orphans: reconciled, leases, interrupts, terminationsOverdue };
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
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
