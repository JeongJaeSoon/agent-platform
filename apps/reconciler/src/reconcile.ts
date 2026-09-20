import type { ReconciledOrphan } from "@agent-platform/db";

export type ReconcileOptions = {
  dryRun: boolean;
  leaseTtlMs: number;
  limit: number;
  now: Date;
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
}): Promise<ReconciledOrphan[]> {
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
  const reconciled = await input.reconcile({
    dryRun,
    leaseTtlMs: leaseTtlSec * 1_000,
    limit,
    now: input.now ?? new Date(),
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
  return reconciled;
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
