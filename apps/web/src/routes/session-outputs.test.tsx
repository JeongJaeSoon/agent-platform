import { describe, expect, test } from "bun:test";
import type {
  ListSessionOutputsResponse,
  SessionDetail,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

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
    const section = await screen.findByRole("region", { name: "결과물" });
    expect(section.textContent).toContain("report.md");
    expect(section.textContent).toContain("2kB");
    expect(section.textContent).toContain("video.mp4");
    expect(section.textContent).toContain("너무 커서 보관하지 않음");

    const report = screen.getByRole("link", { name: "report.md 내려받기" });
    expect(report.getAttribute("href")).toBe(
      `/v1/sessions/${SESSION_ID}/outputs/out%2Freport.md`,
    );
    expect(report.getAttribute("download")).toBe("report.md");
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
    expect(screen.queryByRole("region", { name: "결과물" })).toBeNull();
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
  });
});
