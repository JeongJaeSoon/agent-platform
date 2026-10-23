import { describe, expect, mock, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";
import { Steps } from "./steps.tsx";

const { render } = await setupDom();

describe("Steps", () => {
  test("순서 있는 목록이고 끝난 항목은 기호가 아니라 글자로 읽힌다", () => {
    const { getByRole, getAllByRole } = render(
      <Steps
        completedLabel="done"
        items={[
          { id: "account", title: "연동 계정 연결", done: true },
          { id: "session", title: "첫 세션 시작", description: "할 일을 적습니다." },
        ]}
      />,
    );
    expect(getByRole("list").tagName).toBe("OL");
    const [done, todo] = getAllByRole("listitem");
    expect(done?.dataset.state).toBe("done");
    expect(todo?.dataset.state).toBe("todo");
    const mark = done?.querySelector('[aria-hidden="true"]');
    expect(mark?.textContent).toBe("✓");
    expect(done?.querySelector(".sr-only")?.textContent).toBe(", done");
    expect(todo?.querySelector('[aria-hidden="true"]')?.textContent).toBe("2");
    expect(todo?.querySelector(".sr-only")).toBeNull();
    expect(todo?.textContent).toContain("할 일을 적습니다.");
  });

  test("동작 슬롯은 행 끝에 그려지고, 동작이 없는 행도 그대로 남는다", async () => {
    const user = await setupUser();
    const onConnect = mock(() => {});
    const { getAllByRole, getByRole } = render(
      <Steps
        items={[
          {
            id: "github",
            title: "GitHub",
            action: (
              <button type="button" onClick={onConnect}>
                연결
              </button>
            ),
          },
          { id: "slack", title: "Slack" },
        ]}
      />,
    );
    const [first, second] = getAllByRole("listitem");
    expect(first?.lastElementChild?.tagName).toBe("BUTTON");
    expect(second?.querySelector("button")).toBeNull();
    expect(second?.textContent).toBe("2Slack");
    await user.click(getByRole("button", { name: "연결" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});
