import { describe, expect, test } from "bun:test";
import { ApiError } from "@werft-ai/client";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, type Locale } from "../i18n/i18n.tsx";
import { LoadFailure } from "./load-failure.tsx";

const draw = (error: unknown, locale: Locale = "ko", kept = false) =>
  renderToStaticMarkup(
    <I18nProvider locale={locale}>
      <LoadFailure error={error} kept={kept} onRetry={() => {}} />
    </I18nProvider>,
  );

describe("LoadFailure", () => {
  test("a first read leads with the code's guidance in the reader's language", () => {
    const error = new ApiError(503, "BACKEND_UNAVAILABLE", "down");
    const en = draw(error, "en");
    expect(en).toContain("Could not load this");
    expect(en).toContain("The server is unavailable — try again shortly.");
    expect(en).toContain("BACKEND_UNAVAILABLE");
    expect(en).not.toMatch(/[가-힣]/);
    expect(draw(error, "ja")).not.toMatch(/[가-힣]/);
  });

  test("a code only the web client makes keeps its own words", () => {
    const html = draw(new ApiError(0, "NETWORK_ERROR", "offline"));
    expect(html).toContain("서버에 연결하지 못했습니다");
    expect(html).not.toContain("처리하지 못했습니다");
  });

  test("with an earlier answer still shown it is an alert, not a whole state", () => {
    const html = draw(
      new ApiError(503, "BACKEND_UNAVAILABLE", "down"),
      "ko",
      true,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-variant="red"');
    expect(html).not.toContain("ap-state");
    expect(html).toContain("다시 시도");
  });
});
