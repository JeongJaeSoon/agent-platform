import { describe, expect, test } from "bun:test";
import {
  ADMISSION_STATE_VALUES,
  EXECUTION_STATE_VALUES,
  RECEIPT_STATUS_VALUES,
  TURN_STATUS_VALUES,
} from "@agent-platform/contracts";

import { setupDom, stubPrefersReducedMotion } from "../test-support/dom.ts";
import { StatusLabel } from "./status-label.tsx";
import { describeStatus, STATUS_VOCABULARY } from "./vocabulary.ts";

// Queries come from `render()`, never from `screen`: the DOM is registered
// after this module's imports are evaluated, and `screen` binds document.body
// at import time.
const { render } = await setupDom();

describe("StatusLabel", () => {
  test("축이 다르면 같은 화면에서 서로 다른 라벨로 그려진다", () => {
    const { getByText } = render(
      <>
        <StatusLabel axis="admission" state="pausing" />
        <StatusLabel axis="turn" state="running" />
      </>,
    );

    const admission = getByText("일시정지 중").closest(".ap-status");
    const turn = getByText("작업 중").closest(".ap-status");

    expect(admission?.getAttribute("data-axis")).toBe("admission");
    expect(turn?.getAttribute("data-axis")).toBe("turn");
    // Different axes must not collapse into one badge (§4.1).
    expect(admission?.getAttribute("data-tone")).toBe("caution");
    expect(turn?.getAttribute("data-tone")).toBe("progress");
    expect(admission?.querySelector("svg")?.innerHTML).not.toBe(
      turn?.querySelector("svg")?.innerHTML,
    );
  });

  test("축 이름을 스크린리더에 먼저 읽어 준다", () => {
    const { getByText } = render(
      <StatusLabel axis="receipt" state="accepted" />,
    );
    expect(getByText("접수:").className).toContain("ap-visually-hidden");
  });

  test("detail과 stale을 덧붙인다", () => {
    const { getByText } = render(
      <StatusLabel
        axis="turn"
        state="running"
        detail="2분 경과"
        stale={true}
      />,
    );

    expect(getByText("2분 경과")).toBeDefined();
    expect(getByText("갱신 지연")).toBeDefined();
    expect(
      getByText("작업 중").closest(".ap-status")?.getAttribute("data-stale"),
    ).toBe("true");
  });

  test("label을 주면 문구만 갈아끼우고 축·상태는 유지한다", () => {
    const { getByText } = render(
      <StatusLabel
        axis="admission"
        state="paused"
        label="관리자가 세웠습니다"
      />,
    );
    const label = getByText("관리자가 세웠습니다").closest(".ap-status");
    expect(label?.getAttribute("data-state")).toBe("paused");
    expect(label?.getAttribute("data-tone")).toBe("caution");
  });

  test("prefers-reduced-motion이면 스피너를 돌리지 않는다", () => {
    const restore = stubPrefersReducedMotion(true);
    try {
      const { container } = render(<StatusLabel axis="turn" state="running" />);
      const spinner = container.querySelector(".ap-status__spinner");
      expect(spinner).not.toBeNull();
      expect(spinner?.getAttribute("data-animated")).toBeNull();
    } finally {
      restore();
    }
  });

  test("모션 허용이면 스피너가 돈다", () => {
    const restore = stubPrefersReducedMotion(false);
    try {
      const { container } = render(<StatusLabel axis="turn" state="running" />);
      expect(
        container
          .querySelector(".ap-status__spinner")
          ?.getAttribute("data-animated"),
      ).toBe("true");
    } finally {
      restore();
    }
  });
});

describe("상태 어휘", () => {
  const axes = [
    ["admission", ADMISSION_STATE_VALUES],
    ["turn", TURN_STATUS_VALUES],
    ["receipt", RECEIPT_STATUS_VALUES],
    ["execution", EXECUTION_STATE_VALUES],
  ] as const;

  test("contracts가 정의한 모든 상태에 문구가 있다", () => {
    for (const [axis, values] of axes) {
      const vocabulary: Record<string, unknown> = STATUS_VOCABULARY[axis];
      expect(Object.keys(vocabulary).sort()).toEqual([...values].sort());
    }
  });

  test("모든 상태가 사람이 읽을 문구를 가진다", () => {
    for (const [axis, values] of axes) {
      for (const state of values) {
        const descriptor = describeStatus(axis, state as never);
        expect(descriptor.label.trim().length).toBeGreaterThan(0);
        // The raw enum value is never what the reader sees.
        expect(descriptor.label).not.toBe(state);
      }
    }
  });

  test("모르는 상태는 성공으로 그리지 않는다", () => {
    // A server that learns a new state must not be rendered as a success.
    const descriptor = describeStatus("turn", "teleported" as never);
    expect(descriptor.tone).toBe("unknown");
    expect(descriptor.label).toBe("teleported");
  });

  test("Object.prototype의 이름이 상태로 와도 그 자리를 지킨다", () => {
    // A plain lookup returns Object.prototype here: no label, no tone.
    for (const state of ["__proto__", "constructor", "toString"]) {
      const descriptor = describeStatus("turn", state as never);
      expect(descriptor.tone).toBe("unknown");
      expect(descriptor.label).toBe(state);
      expect(descriptor.inFlight).toBe(false);
    }
  });
});
