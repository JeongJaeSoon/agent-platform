import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
const { Button, FormActions } = await import("../index.ts");

describe("FormActions", () => {
  test("버튼 줄을 끝으로 붙이고 좁으면 줄바꿈하며 gap-2로 띄운다", () => {
    const { container, getByRole } = render(
      <FormActions>
        <Button type="button" variant="ghost">
          취소
        </Button>
        <Button type="submit">저장</Button>
      </FormActions>,
    );
    const row = container.querySelector("[data-slot=form-actions]");
    const classes = row?.className.split(" ") ?? [];
    expect(classes).toEqual(
      expect.arrayContaining([
        "flex",
        "flex-wrap",
        "items-center",
        "justify-end",
        "gap-2",
      ]),
    );
    expect(row?.tagName).toBe("DIV");
    expect(getByRole("button", { name: "저장" }).parentElement === row).toBe(
      true,
    );
  });

  test("호출자 className이 같은 축의 기본값을 이긴다", () => {
    const { container } = render(
      <FormActions className="items-start" id="save-actions">
        <Button type="submit">저장</Button>
      </FormActions>,
    );
    const row = container.querySelector("[data-slot=form-actions]");
    const classes = row?.className.split(" ") ?? [];
    expect(classes).toContain("items-start");
    expect(classes).not.toContain("items-center");
    expect(row?.id).toBe("save-actions");
  });
});
