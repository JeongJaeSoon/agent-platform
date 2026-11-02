import { describe, expect, test } from "bun:test";
import { createRef } from "react";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
const { Card, Section, SettingRow } = await import("../index.ts");
const { SettingsSection } = await import("./settings-section.tsx");

describe("SettingsSection", () => {
  test("제목이 섹션의 이름이고 설명·행·하단이 순서대로 온다", () => {
    const { getByRole } = render(
      <SettingsSection
        title="모델"
        titleAs="h3"
        description="에이전트가 쓰는 모델입니다."
        descriptionId="model-desc"
        rows={<SettingRow title="기본 모델" />}
        foot={<button type="button">저장</button>}
      >
        <p>본문</p>
      </SettingsSection>,
    );
    const section = getByRole("region", { name: "모델" });
    expect(getByRole("heading", { level: 3, name: "모델" })).toBeTruthy();
    expect(document.getElementById("model-desc")?.textContent).toBe(
      "에이전트가 쓰는 모델입니다.",
    );
    const text = section.textContent ?? "";
    expect(text.indexOf("본문")).toBeLessThan(text.indexOf("기본 모델"));
    expect(text.indexOf("기본 모델")).toBeLessThan(text.indexOf("저장"));
    expect(section.querySelector("form")).toBeNull();
  });

  test("onSubmit이 있으면 본문·행·하단을 검증 없는 form으로 감싼다", () => {
    let submitted = 0;
    const { getByRole } = render(
      <SettingsSection
        title="보존 기간"
        onSubmit={(event) => {
          event.preventDefault();
          submitted += 1;
        }}
        foot={<button type="submit">저장</button>}
      />,
    );
    const form = getByRole("region", { name: "보존 기간" }).querySelector(
      "form",
    );
    expect(form?.noValidate).toBe(true);
    getByRole("button", { name: "저장" }).click();
    expect(submitted).toBe(1);
  });
});

describe("Section titleProps", () => {
  test("제목에 ref와 tabIndex를 넘겨 포커스를 옮길 수 있다", () => {
    const title = createRef<HTMLHeadingElement>();
    const { getByRole } = render(
      <Section
        title="카드"
        titleProps={{ ref: title, tabIndex: -1, className: "outline-none" }}
      >
        <p>본문</p>
      </Section>,
    );
    const heading = getByRole("heading", { level: 2, name: "카드" });
    title.current?.focus();
    expect(document.activeElement === heading).toBe(true);
    expect(heading.className).toContain("outline-none");
    expect(heading.className).toContain("font-semibold");
    expect(getByRole("region", { name: "카드" })).toBeTruthy();
  });
});

describe("Card inset", () => {
  test("inset은 카드 배경 대신 muted 배경과 p-3을 쓴다", () => {
    const { container } = render(<Card variant="inset">안</Card>);
    const card = container.querySelector("[data-slot=card]");
    expect(card?.className).toContain("bg-muted/40");
    expect(card?.className).toContain("p-3");
    expect(card?.className).not.toContain("bg-card");
    expect(card?.className).not.toContain("py-4");
  });
});
