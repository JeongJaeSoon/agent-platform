import { describe, expect, test } from "bun:test";
import { useState } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./field.tsx";
import { Input } from "./input.tsx";
import { Textarea } from "./textarea.tsx";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { Checkbox } = await import("./checkbox.tsx");

function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `missing:${id}`);
}

describe("Field", () => {
  test("label·설명·오류를 입력과 잇는다", () => {
    const { getByRole } = render(
      <Field>
        <FieldLabel>에이전트 이름</FieldLabel>
        <Input />
        <FieldDescription>팀 안에서 겹치지 않아야 합니다.</FieldDescription>
        <FieldError>이미 쓰는 이름입니다.</FieldError>
      </Field>,
    );
    const input = getByRole("textbox", { name: "에이전트 이름" });
    expect(describedBy(input)).toEqual([
      "팀 안에서 겹치지 않아야 합니다.",
      "이미 쓰는 이름입니다.",
    ]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(getByRole("alert").textContent).toBe("이미 쓰는 이름입니다.");
  });

  test("없는 부분은 aria-describedby에 넣지 않고 오류가 없으면 invalid가 아니다", () => {
    const { getByRole } = render(
      <Field>
        <FieldLabel>설명</FieldLabel>
        <Textarea />
        <FieldError>{undefined}</FieldError>
      </Field>,
    );
    const textarea = getByRole("textbox", { name: "설명" });
    expect(textarea.hasAttribute("aria-describedby")).toBe(false);
    expect(textarea.hasAttribute("aria-invalid")).toBe(false);
  });

  test("오류가 사라지면 연결과 invalid도 걷힌다", async () => {
    function Harness() {
      const [error, setError] = useState<string | undefined>("필수입니다.");
      return (
        <>
          <Field>
            <FieldLabel>팀 이름</FieldLabel>
            <Input />
            <FieldError>{error}</FieldError>
          </Field>
          <button type="button" onClick={() => setError(undefined)}>
            고침
          </button>
        </>
      );
    }
    const { getByRole } = render(<Harness />);
    const input = getByRole("textbox", { name: "팀 이름" });
    expect(describedBy(input)).toEqual(["필수입니다."]);
    await (await setupUser()).click(getByRole("button", { name: "고침" }));
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  test("호출자가 준 id·aria-describedby는 남기고 Field의 것을 덧붙인다", () => {
    const [hintId, inputId] = ["hint", "own"];
    const { getByRole } = render(
      <>
        <p id={hintId}>공통 안내</p>
        <Field>
          <FieldLabel htmlFor={inputId}>주소</FieldLabel>
          <Input id={inputId} aria-describedby={hintId} />
          <FieldDescription>https로 시작합니다.</FieldDescription>
        </Field>
      </>,
    );
    const input = getByRole("textbox", { name: "주소" });
    expect(input.id).toBe(inputId);
    expect(describedBy(input)).toEqual(["공통 안내", "https로 시작합니다."]);
  });

  test("Field 밖의 입력은 아무것도 덧붙이지 않는다", () => {
    const { getByRole } = render(<Input aria-label="검색" />);
    const input = getByRole("textbox", { name: "검색" });
    expect(input.hasAttribute("id")).toBe(false);
    expect(input.hasAttribute("aria-describedby")).toBe(false);
  });

  test("Checkbox도 자기 Field의 label로 이름을 얻고, label을 누르면 바뀐다", async () => {
    const user = await setupUser();
    const { getByRole, getByText } = render(
      <FieldSet>
        <FieldLegend>알림</FieldLegend>
        <Field orientation="horizontal">
          <Checkbox />
          <FieldLabel>승인 요청이 오면 알립니다</FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <Checkbox defaultChecked={true} />
          <FieldLabel>세션이 끝나면 알립니다</FieldLabel>
        </Field>
      </FieldSet>,
    );
    const first = getByRole("checkbox", { name: "승인 요청이 오면 알립니다" });
    expect(
      getByRole("checkbox", { name: "세션이 끝나면 알립니다" }).id,
    ).not.toBe(first.id);
    await user.click(getByText("승인 요청이 오면 알립니다"));
    expect(first.getAttribute("aria-checked")).toBe("true");
  });
});
