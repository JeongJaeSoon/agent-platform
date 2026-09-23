import { describe, expect, test } from "bun:test";
import type { ReconciledOrphan } from "@agent-platform/db";
import { MemoryLogSink, StructuredLogger } from "@agent-platform/observability";
import { runReconciler } from "./reconcile.ts";

describe("reconciler run", () => {
  test("runs one bounded batch and logs the affected session IDs", async () => {
    const sink = new MemoryLogSink();
    const reconciled: ReconciledOrphan[] = [
      {
        action: "requeued",
        blockedMessageIds: [],
        dryRun: false,
        releasedMessageIds: [7],
        sessionId: "session-a",
        stalePodId: "pod-a",
        terminalMessageIds: [],
      },
      {
        action: "released",
        blockedMessageIds: [],
        dryRun: false,
        releasedMessageIds: [],
        sessionId: "session-b",
        stalePodId: "pod-b",
        terminalMessageIds: [8],
      },
    ];
    let calls = 0;
    const result = await runReconciler({
      environment: {
        HEARTBEAT_TTL_SEC: "45",
        RECONCILER_BATCH_SIZE: "12",
        RECONCILER_DRY_RUN: "false",
      },
      logger: new StructuredLogger({ sinks: [sink] }),
      now: new Date("2026-09-14T00:00:00Z"),
      reconcile: async (options) => {
        calls += 1;
        expect(options).toEqual({
          dryRun: false,
          leaseTtlMs: 45_000,
          limit: 12,
          now: new Date("2026-09-14T00:00:00Z"),
        });
        return reconciled;
      },
      reconcileLeases: async (options) => {
        expect(options).toEqual({
          dryRun: false,
          limit: 12,
          now: new Date("2026-09-14T00:00:00Z"),
        });
        return [];
      },
      reconcileInterrupts: async (options) => {
        expect(options).toEqual({
          dryRun: false,
          limit: 12,
          now: new Date("2026-09-14T00:00:00Z"),
        });
        return [
          {
            attemptId: "attempt-c",
            dryRun: false,
            executionId: "exec-c",
            sessionId: "session-c",
          },
        ];
      },
      expireInterrupts: async (options) => {
        expect(options).toEqual({
          dryRun: false,
          now: new Date("2026-09-14T00:00:00Z"),
        });
        return 3;
      },
      expireTerminations: async (options) => {
        expect(options).toEqual({
          dryRun: false,
          now: new Date("2026-09-14T00:00:00Z"),
        });
        return 2;
      },
    });

    expect(calls).toBe(1);
    expect(result.orphans).toBe(reconciled);
    expect(result.leases).toEqual([]);
    expect(result.interrupts).toHaveLength(1);
    expect(result.interruptsOverdue).toBe(3);
    expect(result.terminationsOverdue).toBe(2);
    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "info",
        message: "Orphan session reconciliation completed",
        fields: {
          blocked_count: 0,
          dry_run: false,
          lease_ttl_sec: 45,
          reconciled_count: 2,
          released_count: 1,
          requeued_count: 1,
          session_ids: ["session-a", "session-b"],
        },
      }),
      expect.objectContaining({
        level: "info",
        message: "Expired lease reconciliation completed",
        fields: {
          dry_run: false,
          ended_count: 0,
          fenced_count: 0,
          reconciled_count: 0,
          session_ids: [],
        },
      }),
      expect.objectContaining({
        level: "info",
        message: "Overdue interrupt executions sent to terminate",
        fields: {
          dry_run: false,
          fenced_count: 1,
          session_ids: ["session-c"],
        },
      }),
      expect.objectContaining({
        level: "info",
        message: "Overdue interrupt receipts marked unknown",
        fields: { dry_run: false, overdue_count: 3 },
      }),
      expect.objectContaining({
        level: "info",
        message: "Overdue terminate receipts marked unknown",
        fields: { dry_run: false, overdue_count: 2 },
      }),
    ]);
  });

  test("a dry run asks every pass not to write and logs what it would do", async () => {
    const sink = new MemoryLogSink();
    const seen: boolean[] = [];
    await runReconciler({
      environment: { RECONCILER_DRY_RUN: "1" },
      logger: new StructuredLogger({ sinks: [sink] }),
      reconcile: async ({ dryRun }) => {
        seen.push(dryRun);
        return [];
      },
      reconcileLeases: async ({ dryRun }) => {
        seen.push(dryRun);
        return [];
      },
      reconcileInterrupts: async ({ dryRun }) => {
        seen.push(dryRun);
        return [
          {
            attemptId: "attempt-d",
            dryRun,
            executionId: "exec-d",
            sessionId: "session-d",
          },
        ];
      },
      expireInterrupts: async ({ dryRun }) => {
        seen.push(dryRun);
        return 4;
      },
      expireTerminations: async ({ dryRun }) => {
        seen.push(dryRun);
        return 0;
      },
    });

    expect(seen).toEqual([true, true, true, true, true]);
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        message: "Overdue interrupt receipts marked unknown",
        fields: { dry_run: true, overdue_count: 4 },
      }),
    );
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        message: "Overdue interrupt executions sent to terminate",
        fields: {
          dry_run: true,
          fenced_count: 1,
          session_ids: ["session-d"],
        },
      }),
    );
  });

  test("rejects invalid shared TTL, batch, and dry-run settings", async () => {
    const logger = new StructuredLogger({ sinks: [] });
    const reconcile = async () => [];
    const reconcileLeases = async () => [];
    const reconcileInterrupts = async () => [];
    const expireInterrupts = async () => 0;
    const expireTerminations = async () => 0;
    await expect(
      runReconciler({
        environment: { HEARTBEAT_TTL_SEC: "0" },
        logger,
        reconcile,
        reconcileLeases,
        reconcileInterrupts,
        expireInterrupts,
        expireTerminations,
      }),
    ).rejects.toThrow("HEARTBEAT_TTL_SEC");
    await expect(
      runReconciler({
        environment: { RECONCILER_BATCH_SIZE: "1.5" },
        logger,
        reconcile,
        reconcileLeases,
        reconcileInterrupts,
        expireInterrupts,
        expireTerminations,
      }),
    ).rejects.toThrow("RECONCILER_BATCH_SIZE");
    await expect(
      runReconciler({
        environment: { RECONCILER_DRY_RUN: "yes" },
        logger,
        reconcile,
        reconcileLeases,
        reconcileInterrupts,
        expireInterrupts,
        expireTerminations,
      }),
    ).rejects.toThrow("RECONCILER_DRY_RUN");
  });
});
