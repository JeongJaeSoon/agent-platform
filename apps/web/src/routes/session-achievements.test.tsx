import { describe, expect, test } from "bun:test";
import type {
  ListSessionAchievementsResponse,
  SessionAchievement,
  SessionDetail,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { agentServer } from "../test-support/fake-agents.ts";
import { apiError, json, me, RECEIPT_ID } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const SESSION_ID = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const AGENT_ID = "5a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const RULE_ID = "7d3a4e5f-6b7c-4d8e-8f9a-1b2c3d4e5f60";
const TYPE_ID = "9f5c6a7b-8d9e-4f0a-8b1c-3d4e5f6a7b82";
const JUDGMENT_ID = "1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f";
const AT = "2026-11-02T01:02:00.000Z";
const ACHIEVEMENTS = `/v1/sessions/${SESSION_ID}/achievements`;

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
  checkpoint_revision: null,
  pending_request_count: 0,
  attention: null,
  durability: {
    last_transcript_persisted_at: AT,
    checkpoint_committed_at: AT,
    checkpoint_revision: null,
    last_completed_turn_id: "1",
    last_checkpointed_turn_id: "1",
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
} as SessionDetail;

const PR_URL = "https://github.com/acme/shop/pull/412";

function achievement(
  id: string,
  overrides: Partial<SessionAchievement>,
): SessionAchievement {
  return {
    id,
    session_id: SESSION_ID,
    agent_id: AGENT_ID,
    agent_release_id: null,
    rule_id: RULE_ID,
    rule_family_id: RULE_ID,
    type_id: TYPE_ID,
    title: "acme/shop#412",
    link: PR_URL,
    evidence_kind: "github_pull_request",
    evidence_id: "6c1f5b0e-2d7a-4e8b-9f3c-1a2b3c4d5e6f",
    payload: null,
    judge: "luna",
    rule_title: "머지된 PR",
    rule_version: 2,
    type_key: "pull_request",
    probability: 0.99,
    judgment_id: JUDGMENT_ID,
    review_state: "auto",
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    created_at: AT,
    ...overrides,
  };
}

const MERGED = achievement("0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d41", {});
const DOCUMENT = achievement("0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d42", {
  title: "out/payment-retry.md",
  link: `/sessions/${SESSION_ID}`,
  evidence_kind: "out_file",
  evidence_id: "out/payment-retry.md",
  payload: { path: "out/payment-retry.md", size: 4198 },
  rule_title: "설계 문서 작성",
  rule_version: 3,
  type_key: "document",
  probability: 0.91,
  review_state: "needs_review",
});
const REVIEW = achievement("0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d43", {
  title: "acme/shop#398",
  link: "https://github.com/acme/shop/pull/398#pullrequestreview-1",
  evidence_kind: "github_review",
  judge: "always",
  probability: null,
  rule_title: "코드 리뷰 제출",
  rule_version: 1,
  type_key: "code_review",
  review_state: "rejected",
});

const listed: ListSessionAchievementsResponse = {
  items: [MERGED, DOCUMENT, REVIEW],
  judgment: {
    id: JUDGMENT_ID,
    trigger: "evidence",
    status: "succeeded",
    error_code: null,
    created_at: AT,
    finished_at: AT,
  },
  judgment_count: 2,
  judge_cost_usd: 0.0005,
  threshold: 0.9,
};

function routes(
  answer: () => Response,
  who: ReturnType<typeof me> = me(),
  extra: Record<string, (request: Request) => Response> = {},
) {
  return {
    "GET /v1/auth/me": () => json(200, who),
    "GET /v1/profiles": () => json(200, { items: [] }),
    [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, detail),
    [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
      json(200, { answerable: true, items: [] }),
    [`GET ${ACHIEVEMENTS}`]: answer,
    "GET /v1/administered-agents": () => json(200, { items: [] }),
    [`GET /v1/sessions/${SESSION_ID}/events`]: (request: Request) =>
      new Promise<Response>((_, reject) =>
        request.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      ),
    ...extra,
  };
}

async function openCard() {
  await (await setupUser()).click(
    await screen.findByRole("tab", { name: /^결과물/ }),
  );
  return screen.findByRole("region", { name: /^성과/ });
}

describe("session achievements", () => {
  test("shows each achievement's state, rule and type, probability, evidence and judge, then the judgment line", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() => json(200, listed)),
    );
    const card = await openCard();
    expect(within(card).getByRole("heading", { level: 2 }).textContent).toBe(
      "성과 3",
    );
    expect(card.textContent).toContain(
      "워크스페이스 성과 규칙으로 판정한 것입니다. PR·리뷰가 근거인 성과는 바로 집계되고, out/ 파일이나 대화가 근거인 성과는 확인해야 집계됩니다.",
    );
    const [merged, document_, review, line] =
      within(card).getAllByRole("listitem");
    expect(merged?.textContent).toContain("집계됨머지된 PRpull_request");
    expect(merged?.textContent).toContain("정의에 맞을 확률 0.99 (문턱 0.9)");
    expect(merged?.textContent).toContain("규칙 v2 · Luna 판정");
    const pr = within(merged as HTMLElement).getByRole("link", {
      name: "acme/shop#412",
    });
    expect(pr.getAttribute("href")).toBe(PR_URL);
    expect(pr.getAttribute("target")).toBe("_blank");

    expect(document_?.textContent).toContain("확인 필요설계 문서 작성document");
    expect(document_?.textContent).toContain(
      "근거 out/payment-retry.md (에이전트가 쓴 파일이라 확인 필요)",
    );
    expect(
      within(document_ as HTMLElement)
        .getByRole("link", { name: "out/payment-retry.md" })
        .getAttribute("href"),
    ).toBe("#session-out-files");

    // `always` has no probability.
    expect(review?.textContent).toContain("거절됨코드 리뷰 제출code_review");
    expect(review?.textContent).toContain("규칙 v1 · 바로 인정");
    expect(review?.textContent).not.toContain("확률");

    expect(line?.textContent).toContain("마지막 판정");
    expect(line?.textContent).toContain(
      " · 근거 바뀜 · 판정 2회 · 판정 비용 $0.0005 (세션 비용과 별도)",
    );

    // An owner rejects what is counted, confirms what needs review, and
    // rejudges; a decided one has no buttons.
    expect(
      within(card)
        .getAllByRole("button")
        .map(
          (button) => button.getAttribute("aria-label") ?? button.textContent,
        ),
    ).toEqual([
      "머지된 PR 성과 거절",
      "설계 문서 작성 성과 거절",
      "설계 문서 작성 성과 확인",
      "다시 판정",
    ]);
  });

  test("confirming posts the decision and reads the card again", async () => {
    let reviewed = false;
    const { api } = renderAt(
      `/sessions/${SESSION_ID}`,
      routes(
        () =>
          json(200, {
            ...listed,
            items: listed.items.map((item) =>
              reviewed && item.id === DOCUMENT.id
                ? { ...item, review_state: "confirmed" }
                : item,
            ),
          }),
        me(),
        {
          [`POST /v1/achievements/${DOCUMENT.id}/review`]: () => {
            reviewed = true;
            return json(200, {
              achievement: { ...DOCUMENT, review_state: "confirmed" },
              receipt_id: RECEIPT_ID,
            });
          },
        },
      ),
    );
    const card = await openCard();
    await (await setupUser()).click(
      within(card).getByRole("button", { name: "설계 문서 작성 성과 확인" }),
    );
    await waitFor(() =>
      expect(within(card).getAllByText("확인됨")).toHaveLength(1),
    );
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
      decision: "confirm",
    });
    expect(
      within(card).queryByRole("button", { name: "설계 문서 작성 성과 확인" }),
    ).toBeNull();
  });

  test("a refused review says why in its row", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() => json(200, listed), me(), {
        [`POST /v1/achievements/${MERGED.id}/review`]: () =>
          apiError(409, "REVISION_CONFLICT", "already reviewed"),
      }),
    );
    const card = await openCard();
    await (await setupUser()).click(
      within(card).getByRole("button", { name: "머지된 PR 성과 거절" }),
    );
    const [merged] = within(card).getAllByRole("listitem");
    await waitFor(() =>
      expect(merged?.querySelector('[data-slot="field-error"]')).not.toBeNull(),
    );
  });

  test("rejudging asks for a manual judgment and shows it waiting", async () => {
    let queued = false;
    const { api } = renderAt(
      `/sessions/${SESSION_ID}`,
      routes(
        () =>
          json(200, {
            ...listed,
            judgment: queued
              ? {
                  ...listed.judgment,
                  trigger: "manual",
                  status: "queued",
                  finished_at: null,
                }
              : listed.judgment,
          }),
        me(),
        {
          [`POST /v1/sessions/${SESSION_ID}/achievement-judgments`]: () => {
            queued = true;
            return json(202, {
              judgment_id: JUDGMENT_ID,
              receipt_id: RECEIPT_ID,
            });
          },
        },
      ),
    );
    const card = await openCard();
    await (await setupUser()).click(
      within(card).getByRole("button", { name: "다시 판정" }),
    );
    await waitFor(() =>
      expect(card.textContent).toContain("판정 대기 · 다시 판정 요청"),
    );
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" &&
          call.path === `/v1/sessions/${SESSION_ID}/achievement-judgments`,
      ),
    ).toBe(true);
  });

  test("a judgment that could not judge says why", async () => {
    renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() =>
        json(200, {
          ...listed,
          items: [],
          judgment: {
            ...listed.judgment,
            status: "skipped",
            error_code: "judge_unavailable",
          },
          judgment_count: 1,
          judge_cost_usd: 0,
        }),
      ),
    );
    const card = await openCard();
    expect(card.textContent).toContain("판정 건너뜀: 판정기 없음");
    expect(card.textContent).toContain("판정 비용 $0.00 (세션 비용과 별도)");
  });

  test("a member sees no buttons, unless they administer the agent, and never rejudges", async () => {
    const member = me(undefined, "member");
    renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() => json(200, listed), member),
    );
    const card = await openCard();
    expect(within(card).queryAllByRole("button")).toEqual([]);
  });

  test("an agent's admin reviews that agent's achievements", async () => {
    const member = me(undefined, "member");
    renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() => json(200, listed), member, {
        "GET /v1/administered-agents": () =>
          json(200, {
            items: [{ ...agentServer().detail().agent, id: AGENT_ID }],
          }),
      }),
    );
    const card = await openCard();
    await waitFor(() =>
      expect(
        within(card)
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual([
        "머지된 PR 성과 거절",
        "설계 문서 작성 성과 거절",
        "설계 문서 작성 성과 확인",
      ]),
    );
  });

  test("a session with no achievements and no judgment shows no card", async () => {
    const { api } = renderAt(
      `/sessions/${SESSION_ID}`,
      routes(() =>
        json(200, {
          items: [],
          judgment: null,
          judgment_count: 0,
          judge_cost_usd: 0,
          threshold: 0.9,
        }),
      ),
    );
    await (await setupUser()).click(
      await screen.findByRole("tab", { name: /^결과물/ }),
    );
    await waitFor(() =>
      expect(api.calls.some((call) => call.path === ACHIEVEMENTS)).toBe(true),
    );
    expect(await screen.findByText("아직 결과물이 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^성과/ })).toBeNull();
  });
});
