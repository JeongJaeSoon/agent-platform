import { describe, expect, test } from "bun:test";
import { API_ERROR_CODE_VALUES } from "@werft-ai/contracts";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import { ERROR_GUIDANCE, guidanceFor } from "./error-guidance.ts";

const { render } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { ErrorState } = await import("@werft-ai/ui");
const { ApiErrorState } = await import("./api-error-state.tsx");

describe("ApiErrorState", () => {
  test("코드별 할 일을 원문보다 먼저 보여준다", () => {
    const { container } = render(
      <ApiErrorState code="UNAUTHORIZED" message="token expired" />,
    );
    expect(container.querySelector(".ap-state__guidance")?.textContent).toBe(
      "로그인이 만료됐습니다 — 다시 로그인하세요.",
    );
    expect(container.querySelector(".ap-state__description")?.textContent).toBe(
      "token expired",
    );
  });

  test("ErrorState에 그 코드의 할 일을 넘긴 것과 같은 마크업이다", () => {
    const api = render(
      <ApiErrorState
        code="SESSION_CLOSED"
        message="session is closed"
        retry={() => {}}
        evidenceLink={{ href: "/sessions/01J8Z5/journal" }}
      />,
    );
    const plain = render(
      <ErrorState
        guidance={ERROR_GUIDANCE.SESSION_CLOSED}
        code="SESSION_CLOSED"
        message="session is closed"
        retry={() => {}}
        evidenceLink={{ href: "/sessions/01J8Z5/journal" }}
      />,
    );
    expect(api.container.innerHTML).toBe(plain.container.innerHTML);
  });

  test("코드가 없으면 안내 줄도 없다", () => {
    const { container } = render(<ApiErrorState message="boom" />);
    expect(container.querySelector(".ap-state__guidance")).toBeNull();
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
