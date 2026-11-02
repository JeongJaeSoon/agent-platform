import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OutcomeLine } from "./outcome.tsx";

describe("OutcomeLine", () => {
  test("an error is an alert and a notice is a status", () => {
    const error = renderToStaticMarkup(
      <OutcomeLine outcome={{ kind: "error", text: "실패" }} />,
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain("text-destructive");
    expect(error).toContain(">실패<");
    expect(error).not.toContain("<output");

    const notice = renderToStaticMarkup(
      <OutcomeLine outcome={{ kind: "notice", text: "완료" }} />,
    );
    expect(notice).toContain("<output");
    expect(notice).toContain("완료");
    expect(notice).not.toContain('role="alert"');
  });

  test("nothing to say renders nothing unless the notice region stays live", () => {
    expect(renderToStaticMarkup(<OutcomeLine outcome={null} />)).toBe("");
    const live = renderToStaticMarkup(<OutcomeLine outcome={null} live />);
    expect(live).toContain("<output");
    expect(live).toContain("sr-only");
    const error = renderToStaticMarkup(
      <OutcomeLine outcome={{ kind: "error", text: "실패" }} live />,
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain("<output");
  });
});
