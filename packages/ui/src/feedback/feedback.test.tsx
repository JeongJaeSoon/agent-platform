import { describe, expect, test } from "bun:test";
import { API_ERROR_CODE_VALUES } from "@agent-platform/contracts";

import { setupDom, stubPrefersReducedMotion } from "../test-support/dom.ts";
import { htmlOf } from "../test-support/html.ts";
import { EmptyState } from "./empty-state.tsx";
import { ERROR_GUIDANCE, guidanceFor } from "./error-guidance.ts";
import { ErrorState } from "./error-state.tsx";
import { Skeleton } from "./skeleton.tsx";

const { render } = await setupDom();

describe("EmptyState", () => {
  test("제목·설명·두 동작을 그린다", () => {
    const { container, getByText } = render(
      <EmptyState
        title="아직 세션이 없습니다"
        description="첫 지시를 보내면 여기에 쌓입니다."
        action={<button type="button">새 세션</button>}
        secondaryAction={<button type="button">에이전트 보기</button>}
      />,
    );

    expect(getByText("아직 세션이 없습니다")).toBeDefined();
    expect(
      container.querySelectorAll(".ap-state__actions button"),
    ).toHaveLength(2);
    expect(htmlOf(container.firstElementChild)).toMatchSnapshot();
  });

  test("조용하다 — alert로 읽히지 않는다", () => {
    const { container } = render(<EmptyState title="비어 있습니다" />);
    expect(container.querySelector("[role='alert']")).toBeNull();
  });
});

describe("ErrorState", () => {
  test("EmptyState와 다른 모양·다른 역할로 그려진다", () => {
    const empty = render(<EmptyState title="비어 있습니다" />);
    const error = render(<ErrorState message="boom" code="INTERNAL_ERROR" />);

    const emptyRoot = empty.container.querySelector(".ap-state");
    const errorRoot = error.container.querySelector(".ap-state");

    expect(emptyRoot?.className).toContain("ap-state--empty");
    expect(errorRoot?.className).toContain("ap-state--error");
    expect(emptyRoot?.className).not.toContain("ap-state--error");
    expect(errorRoot?.getAttribute("role")).toBe("alert");
    expect(errorRoot?.querySelector(".ap-state__mark")).not.toBeNull();
    expect(emptyRoot?.querySelector(".ap-state__mark")).toBeNull();
    expect(htmlOf(errorRoot)).toMatchSnapshot();
  });

  test("코드별 할 일을 원문보다 먼저 보여준다", () => {
    const { container } = render(
      <ErrorState code="UNAUTHORIZED" message="token expired" />,
    );
    expect(container.querySelector(".ap-state__guidance")?.textContent).toBe(
      "로그인이 만료됐습니다 — 다시 로그인하세요.",
    );
    expect(container.querySelector(".ap-state__description")?.textContent).toBe(
      "token expired",
    );
  });

  test("retry와 증거 링크를 준 만큼만 그린다", () => {
    const calls: string[] = [];
    const { container } = render(
      <ErrorState
        code="BACKEND_UNAVAILABLE"
        retry={() => calls.push("retry")}
        evidenceLink={{ href: "/journal/1", label: "실행 기록" }}
      />,
    );

    const button = container.querySelector("button");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls).toEqual(["retry"]);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/journal/1",
    );
  });

  test("retry가 없으면 버튼도 없다", () => {
    const { container } = render(<ErrorState code="FORBIDDEN" />);
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("오류 문구", () => {
  test("contracts의 모든 error code에 할 일이 있다", () => {
    expect(Object.keys(ERROR_GUIDANCE).sort()).toEqual(
      [...API_ERROR_CODE_VALUES].sort(),
    );
  });

  test("모르는 코드도 영문 원문 대신 할 일로 말한다", () => {
    expect(guidanceFor("SOMETHING_NEW")).toBe(
      "처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
    );
    expect(guidanceFor(undefined)).toBeUndefined();
  });

  test("Object.prototype의 이름을 코드로 받아도 문자열만 돌려준다", () => {
    // A plain lookup hands these back as objects, and React throws on render.
    for (const code of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(guidanceFor(code)).toBe(
        "처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
      );
    }
  });
});

describe("Skeleton", () => {
  test("줄 수만큼 막대를 만든다", () => {
    const { container } = render(<Skeleton lines={3} />);
    expect(container.querySelectorAll(".ap-skeleton__bar")).toHaveLength(3);
    expect(htmlOf(container.firstElementChild)).toMatchSnapshot();
  });

  test("text가 아니면 막대는 하나다", () => {
    const { container } = render(<Skeleton shape="circle" lines={5} />);
    expect(container.querySelectorAll(".ap-skeleton__bar")).toHaveLength(1);
  });

  test("읽는 사람에게 로딩 중임을 알린다", () => {
    const { container } = render(<Skeleton />);
    const root = container.querySelector(".ap-skeleton");
    // <output> is role="status" without spelling it out.
    expect(root?.tagName).toBe("OUTPUT");
    expect(root?.getAttribute("aria-busy")).toBe("true");
    expect(root?.textContent).toContain("불러오는 중");
  });

  test("prefers-reduced-motion이면 깜빡이지 않는다", () => {
    const restore = stubPrefersReducedMotion(true);
    try {
      const { container } = render(<Skeleton />);
      expect(
        container.querySelector(".ap-skeleton")?.getAttribute("data-animated"),
      ).toBeNull();
    } finally {
      restore();
    }
  });
});
