import { describe, expect, test } from "bun:test";
import type { ReconciledOrphan } from "@claude-session-platform/db";
import {
  MemoryLogSink,
  StructuredLogger,
} from "@claude-session-platform/observability";
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
    });

    expect(calls).toBe(1);
    expect(result).toBe(reconciled);
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
    ]);
  });

  test("rejects invalid shared TTL, batch, and dry-run settings", async () => {
    const logger = new StructuredLogger({ sinks: [] });
    const reconcile = async () => [];
    await expect(
      runReconciler({
        environment: { HEARTBEAT_TTL_SEC: "0" },
        logger,
        reconcile,
      }),
    ).rejects.toThrow("HEARTBEAT_TTL_SEC");
    await expect(
      runReconciler({
        environment: { RECONCILER_BATCH_SIZE: "1.5" },
        logger,
        reconcile,
      }),
    ).rejects.toThrow("RECONCILER_BATCH_SIZE");
    await expect(
      runReconciler({
        environment: { RECONCILER_DRY_RUN: "yes" },
        logger,
        reconcile,
      }),
    ).rejects.toThrow("RECONCILER_DRY_RUN");
  });
});
