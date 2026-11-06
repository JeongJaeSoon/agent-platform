import { expect, test } from "bun:test";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import { I18nProvider } from "../i18n/i18n.tsx";
import { SessionWorkspaceLimit } from "./session-workspace-limit.tsx";

const { render } = await setupDom();

test.each([
  ["ko", "Workspace 상한 · 바이트 하드 · inode 소프트"],
  ["en", "Workspace limits · bytes Hard · inodes Soft"],
  ["ja", "Workspace 上限 · バイト ハード · inode ソフト"],
] as const)("axis classifications are read only in %s", (locale, line) => {
  const screen = render(
    <I18nProvider locale={locale}>
      <SessionWorkspaceLimit
        mode={{
          bytes: "hard",
          inodes: "soft",
          reason: "local_quota_preflight",
        }}
      />
    </I18nProvider>,
  );
  expect(screen.getByText(line)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test("an old server or worker without a classification reads as unknown", () => {
  const screen = render(
    <I18nProvider locale="ko">
      <SessionWorkspaceLimit mode={undefined} />
    </I18nProvider>,
  );
  expect(
    screen.getByText("Workspace 상한 · 바이트 미확인 · inode 미확인"),
  ).toBeTruthy();
});
