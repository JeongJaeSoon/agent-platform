import { describe, expect, test } from "bun:test";
import type { ApiClient } from "@werft-ai/client";
import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import { type ReactNode, useState } from "react";

const { render } = await setupDom();
// After setupDom: these load @werft-ai/ui (see detail-layout.test.tsx).
const { AgentPlatformProvider } = await import("../../provider.tsx");
const { Findings } = await import("./findings.tsx");
const { SessionCounts } = await import("./session-counts.tsx");
const { ToolCalls } = await import("./tool-calls.tsx");
const { ToolTable } = await import("./tool-table.tsx");

const TOOLS = [
  {
    name: "Bash",
    calls: 1840,
    failed: 21,
    total_ms: 13320000,
    median_ms: 3100,
    max_ms: 298000,
  },
  {
    name: "Edit",
    calls: 702,
    failed: 12,
    total_ms: 1620000,
    median_ms: 900,
    max_ms: 14200,
  },
  {
    name: "WebFetch",
    calls: 214,
    failed: 1,
    total_ms: 3960000,
    median_ms: 12400,
    max_ms: 61000,
  },
];

function withPlatform(node: ReactNode, locale: "ko" | "en" = "ko") {
  return render(
    <AgentPlatformProvider
      client={{} as ApiClient}
      locale={locale}
      renderLink={({ to, id, children, className }) => (
        <a href={`/${to}/${id}`} className={className}>
          {children}
        </a>
      )}
    >
      {node}
    </AgentPlatformProvider>,
  );
}

describe("ToolTable", () => {
  function Picker() {
    const [selected, setSelected] = useState("Bash");
    return (
      <ToolTable
        tools={TOOLS}
        label="도구"
        selected={selected}
        onSelect={setSelected}
      />
    );
  }

  test("키보드만으로 행을 고르고, 고른 행의 opener만 aria-pressed=true다", async () => {
    const user = await setupUser();
    const { getByRole } = withPlatform(<Picker />);
    const opener = (name: string) =>
      getByRole("button", { name: `${name} 자세히 보기` });
    expect(opener("Bash").getAttribute("aria-pressed")).toBe("true");
    await user.tab();
    await user.tab();
    expect(document.activeElement === opener("Edit")).toBe(true);
    await user.keyboard("{Enter}");
    expect(opener("Edit").getAttribute("aria-pressed")).toBe("true");
    expect(opener("Bash").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelectorAll("[aria-selected]").length).toBe(0);
  });

  test("호출·총 시간·보통·실패를 locale 형식으로 쓴다", () => {
    const { getAllByRole } = withPlatform(
      <ToolTable tools={TOOLS} label="도구" />,
    );
    const cells = getAllByRole("row")[1]?.querySelectorAll("[role=cell]");
    expect([...(cells ?? [])].slice(1).map((cell) => cell.textContent)).toEqual(
      ["1,840", "3시간 42분", "3.1초", "21"],
    );
  });
});

describe("Findings", () => {
  test("도구 이름을 문장 끝에 두고 같은 이름의 tools 행에서 숫자를 읽는다", () => {
    const { getAllByRole } = withPlatform(
      <Findings
        data={{
          tools: TOOLS,
          findings: [
            { kind: "most_time", name: "Bash" },
            { kind: "fails_often", name: "Edit" },
            { kind: "slowest", name: "WebFetch" },
          ],
        }}
      />,
    );
    expect(getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "가장 오래 걸리는 도구: Bash3시간 42분 · 전체 도구 시간의 70%",
      "자주 실패하는 도구: Edit702번 중 12번 실패 (1.7%)",
      "가장 느린 도구: WebFetch보통 12.4초 · 호출 214번",
    ]);
  });

  test("tools에 없는 이름의 finding은 그리지 않는다", () => {
    const { queryAllByRole } = withPlatform(
      <Findings
        data={{ tools: TOOLS, findings: [{ kind: "slowest", name: "Gone" }] }}
      />,
    );
    expect(queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("SessionCounts", () => {
  const link = (
    status: string,
    props: { readonly className: string; readonly children: ReactNode },
  ) => (
    <a href={`/sessions?status=${status}`} className={props.className}>
      {props.children}
    </a>
  );

  test("상태마다 세션 목록 링크이고, slots가 없으면 slot 줄이 없다", () => {
    const counts = {
      queued: 2,
      running: 7,
      needs_input: 3,
      idle: 41,
      failed: 1,
      stopped: 12,
    };
    const member = withPlatform(
      <SessionCounts counts={counts} statusLink={link} />,
    );
    expect(
      member.getAllByRole("link").map((a) => a.getAttribute("href")),
    ).toEqual([
      "/sessions?status=queued",
      "/sessions?status=running",
      "/sessions?status=needs_input",
      "/sessions?status=idle",
      "/sessions?status=failed",
      "/sessions?status=stopped",
    ]);
    expect(member.queryByRole("meter")).toBeNull();
    member.unmount();
    const owner = withPlatform(
      <SessionCounts
        counts={counts}
        slots={{ used: 7, limit: 10 }}
        statusLink={link}
      />,
    );
    expect(owner.getByRole("meter").getAttribute("aria-valuenow")).toBe("7");
    expect(owner.getByRole("status").textContent).toBe("");
  });

  test("처음 읽는 동안 slot 줄은 자리를 지키고, 상태 알림은 하나다", () => {
    const { getAllByRole, queryByRole, getByText } = withPlatform(
      <SessionCounts counts={undefined} slots={null} statusLink={link} />,
    );
    expect(getByText("동시 실행 slot · 설치 전체")).toBeTruthy();
    expect(queryByRole("meter")).toBeNull();
    expect(getAllByRole("status").map((s) => s.textContent)).toEqual([
      "세션 수를 읽는 중",
    ]);
  });

  test("화면이 알림을 맡으면 loading을 비워 상태 알림을 내지 않는다", () => {
    const { queryAllByRole } = withPlatform(
      <SessionCounts
        counts={undefined}
        slots={null}
        statusLink={link}
        messages={{ loading: "" }}
      />,
    );
    expect(queryAllByRole("status")).toHaveLength(0);
  });
});

describe("ToolTable loading", () => {
  test("읽는 중 표는 상태 알림 없이 읽는 중이라는 말을 한 번만 둔다", () => {
    const { queryAllByRole, getAllByText, getByRole } = withPlatform(
      <ToolTable tools={undefined} label="도구와 명령" onSelect={() => {}} />,
    );
    expect(queryAllByRole("status")).toHaveLength(0);
    expect(getAllByText("도구 목록을 읽는 중")).toHaveLength(1);
    expect(getByRole("table").getAttribute("aria-busy")).toBe("true");
  });

  test("읽는 중 행 수는 loadingRows이고, 도구가 오면 같은 표에 그 행이 들어온다", () => {
    const table = (tools: typeof TOOLS | undefined) => (
      <AgentPlatformProvider
        client={{} as ApiClient}
        locale="ko"
        renderLink={() => null}
      >
        <ToolTable
          tools={tools}
          label="도구와 명령"
          loadingRows={TOOLS.length + 1}
          describe={() => "셸 명령"}
        />
      </AgentPlatformProvider>
    );
    const { getAllByRole, getByRole, queryByText, rerender } = render(
      table(undefined),
    );
    const before = getByRole("table");
    // One header row, then a placeholder per row.
    expect(getAllByRole("row")).toHaveLength(TOOLS.length + 2);
    rerender(table(TOOLS));
    // toBe on DOM nodes can pass on any element in bun; compare identity.
    expect(getByRole("table") === before).toBe(true);
    expect(before.getAttribute("aria-busy")).toBeNull();
    expect(getAllByRole("row")).toHaveLength(TOOLS.length + 1);
    expect(queryByText("도구 목록을 읽는 중")).toBeNull();
  });
});

describe("ToolCalls loading", () => {
  test("읽는 중에는 loadingRows만큼 숨긴 자리표시 행을 두고 상태 알림은 내지 않는다", () => {
    const { container, queryAllByRole } = withPlatform(
      <ToolCalls calls={undefined} loadingRows={5} />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(queryAllByRole("status")).toHaveLength(0);
    expect(container.querySelector("ul")?.getAttribute("aria-busy")).toBe(
      "true",
    );
  });
});

describe("ToolCalls", () => {
  test("볼 수 없는 세션은 링크가 없고, 결과 모름은 성공으로 그리지 않는다", () => {
    const { getAllByRole, getAllByText, queryAllByRole } = withPlatform(
      <ToolCalls
        timeZone="Asia/Seoul"
        calls={[
          {
            occurred_at: "2026-10-24T12:39:10Z",
            agent: "리뷰 봇",
            session_id: "ses_05",
            title: "PR #813 리뷰",
            duration_ms: null,
            outcome: "unknown",
          },
          {
            occurred_at: "2026-10-24T12:36:41Z",
            agent: "배포 도우미",
            session_id: null,
            title: null,
            duration_ms: 41200,
            outcome: "ok",
          },
        ]}
      />,
    );
    expect(queryAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "/session/ses_05",
    ]);
    expect(getAllByText("볼 수 없는 세션")).toHaveLength(1);
    const rows = getAllByRole("listitem").map((item) => item.textContent);
    expect(rows).toEqual([
      "PR #813 리뷰리뷰 봇 · 21:39—결과 모름",
      "볼 수 없는 세션배포 도우미 · 21:3641.2초완료",
    ]);
  });
});
