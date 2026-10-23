import { describe, expect, test } from "bun:test";
import { setupDom, setViewport } from "@werft-ai/ui/test-support/dom";
import { htmlOf } from "@werft-ai/ui/test-support/html";
import type { JSX } from "react";
import {
  STATUS_VOCABULARY,
  type StatusAxis,
  type StatusStateOf,
} from "./status/vocabulary.ts";

/*
 * packages/ui's gallery for the pieces that take contracts types: one render
 * per width, fixed data only, so a snapshot catches drift.
 */

const { render } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { ApiErrorState } = await import("./feedback/api-error-state.tsx");
const { ReceiptLink } = await import("./receipt/receipt-link.tsx");
const { ReceiptSummary } = await import("./receipt/receipt-summary.tsx");
const { StatusLabel } = await import("./status/status-label.tsx");

const SESSION_ID = "01J8Z5T7Q0000000000000000A";
const TURN_ID = "01J8Z5T7Q0000000000000000B";
const REQUEST_ID = "01J8Z5T7Q0000000000000000C";
const CREATED_AT = "2026-09-21T02:15:00.000Z";
const UPDATED_AT = "2026-09-21T02:15:42.000Z";

function noop(): void {}

function AxisRow<A extends StatusAxis>({ axis }: { axis: A }): JSX.Element {
  const states = Object.keys(STATUS_VOCABULARY[axis]) as StatusStateOf<A>[];
  return (
    <section>
      <h3>{axis}</h3>
      <div className="gallery__row">
        {states.map((state) => (
          <StatusLabel key={String(state)} axis={axis} state={state} />
        ))}
      </div>
    </section>
  );
}

function Gallery(): JSX.Element {
  return (
    <div className="gallery">
      <h2>StatusLabel</h2>
      <AxisRow axis="admission" />
      <AxisRow axis="turn" />
      <AxisRow axis="receipt" />
      <AxisRow axis="execution" />
      <div className="gallery__row">
        <StatusLabel
          axis="turn"
          state="running"
          detail="2분 12초 경과"
          stale={true}
        />
        <StatusLabel
          axis="admission"
          state="paused"
          label="관리자가 세웠습니다"
        />
        {/* An unbreakable identifier: the case that pushed the row past 360px
            before `.ap-status__detail` got a min-width of 0. */}
        <StatusLabel
          axis="execution"
          state="suspended"
          detail={`exec_${"0".repeat(60)}`}
        />
      </div>

      <h2>Receipt</h2>
      <ReceiptSummary
        operation="append_message"
        status="accepted"
        target={{
          session_id: SESSION_ID,
          turn_id: TURN_ID,
          request_id: REQUEST_ID,
        }}
        timestamps={{ created_at: CREATED_AT, updated_at: CREATED_AT }}
        action={
          <ReceiptLink
            receiptId="rcpt_01J8Z5"
            status="accepted"
            href="/receipts/rcpt_01J8Z5"
          />
        }
      />
      <ReceiptSummary
        operation="terminate"
        status="unknown"
        target={{ session_id: SESSION_ID, turn_id: null, request_id: null }}
        timestamps={{ created_at: CREATED_AT, updated_at: UPDATED_AT }}
      />
      <ReceiptSummary
        operation="answer"
        status="failed"
        target={{ session_id: SESSION_ID, turn_id: TURN_ID, request_id: null }}
        timestamps={{ created_at: CREATED_AT, updated_at: UPDATED_AT }}
        error={{ code: "SESSION_PAUSED", message: "session is paused" }}
      />

      <h2>ApiErrorState</h2>
      <ApiErrorState
        message="session is closed"
        code="SESSION_CLOSED"
        retry={noop}
        evidenceLink={{ href: "/sessions/01J8Z5/journal" }}
      />
    </div>
  );
}

const WIDTHS = [360, 768, 1440] as const;

function galleryAt(width: number): string {
  setViewport({ width, height: 900 });
  const { container } = render(<Gallery />);
  return htmlOf(container.firstElementChild);
}

describe("도메인 컴포넌트 갤러리", () => {
  test("360px", () => {
    expect(galleryAt(360)).toMatchSnapshot();
  });

  test("폭이 바뀌어도 마크업은 그대로다", () => {
    const [narrow, ...rest] = WIDTHS.map((width) => galleryAt(width));
    // Breakpoints belong to CSS; a JS branch on width would desync SSR.
    for (const markup of rest) expect(markup).toBe(narrow as string);
  });
});
