import type { InstallationLimitsResponse } from "@werft-ai/contracts";
import {
  Badge,
  Card,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Meter,
  Section,
  StatCard,
  Text,
} from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import type { InstallationLimitsMessages } from "./messages.ts";
import { Box, Value } from "./placeholders.tsx";
import { useOperationsMessages } from "./use-messages.ts";

export interface InstallationLimitsProps {
  /** GET /v1/limits; undefined while it is read. */
  readonly limits: InstallationLimitsResponse | undefined;
  /** The zone `refreshed_at` is shown in; the viewer's by default. */
  readonly timeZone?: string | undefined;
  /** An ApiErrorState in place of the figures when they cannot be read. */
  readonly error?: ReactNode;
  readonly messages?: Partial<InstallationLimitsMessages> | undefined;
}

/**
 * The installation's execution capacity, slots and stored input, over every
 * limit it sets. The per-session limits have no installation-wide figure.
 */
export function InstallationLimits({
  limits,
  timeZone,
  error,
  messages: override,
}: InstallationLimitsProps): JSX.Element {
  const { messages, format } = useOperationsMessages(
    "installationLimits",
    override,
  );
  const loading = limits === undefined;
  const cap = limits?.limits;
  const use = limits?.usage;
  const perSession = (
    <Text as="span" variant="sub" className="text-subtle-foreground">
      {messages.perSession}
    </Text>
  );
  const rows: readonly (readonly [string, ReactNode, ReactNode, string])[] = [
    [
      messages.slots,
      cap && use
        ? `${format.count(use.execution_slots_used)} / ${format.count(cap.execution_slot_limit)}`
        : null,
      cap ? format.count(cap.execution_slot_limit) : null,
      messages.slotsRowNote,
    ],
    [
      messages.storage,
      use ? format.bytes(use.storage.used_bytes) : null,
      cap ? format.bytes(cap.storage_limit_bytes) : null,
      messages.storageRowNote,
    ],
    [
      messages.sessionCost,
      perSession,
      cap ? format.usd(cap.session_cost_limit_usd) : null,
      messages.sessionCostNote,
    ],
    [
      messages.sessionTokens,
      perSession,
      cap === undefined ? null : cap.session_token_limit === null ? (
        <Badge key="unset">{messages.notSet}</Badge>
      ) : (
        format.count(cap.session_token_limit)
      ),
      messages.sessionTokensNote,
    ],
    [
      messages.queuedInput,
      perSession,
      cap
        ? messages.queuedInputValue(
            format.count(cap.queued_input_limit_per_session),
          )
        : null,
      messages.queuedInputNote,
    ],
    [
      messages.maxTurn,
      perSession,
      cap ? format.duration(cap.max_turn_seconds) : null,
      messages.maxTurnNote,
    ],
  ];
  if (error) {
    return (
      <div className="flex min-w-0 flex-col gap-8">
        <Section title={messages.capacity}>{error}</Section>
      </div>
    );
  }
  return (
    <div
      aria-busy={loading || undefined}
      className="flex min-w-0 flex-col gap-8"
    >
      <Section
        title={messages.capacity}
        description={
          <>
            {messages.capacityNote} ·{" "}
            <Value loading={loading} width="5rem">
              {limits
                ? messages.asOf(format.clock(limits.refreshed_at, timeZone))
                : null}
            </Value>
          </>
        }
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4">
          <StatCard
            label={messages.slotsInUse}
            value={
              <Value loading={loading} width="4rem">
                {use ? format.count(use.execution_slots_used) : null}
              </Value>
            }
            outOf={
              <Value loading={loading} width="1.5rem">
                {cap ? format.count(cap.execution_slot_limit) : null}
              </Value>
            }
            chart={
              cap && use ? (
                <Meter
                  value={use.execution_slots_used}
                  max={cap.execution_slot_limit}
                  label={messages.slotsMeter}
                />
              ) : (
                <Box height="0.5rem" />
              )
            }
            description={
              <Value loading={loading} width="5rem">
                {cap && use
                  ? messages.slotsFree(
                      format.count(
                        cap.execution_slot_limit - use.execution_slots_used,
                      ),
                    )
                  : null}
              </Value>
            }
          />
          <StatCard
            label={messages.storage}
            value={
              <Value loading={loading} width="4rem">
                {use ? format.bytes(use.storage.used_bytes) : null}
              </Value>
            }
            outOf={
              <Value loading={loading} width="3rem">
                {cap ? format.bytes(cap.storage_limit_bytes) : null}
              </Value>
            }
            chart={
              cap && use ? (
                <Meter
                  value={use.storage.used_bytes}
                  max={cap.storage_limit_bytes}
                  label={messages.storageMeter}
                />
              ) : (
                <Box height="0.5rem" />
              )
            }
            description={messages.storageNote}
          />
        </div>
      </Section>
      <Section title={messages.limits}>
        <Card flush>
          <GridTable
            aria-label={messages.limits}
            columns="minmax(0,1fr) 128px 112px minmax(0,1.6fr)"
            narrowAt={480}
            narrowColumns="minmax(0,1fr) 112px 80px"
          >
            <GridTableHeader>
              <GridTableColumnHeader>{messages.item}</GridTableColumnHeader>
              <GridTableColumnHeader>{messages.current}</GridTableColumnHeader>
              <GridTableColumnHeader>{messages.limit}</GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {messages.note}
              </GridTableColumnHeader>
            </GridTableHeader>
            {rows.map(([item, now, limit, note]) => (
              <GridTableRow key={item}>
                <GridTableCell>{item}</GridTableCell>
                <GridTableCell className="tabular-nums">
                  {now === perSession ? (
                    now
                  ) : (
                    <Value loading={loading}>{now}</Value>
                  )}
                </GridTableCell>
                <GridTableCell className="tabular-nums">
                  <Value loading={loading}>{limit}</Value>
                </GridTableCell>
                <GridTableCell hideNarrow className="text-muted-foreground">
                  {note}
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
        </Card>
      </Section>
      {messages.loading ? (
        <output className="sr-only">{loading ? messages.loading : ""}</output>
      ) : null}
    </div>
  );
}
