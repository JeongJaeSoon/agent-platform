import { describe, expect, test } from "bun:test";
import { RECEIPT_STATUS_VALUES } from "@agent-platform/contracts";

import { describeStatus } from "../status/vocabulary.ts";
import { setupDom } from "../test-support/dom.ts";
import { formatTimestamp } from "./format-timestamp.ts";
import { ReceiptLink } from "./receipt-link.tsx";
import { ReceiptSummary } from "./receipt-summary.tsx";

const { render } = await setupDom();

const TARGET = {
  session_id: "01J8Z5T7Q0000000000000000A",
  turn_id: "01J8Z5T7Q0000000000000000B",
  request_id: null,
};
const TIMES = {
  created_at: "2026-09-21T02:15:00.000Z",
  updated_at: "2026-09-21T02:15:42.000Z",
};

function toneOf(container: HTMLElement): string | null {
  return container
    .querySelector(".ap-status[data-axis='receipt']")
    ?.getAttribute("data-tone") as string | null;
}

describe("ReceiptSummary", () => {
  test("accepted는 접수일 뿐, 성공 색이 아니다", () => {
    const { container, getByText } = render(
      <ReceiptSummary
        operation="append_message"
        status="accepted"
        target={TARGET}
        timestamps={{
          created_at: TIMES.created_at,
          updated_at: TIMES.created_at,
        }}
      />,
    );

    expect(getByText("접수됨")).toBeDefined();
    expect(toneOf(container)).toBe("progress");
    expect(toneOf(container)).not.toBe("positive");
  });

  test("unknown은 성공 색으로 그리지 않는다", () => {
    const { container, getByText } = render(
      <ReceiptSummary
        operation="terminate"
        status="unknown"
        target={TARGET}
        timestamps={TIMES}
      />,
    );

    expect(getByText("결과 미확정")).toBeDefined();
    expect(toneOf(container)).toBe("unknown");
    expect(toneOf(container)).not.toBe("positive");
  });

  test("succeeded만 성공 색을 받는다", () => {
    const { container } = render(
      <ReceiptSummary
        operation="pause"
        status="succeeded"
        target={TARGET}
        timestamps={TIMES}
      />,
    );
    expect(toneOf(container)).toBe("positive");
  });

  test("failed는 원문보다 할 일을 먼저 보여준다", () => {
    const { container, getByText } = render(
      <ReceiptSummary
        operation="answer"
        status="failed"
        target={TARGET}
        timestamps={TIMES}
        error={{ code: "SESSION_PAUSED", message: "session is paused" }}
      />,
    );

    const guidance = container.querySelector(
      ".ap-receipt__guidance",
    ) as Element;
    const detail = container.querySelector(".ap-receipt__detail") as Element;
    expect(guidance.textContent).toBe(
      "세션이 일시정지 상태입니다 — 재개한 뒤 보내세요.",
    );
    expect(detail.textContent).toContain("session is paused");
    // 할 일이 원문보다 먼저 온다 (§9).
    expect(
      guidance.compareDocumentPosition(detail) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(getByText("실패")).toBeDefined();
  });

  test("없는 대상 필드는 빈 값으로 그리지 않는다", () => {
    const { container } = render(
      <ReceiptSummary
        operation="create_session"
        status="accepted"
        target={{
          session_id: TARGET.session_id,
          turn_id: null,
          request_id: null,
        }}
        timestamps={TIMES}
      />,
    );
    expect(container.querySelectorAll(".ap-receipt__field")).toHaveLength(1);
  });

  test("갱신 시각이 접수 시각과 같으면 한 번만 보여준다", () => {
    const { container } = render(
      <ReceiptSummary
        operation="create_session"
        status="accepted"
        target={TARGET}
        timestamps={{
          created_at: TIMES.created_at,
          updated_at: TIMES.created_at,
        }}
      />,
    );
    expect(container.querySelectorAll("time")).toHaveLength(1);
  });

  test("네 가지 receipt 상태가 모두 다른 tone을 받는다", () => {
    const tones = RECEIPT_STATUS_VALUES.map(
      (status) => describeStatus("receipt", status).tone,
    );
    expect(new Set(tones).size).toBe(RECEIPT_STATUS_VALUES.length);
  });
});

describe("ReceiptLink", () => {
  test("상태를 색뿐 아니라 글자로도 알려 준다", () => {
    const { container } = render(
      <ReceiptLink
        receiptId="rcpt_1"
        status="unknown"
        href="/receipts/rcpt_1"
      />,
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/receipts/rcpt_1");
    expect(link?.getAttribute("data-tone")).toBe("unknown");
    expect(link?.textContent).toContain("결과 미확정");
    expect(link?.textContent).toContain("rcpt_1");
  });
});

describe("formatTimestamp", () => {
  test("러너 시간대와 무관하게 같은 문자열을 만든다", () => {
    expect(formatTimestamp("2026-09-21T02:15:00.000Z")).toBe(
      formatTimestamp("2026-09-21T02:15:00.000Z"),
    );
    expect(formatTimestamp("2026-09-21T02:15:00.000Z")).toContain("26.");
  });

  test("날짜가 아니면 받은 문자열을 그대로 둔다", () => {
    expect(formatTimestamp("나중에")).toBe("나중에");
  });
});
