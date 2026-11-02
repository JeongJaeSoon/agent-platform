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
          {
            id: "session",
            title: "첫 세션 시작",
            description: "할 일을 적습니다.",
          },
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

describe("Steps 세 상태", () => {
  test("state가 done·todo·unknown을 받고 done boolean보다 앞선다", () => {
    const { getAllByRole } = render(
      <Steps
        completedLabel="완료"
        todoLabel="할 일"
        unknownLabel="확인할 수 없음"
        items={[
          { id: "a", title: "자격 증명", state: "done" },
          { id: "b", title: "릴리스", state: "todo", done: true },
          {
            id: "c",
            title: "활성화",
            description: "연결 상태를 불러오지 못했습니다.",
            state: "unknown",
          },
          { id: "d", title: "알림", state: "unknown" },
        ]}
      />,
    );
    const [done, todo, unknown, bare] = getAllByRole("listitem");
    expect(done?.dataset.state).toBe("done");
    expect(todo?.dataset.state).toBe("todo");
    expect(unknown?.dataset.state).toBe("unknown");
    expect(done?.querySelector(".sr-only")?.textContent).toBe(", 완료");
    expect(todo?.querySelector(".sr-only")?.textContent).toBe(", 할 일");
    // The circle is not read; the state is, once, after the title.
    expect(unknown?.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "?",
    );
    expect(
      unknown?.querySelector('[aria-hidden="true"]')?.getAttribute("title"),
    ).toBe("확인할 수 없음");
    expect(unknown?.querySelector(".sr-only")?.textContent).toBe(
      ", 확인할 수 없음",
    );
    // On screen it follows the description, hidden from the reader.
    expect(unknown?.textContent).toContain(
      "연결 상태를 불러오지 못했습니다. · 확인할 수 없음",
    );
    const visible = [
      ...(unknown?.querySelectorAll('[aria-hidden="true"]') ?? []),
    ];
    expect(visible.at(-1)?.textContent).toBe(" · 확인할 수 없음");
    // With no description the label stands alone on the line.
    expect(
      [...(bare?.querySelectorAll('[aria-hidden="true"]') ?? [])].at(-1)
        ?.textContent,
    ).toBe("확인할 수 없음");
  });

  test("기본 문구는 한국어이고 todo는 이름이 없으면 읽지 않는다", () => {
    const { getAllByRole } = render(
      <Steps
        items={[
          { id: "a", title: "A", state: "unknown" },
          { id: "b", title: "B" },
        ]}
      />,
    );
    const [unknown, todo] = getAllByRole("listitem");
    expect(unknown?.querySelector(".sr-only")?.textContent).toBe(
      ", 확인할 수 없음",
    );
    expect(todo?.querySelector(".sr-only")).toBeNull();
  });
});
