import { describe, expect, test } from "bun:test";
import { Lock } from "lucide-react";
import { createRef } from "react";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
const { Alert, AlertActions, AlertDescription, AlertTitle } = await import(
  "./alert.tsx"
);

function iconOf(root: Element): Element | null {
  return root.querySelector("[data-slot='alert-icon']");
}

describe("Alert", () => {
  test("기본 role이 없어 화면을 열 때 읽히지 않는다", () => {
    const { container, queryByRole } = render(
      <Alert>
        <AlertTitle>키 안내</AlertTitle>
        <AlertDescription>
          키는 만든 사람의 권한을 넘지 않습니다.
        </AlertDescription>
      </Alert>,
    );
    expect(queryByRole("alert")).toBeNull();
    expect(queryByRole("status")).toBeNull();
    const root = container.querySelector("[data-slot='alert']");
    expect(root?.tagName).toBe("DIV");
    expect(root?.hasAttribute("role")).toBe(false);
  });

  test("호출자가 준 role이 그대로 붙는다", () => {
    const { getByRole } = render(
      <Alert variant="red" role="alert">
        <AlertTitle>기본 모델을 쓸 수 없습니다</AlertTitle>
      </Alert>,
    );
    const alert = getByRole("alert");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert.textContent).toBe("기본 모델을 쓸 수 없습니다");
  });

  test("variant마다 기본 아이콘이 다르고 aria-hidden이다", () => {
    const expected = {
      default: "lucide-info",
      blue: "lucide-info",
      amber: "lucide-triangle-alert",
      red: "lucide-circle-alert",
    } as const;
    for (const [variant, iconClass] of Object.entries(expected)) {
      const { container } = render(
        <Alert variant={variant as keyof typeof expected}>본문</Alert>,
      );
      const icon = iconOf(container);
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      const svg = icon?.querySelector("svg");
      expect(svg?.classList.contains(iconClass)).toBe(true);
      expect(svg?.getAttribute("stroke-width")).toBe("1.5");
    }
  });

  test("icon을 주면 그것을, null이면 아이콘 없이 그린다", () => {
    const custom = render(<Alert icon={<Lock />}>답할 수 없습니다</Alert>);
    const svg = iconOf(custom.container)?.querySelector("svg");
    expect(svg?.classList.contains("lucide-lock")).toBe(true);

    const none = render(<Alert icon={null}>아이콘 없음</Alert>);
    expect(iconOf(none.container)).toBeNull();
    expect(none.container.querySelector("svg")).toBeNull();
  });

  test("동작 자리는 본문 칸 안, 제목·본문 뒤에 놓인다", () => {
    const { container, getByRole } = render(
      <Alert variant="amber">
        <AlertTitle>새 키</AlertTitle>
        <AlertDescription>지금 복사해 두세요.</AlertDescription>
        <AlertActions>
          <button type="button">복사</button>
        </AlertActions>
      </Alert>,
    );
    const content = container.querySelector("[data-slot='alert-content']");
    const slots = [...(content?.children ?? [])].map((child) =>
      child.getAttribute("data-slot"),
    );
    expect(slots).toEqual([
      "alert-title",
      "alert-description",
      "alert-actions",
    ]);
    expect(
      getByRole("button", { name: "복사" }).parentElement?.getAttribute(
        "data-slot",
      ),
    ).toBe("alert-actions");
  });

  test("asChild면 넘긴 요소가 상자가 되고 그 안에 아이콘과 본문 칸이 든다", () => {
    const ref = createRef<HTMLOutputElement>();
    const { getByRole } = render(
      <Alert asChild variant="blue">
        <output ref={ref}>설정을 저장했습니다.</output>
      </Alert>,
    );
    const status = getByRole("status");
    expect(status.tagName).toBe("OUTPUT");
    expect(ref.current === status).toBe(true);
    expect(status.getAttribute("data-slot")).toBe("alert");
    expect(status.getAttribute("data-variant")).toBe("blue");
    expect(
      [...status.children].map((c) => c.getAttribute("data-slot")),
    ).toEqual(["alert-icon", "alert-content"]);
    expect(
      status.querySelector("[data-slot='alert-content']")?.textContent,
    ).toBe("설정을 저장했습니다.");
  });

  test("AlertTitle asChild는 제목 요소를 바꾼다", () => {
    const { getByRole } = render(
      <Alert asChild variant="amber" role="alert">
        <section>
          <AlertTitle asChild>
            <h3>연결이 끊겼습니다</h3>
          </AlertTitle>
        </section>
      </Alert>,
    );
    const alert = getByRole("alert");
    expect(alert.tagName).toBe("SECTION");
    const heading = getByRole("heading", { level: 3 });
    expect(heading.getAttribute("data-slot")).toBe("alert-title");
  });
});
