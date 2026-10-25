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
const { InstallationLimits } = await import("./installation-limits.tsx");
const { OperationsHead } = await import("./operations-head.tsx");
const { UsageFilters } = await import("./usage-filters.tsx");
const { UsageKpis } = await import("./usage-kpis.tsx");
const { OPERATIONS_MESSAGES } = await import("./messages.ts");

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
    expect(queryAllByRole("listitem")).toHaveLength(0);
    expect(queryAllByRole("status")).toHaveLength(0);
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

const LIMITS = {
  scope: "installation" as const,
  refreshed_at: "2026-10-24T12:40:00Z",
  limits: {
    execution_slot_limit: 10,
    queued_input_limit_per_session: 20,
    storage_limit_bytes: 10737418240,
    max_turn_seconds: 3600,
    session_cost_limit_usd: "25.00",
    session_token_limit: null,
    provider_max_retries: 3,
  },
  usage: {
    execution_slots_used: 7,
    queued_input_count: 4,
    storage: {
      used_bytes: 2147483648,
      accounted_content: ["input_messages" as const],
      updated_at: "2026-10-24T12:31:00Z",
    },
  },
};

describe("InstallationLimits", () => {
  test("한도 행마다 현재·한도를 쓰고, 토큰 한도가 null이면 '설정 안 됨'이다", () => {
    const { getByRole } = withPlatform(
      <InstallationLimits limits={LIMITS} timeZone="Asia/Seoul" />,
    );
    const rows = [
      ...getByRole("table", { name: "한도" }).querySelectorAll("[role=row]"),
    ]
      .slice(1)
      .map((row) =>
        [...row.querySelectorAll("[role=cell]")]
          .slice(0, 3)
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      ["동시 실행 slot", "7 / 10", "10"],
      ["입력 메시지 저장", "2 GB", "10 GB"],
      ["세션당 비용", "세션마다 셉니다", "$25.00"],
      ["세션당 토큰", "세션마다 셉니다", "설정 안 됨"],
      ["세션당 대기 입력", "세션마다 셉니다", "20건"],
      ["turn 최대 시간", "세션마다 셉니다", "1시간 0분"],
    ]);
    expect(document.body.textContent).toContain(
      "설치 전체에 적용됩니다 · 오후 9:40 기준",
    );
  });

  test("읽는 동안 meter 없이 한 번만 알린다", () => {
    const { queryAllByRole, getAllByRole } = withPlatform(
      <InstallationLimits limits={undefined} />,
    );
    expect(queryAllByRole("meter")).toHaveLength(0);
    expect(getAllByRole("status").map((s) => s.textContent)).toEqual([
      "한도를 읽는 중",
    ]);
  });
});

describe("UsageKpis", () => {
  const BUCKETS = [
    {
      date: "2026-10-22",
      session_count: 150,
      cost_usd: "400.00",
      cost_complete: true,
      token_count: 18160000,
      run_seconds: 100000,
    },
    {
      date: "2026-10-23",
      session_count: 250,
      cost_usd: "645.48",
      cost_complete: true,
      token_count: 20000000,
      run_seconds: 130580,
    },
  ];

  test("버킷 합을 locale 단위로 쓰고 카드마다 자기 필드의 스파크라인을 둔다", () => {
    const { getAllByRole, queryByText } = withPlatform(
      <UsageKpis buckets={BUCKETS} />,
    );
    const text = document.body.textContent ?? "";
    for (const value of ["400", "64시간 3분", "$1,045.48", "3,816만"]) {
      expect(text).toContain(value);
    }
    expect(
      getAllByRole("img").map((img) => img.getAttribute("aria-label")),
    ).toEqual([
      "일자별 세션 수",
      "일자별 실행 시간",
      "일자별 비용",
      "일자별 토큰",
    ]);
    expect(queryByText(/실제보다 적을 수 있음/)).toBeNull();
  });

  test("cost_complete=false인 날이 하나라도 있으면 비용 카드가 적을 수 있다고 말한다", () => {
    const { getByText } = withPlatform(
      <UsageKpis
        buckets={BUCKETS.map((b, i) => ({ ...b, cost_complete: i === 0 }))}
      />,
    );
    expect(getByText(/실제보다 적을 수 있음/)).toBeTruthy();
  });

  test("1센트에 못 미치는 비용은 $0.00이 아니라 <$0.01로 쓴다", () => {
    withPlatform(
      <UsageKpis
        buckets={BUCKETS.map((b) => ({ ...b, cost_usd: "0.000063" }))}
      />,
    );
    expect(document.body.textContent).toContain("<$0.01");
    expect(document.body.textContent).not.toContain("$0.00");
  });

  test("영어는 백만 단위로 줄인다", () => {
    withPlatform(<UsageKpis buckets={BUCKETS} />, "en");
    expect(document.body.textContent).toContain("38.2M");
  });

  test("읽는 동안 값과 스파크라인 없이 한 번만 알린다", () => {
    const { queryAllByRole, getAllByRole } = withPlatform(
      <UsageKpis buckets={undefined} />,
    );
    expect(queryAllByRole("img")).toHaveLength(0);
    expect(getAllByRole("status").map((s) => s.textContent)).toEqual([
      "사용량을 읽는 중",
    ]);
  });
});

describe("UsageFilters", () => {
  test("scope가 없으면 범위 선택이 없고, 기간을 누르면 그 일수를 알린다", async () => {
    const user = await setupUser();
    const picked: number[] = [];
    const { getByRole, queryByRole } = withPlatform(
      <UsageFilters days={30} onDaysChange={(days) => picked.push(days)} />,
    );
    expect(queryByRole("group", { name: "집계 범위" })).toBeNull();
    expect(queryByRole("button", { name: "설치 전체" })).toBeNull();
    await user.click(getByRole("button", { name: "90일" }));
    expect(picked).toEqual([90]);
  });

  test("scope가 있으면 내 사용량·설치 전체를 고른다", async () => {
    const user = await setupUser();
    const picked: string[] = [];
    const { getByRole } = withPlatform(
      <UsageFilters
        scope="me"
        onScopeChange={(scope) => picked.push(scope)}
        days={30}
        onDaysChange={() => {}}
      />,
    );
    await user.click(getByRole("button", { name: "설치 전체" }));
    expect(picked).toEqual(["installation"]);
  });
});

describe("OperationsHead", () => {
  test("주어진 탭만 링크로 그리고 지금 탭에 aria-current=page를 단다", () => {
    const { getAllByRole } = withPlatform(
      <OperationsHead
        tabs={["overview", "limits"]}
        current="limits"
        tabLink={(tab, label) => <a href={`/operations/${tab}`}>{label}</a>}
      />,
    );
    expect(
      getAllByRole("link").map((a) => [
        a.textContent,
        a.getAttribute("aria-current"),
      ]),
    ).toEqual([
      ["개요", null],
      ["한도", "page"],
    ]);
  });
});

describe("OPERATIONS_MESSAGES format", () => {
  test("토큰은 ko 억·만, ja 億·万, en compact로 쓴다", () => {
    expect(OPERATIONS_MESSAGES.ko.format.tokens(123_456_789)).toBe("1.2억");
    expect(OPERATIONS_MESSAGES.ja.format.tokens(38_160_000)).toBe("3,816万");
    expect(OPERATIONS_MESSAGES.en.format.tokens(9_999)).toBe("9,999");
  });
});
