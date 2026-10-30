import { describe, expect, test } from "bun:test";
import type {
  ListSessionOutputsResponse,
  SessionDetail,
  SessionGitHubAttribution,
  SessionGitHubRefusal,
  SessionOutcome,
  SessionUsageResponse,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

async function openOutputs() {
  await (await setupUser()).click(
    await screen.findByRole("tab", { name: /^결과물/ }),
  );
}

const SESSION_ID = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const AT = "2026-10-11T08:14:02.000Z";
const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const detail = {
  id: SESSION_ID,
  revision: 3,
  admission_state: "active",
  status: "idle",
  runtime: null,
  repository_id: "demo",
  current_turn_id: "1",
  queued_turn_count: 0,
  model: null,
  last_event_at: AT,
  created_at: AT,
  updated_at: AT,
  execution: null,
  checkpoint_revision: 2,
  pending_request_count: 0,
  attention: null,
  durability: {
    last_transcript_persisted_at: AT,
    checkpoint_committed_at: AT,
    checkpoint_revision: 2,
    last_completed_turn_id: "1",
    last_checkpointed_turn_id: "1",
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
} as SessionDetail;

const outputs: ListSessionOutputsResponse = {
  session_id: SESSION_ID,
  checkpoint_revision: 2,
  items: [
    { path: "out/report.md", bytes: 2048, sha256: SHA, omitted: null },
    {
      path: "out/sub/보고서 (최종).csv",
      bytes: 12,
      sha256: SHA,
      omitted: null,
    },
    {
      path: "out/video.mp4",
      bytes: 734_003_200,
      sha256: null,
      omitted: "too_large",
    },
  ],
};

function routes(answer: () => Response) {
  return {
    "GET /v1/auth/me": () => json(200, me()),
    "GET /v1/profiles": () => json(200, { items: [] }),
    [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, detail),
    [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
      json(200, { answerable: true, items: [] }),
    [`GET /v1/sessions/${SESSION_ID}/outputs`]: answer,
    // Held open until the screen lets go, so it does not reconnect.
    [`GET /v1/sessions/${SESSION_ID}/events`]: (request: Request) =>
      new Promise<Response>((_, reject) =>
        request.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      ),
  };
}

describe("session outputs", () => {
  test("lists each file with its size and a download link; a file too large to keep has none", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() => json(200, outputs)),
    );
    // The tab counts them once read.
    expect(
      (await screen.findByRole("tab", { name: /^결과물/ })).textContent,
    ).toBe("결과물");
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^결과물/ }).textContent).toBe(
        "결과물3",
      ),
    );
    await openOutputs();
    const section = await screen.findByRole("region", { name: "out/ 파일" });
    expect(section.textContent).toContain("report.md");
    expect(section.textContent).toContain("2kB");
    expect(section.textContent).toContain("video.mp4");
    expect(section.textContent).toContain("너무 커서 보관하지 않음");
    expect(screen.queryByText(/out\/ 폴더에 남긴 파일을 셉니다/)).toBeNull();

    const report = screen.getByRole("link", { name: "report.md 내려받기" });
    expect(report.getAttribute("href")).toBe(
      `/v1/sessions/${SESSION_ID}/outputs/out%2Freport.md`,
    );
    expect(report.getAttribute("download")).toBe("report.md");
    // The name a sighted user sees on hover or focus is the Tooltip's.
    expect(report.hasAttribute("title")).toBe(false);
    act(() => report.focus());
    await waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        "report.md 내려받기",
      ),
    );
    const nested = screen.getByRole("link", {
      name: "sub/보고서 (최종).csv 내려받기",
    });
    expect(nested.getAttribute("href")).toBe(
      `/v1/sessions/${SESSION_ID}/outputs/${encodeURIComponent("out/sub/보고서 (최종).csv")}`,
    );
    expect(nested.getAttribute("download")).toBe("보고서 (최종).csv");
    expect(
      screen.queryByRole("link", { name: "video.mp4 내려받기" }),
    ).toBeNull();

    // A link, so the keyboard reaches it.
    report.focus();
    expect(document.activeElement === report).toBe(true);
  });

  test("says so while the session has no outputs", async () => {
    const { api } = renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() =>
        json(200, {
          session_id: SESSION_ID,
          checkpoint_revision: null,
          items: [],
        }),
      ),
    );
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.path === `/v1/sessions/${SESSION_ID}/outputs`,
        ),
      ).toBe(true),
    );
    await openOutputs();
    expect(await screen.findByText("아직 결과물이 없습니다.")).toBeTruthy();
    // Says what counts, so a session that only edited its repository is not a surprise.
    expect(
      screen.getByText(
        "결과물은 이 세션이 연 GitHub PR과 작업 공간의 out/ 폴더에 남긴 파일을 셉니다. 저장소 파일을 고친 내역은 진행 탭의 도구 호출에서 볼 수 있습니다.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "out/ 파일" })).toBeNull();
  });

  test("a session that never checkpointed is not asked for outputs", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...routes(() => json(200, outputs)),
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, checkpoint_revision: null }),
    });
    await screen.findByRole("heading", {
      name: new RegExp(`^${SESSION_ID.slice(0, 8)}`),
    });
    expect(
      api.calls.some(
        (call) => call.path === `/v1/sessions/${SESSION_ID}/outputs`,
      ),
    ).toBe(false);
  });

  test("a list that cannot be read says so and offers to ask again", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() => apiError(409, "CHECKPOINT_UNAVAILABLE", "manifest damaged")),
    );
    await openOutputs();
    expect(
      await screen.findByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
    expect(screen.queryByText(/out\/ 폴더에 남긴 파일을 셉니다/)).toBeNull();
  });
});

describe("session GitHub attribution", () => {
  const ATTRIBUTION = `/v1/sessions/${SESSION_ID}/github/attribution`;
  const withRepository = {
    ...detail,
    repository: { id: "demo", full_name: "acme/demo", branch: "main" },
  };
  function attributed(answer: SessionGitHubAttribution) {
    return {
      ...routes(() => json(200, outputs)),
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, withRepository),
      [`GET ${ATTRIBUTION}`]: () => json(200, answer),
    };
  }

  test("names the linked starter as the commits' co-author", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      attributed({
        trigger: "web",
        attribution: "co_author",
        login: "octocat",
      }),
    );
    await openOutputs();
    expect(
      await screen.findByText("commit 공동 작성자: octocat"),
    ).toBeDefined();
  });

  test("an unlinked starter is pointed at linked accounts", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      attributed({ trigger: "slack", attribution: "unlinked", login: null }),
    );
    await openOutputs();
    expect(
      await screen.findByText(/GitHub 계정이 연결되지 않아/),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: "연동 계정" }).getAttribute("href"),
    ).toBe("/settings/linked-accounts");
  });

  test("a session no person started says the App alone signs", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      attributed({
        trigger: "agent_key",
        attribution: "app_only",
        login: null,
      }),
    );
    await openOutputs();
    expect(
      await screen.findByText(
        "시작한 사람이 없는 세션이라 commit은 App 이름으로만 남습니다.",
      ),
    ).toBeDefined();
  });

  test("a session without a repository is not asked", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...attributed({ trigger: "web", attribution: "co_author", login: "x" }),
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, repository: null }),
    });
    await openOutputs();
    await screen.findByRole("region", { name: "out/ 파일" });
    expect(api.calls.some((call) => call.path === ATTRIBUTION)).toBe(false);
    // Nor for pull requests or refusals: only a repository has them.
    expect(
      api.calls.some(
        (call) =>
          call.path === `/v1/sessions/${SESSION_ID}/outcomes` ||
          call.path === `/v1/sessions/${SESSION_ID}/github/refusals`,
      ),
    ).toBe(false);
  });
});

describe("the session's GitHub pull requests", () => {
  const withRepository = {
    ...detail,
    repository: { id: "demo", full_name: "acme/demo", branch: "main" },
  };
  const pull = (
    number: number,
    fields: Partial<SessionOutcome>,
  ): SessionOutcome => ({
    id: `019a0000-0000-7000-8000-00000000000${number}`,
    type: "github_pull_request",
    url: `https://github.com/acme/demo/pull/${number}`,
    repository_id: "demo",
    external_id: String(number),
    state: "open",
    state_changed_at: AT,
    merged_at: null,
    closed_at: null,
    state_checked_at: AT,
    check_error: null,
    metadata: {
      head: `agent/${SESSION_ID}`,
      base: "main",
      adopted: false,
      merge_commit_sha: null,
      additions: null,
      deletions: null,
      changed_files: null,
      commits: null,
    },
    created_at: AT,
    ...fields,
  });
  const pulls = [
    pull(1, {}),
    pull(2, { state: "merged", merged_at: AT, closed_at: AT }),
    pull(3, { state: "closed", closed_at: AT, check_error: "not_found" }),
  ];
  const usage: SessionUsageResponse = {
    session_id: SESSION_ID,
    period: "session_lifetime",
    refreshed_at: AT,
    cost: {
      amount_usd: "0.250000",
      kind: "estimated",
      source: "provider_usage",
      completeness_scope: "turn_reports",
      complete: true,
      reported_turn_count: 1,
      unreported_turn_count: 0,
      open_turn_count: 0,
    },
    cost_limit_usd: "25",
    token_count: 12345,
    token_limit: null,
    budget_exceeded: false,
    queued_input_count: 0,
    queued_input_limit: 10,
  };
  function pulled(
    items: SessionOutcome[],
    files: ListSessionOutputsResponse = outputs,
    refusals: SessionGitHubRefusal[] = [],
  ) {
    return {
      ...routes(() => json(200, files)),
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, withRepository),
      [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () => json(200, { items }),
      [`GET /v1/sessions/${SESSION_ID}/usage`]: () => json(200, usage),
      [`GET /v1/sessions/${SESSION_ID}/github/refusals`]: () =>
        json(200, { items: refusals }),
    };
  }
  const noFiles = { session_id: SESSION_ID, checkpoint_revision: 2, items: [] };

  test("each pull request links out with its state, when it ended and when it was checked; the session's tokens and cost sit below", async () => {
    renderAt(`/sessions/${SESSION_ID}`, pulled(pulls));
    // Three pull requests and three files.
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^결과물/ }).textContent).toBe(
        "결과물6",
      ),
    );
    await openOutputs();
    const area = await screen.findByRole("region", { name: "GitHub PR" });
    const rows = within(area).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("a")?.textContent)).toEqual([
      "acme/demo#1",
      "acme/demo#2",
      "acme/demo#3",
    ]);
    const link = within(area).getByRole("link", { name: "acme/demo#2" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/demo/pull/2",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^acme\/demo#1열림상태 확인 /),
      expect.stringMatching(/^acme\/demo#2머지됨머지 .+ · 상태 확인 /),
      expect.stringMatching(/^acme\/demo#3닫힘닫음 .+ · 상태 확인 /),
    ]);
    expect(rows[0]?.textContent).not.toContain("마지막 확인");
    expect(rows[2]?.textContent).toContain(
      "마지막 확인에서 GitHub가 이 PR을 찾지 못했습니다. 상태는 그 전에 확인한 값입니다.",
    );
    expect(
      await within(area).findByText(
        /^이 세션이 쓴 토큰 12,345 · 추정 비용 \$0\.25/,
      ),
    ).toBeTruthy();
    // The files follow, and no empty state.
    expect(screen.getByRole("region", { name: "out/ 파일" })).toBeTruthy();
    expect(screen.queryAllByText("아직 결과물이 없습니다.")).toHaveLength(0);
  });

  // GitHub merges a pull request after the session stopped and no session
  // event says so: an open tab reads both lists again each refresher minute.
  test("an open tab reads its pull requests and refusals again every minute", async () => {
    const { services } = renderAt(`/sessions/${SESSION_ID}`, pulled(pulls));
    await openOutputs();
    await screen.findByRole("region", { name: "GitHub PR" });
    const intervals = (path: string) =>
      services.queryClient
        .getQueryCache()
        .findAll()
        .filter((query) => query.queryKey.at(-1) === path)
        .flatMap((query) =>
          query.observers.map((observer) => observer.options.refetchInterval),
        );
    expect(intervals("outcomes")).not.toHaveLength(0);
    expect(new Set(intervals("outcomes"))).toEqual(new Set([60_000]));
    expect(intervals("github-refusals")).toEqual([60_000]);
  });

  test("a pull request not checked yet says so", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      pulled([pull(4, { state_checked_at: null })]),
    );
    await openOutputs();
    const area = await screen.findByRole("region", { name: "GitHub PR" });
    expect(area.textContent).toContain("아직 상태를 확인하지 않음");
  });

  test("pull requests without files count alone and show no empty state", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      pulled([pulls[0] as SessionOutcome], noFiles),
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^결과물/ }).textContent).toBe(
        "결과물1",
      ),
    );
    await openOutputs();
    expect(
      await screen.findByRole("region", { name: "GitHub PR" }),
    ).toBeTruthy();
    expect(screen.queryAllByRole("region", { name: "out/ 파일" })).toHaveLength(
      0,
    );
    expect(screen.queryAllByText("아직 결과물이 없습니다.")).toHaveLength(0);
  });

  test("with neither pull requests nor files the tab says it is empty", async () => {
    renderAt(`/sessions/${SESSION_ID}`, pulled([], noFiles));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^결과물/ }).textContent).toBe(
        "결과물0",
      ),
    );
    await openOutputs();
    expect(await screen.findByText("아직 결과물이 없습니다.")).toBeTruthy();
    expect(screen.queryAllByRole("region", { name: "GitHub PR" })).toHaveLength(
      0,
    );
  });

  test("pull requests that cannot be read are not taken for none", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...pulled([], noFiles),
      [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () =>
        apiError(500, "INTERNAL", "boom"),
    });
    await openOutputs();
    expect(
      await screen.findByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
    expect(screen.queryAllByText("아직 결과물이 없습니다.")).toHaveLength(0);
  });

  test("a read that fails after an empty one is not taken for none either", async () => {
    let failing = false;
    const { services } = renderAt(`/sessions/${SESSION_ID}`, {
      ...pulled([], noFiles),
      [`GET /v1/sessions/${SESSION_ID}/outcomes`]: () =>
        failing ? apiError(500, "INTERNAL", "boom") : json(200, { items: [] }),
    });
    await openOutputs();
    expect(await screen.findByText("아직 결과물이 없습니다.")).toBeTruthy();
    failing = true;
    await act(() =>
      services.queryClient.refetchQueries({
        predicate: (query) => query.queryKey.at(-1) === "outcomes",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
    expect(screen.queryAllByText("아직 결과물이 없습니다.")).toHaveLength(0);
  });

  test("recent GitHub refusals name the reason, the work and when", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      pulled([], outputs, [
        {
          receipt_id: "019a0000-0000-7000-8000-0000000000b1",
          operation: "mint_github_token",
          purpose: "push",
          reason_code: "github_disabled",
          created_at: AT,
        },
        {
          receipt_id: "019a0000-0000-7000-8000-0000000000b2",
          operation: "dispatch_workflow",
          purpose: "dispatch",
          reason_code: "workflow_not_allowed",
          created_at: AT,
        },
      ]),
    );
    await openOutputs();
    const refusals = await screen.findByRole("region", {
      name: "최근 GitHub 거절",
    });
    const rows = within(refusals).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^GitHub 사용 꺼짐push · /),
      expect.stringMatching(/^허용 목록 밖워크플로 실행 · /),
    ]);
    expect(rows[0]?.querySelector("time")?.getAttribute("datetime")).toBe(AT);
  });
});
