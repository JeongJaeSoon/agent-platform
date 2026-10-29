import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { cleanup, renderAt, screen, waitFor, within } = await appHarness();

const PATH = "/settings/workspace/github";
const APP = `/v1/workspaces/${WORKSPACE_ID}/github-app`;
const KEY_TEXT = "fake-pem-text";
const UNSET = {
  github_app: null,
  check: null,
  installations: [],
  repositories: [
    {
      id: "sandbox",
      url: "https://github.com/acme/sandbox.git",
      installation_id: null,
    },
  ],
};
const REGISTERED = {
  github_app: {
    app_id: 4242,
    slug: "werft-test",
    name: "werft test",
    html_url: "https://github.com/apps/werft-test",
    private_key: { updated_at: "2026-10-30T05:00:00.000Z", updated_by: null },
    created_at: "2026-10-30T05:00:00.000Z",
    updated_at: "2026-10-30T05:00:00.000Z",
  },
  check: { state: "ok" },
  installations: [
    {
      id: 77,
      account: "acme",
      repository_selection: "selected",
      html_url: "https://github.com/settings/installations/77",
    },
  ],
  repositories: [
    {
      id: "sandbox",
      url: "https://github.com/acme/sandbox.git",
      installation_id: 77,
    },
    {
      id: "other",
      url: "https://github.com/acme/other.git",
      installation_id: null,
    },
  ],
};
const refusal = (status: number, code: string, reason_code: string) =>
  json(status, {
    error: {
      code,
      message: "server words",
      retryable: false,
      request_id: "req-1",
      details: { reason_code },
    },
  });
const keyFile = () =>
  new File([KEY_TEXT], "app.pem", { type: "application/x-pem-file" });

async function register(appId = "4242") {
  const user = await setupUser();
  await user.click(await screen.findByRole("button", { name: "등록" }));
  const input = screen.getByLabelText("App ID");
  expect(document.activeElement === input).toBe(true);
  await user.type(input, appId);
  await user.upload(screen.getByLabelText("Private key (.pem)"), keyFile());
  await user.click(screen.getByRole("button", { name: "확인하고 저장" }));
  return user;
}

describe("워크스페이스 GitHub 연결", () => {
  test("App ID와 .pem 파일을 등록하면 다시 읽은 App과 설치·저장소 상태가 보이고, 키는 캐시에 남지 않는다", async () => {
    let saved = false;
    const { api, services } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APP}`]: () => json(200, saved ? REGISTERED : UNSET),
      [`PUT ${APP}`]: () => {
        saved = true;
        return json(200, {
          github_app: REGISTERED.github_app,
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
        });
      },
    });
    expect(await screen.findByText("등록 안 됨")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "위험 구역" })).toBeNull();
    await register();
    expect((await screen.findByRole("status")).textContent).toBe(
      "GitHub App을 저장했습니다.",
    );
    expect(
      api.calls.filter((c) => c.method === "PUT").map((c) => c.body),
    ).toEqual([{ app_id: 4242, private_key: KEY_TEXT }]);
    expect(await screen.findByText("연결됨")).toBeDefined();
    expect(screen.getByText("werft test")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: /GitHub에서 설치/ })
        .getAttribute("href"),
    ).toBe("https://github.com/apps/werft-test/installations/new");
    expect(screen.getByText("acme")).toBeDefined();
    expect(screen.getByText("고른 저장소만")).toBeDefined();
    expect(screen.getByText("설치됨")).toBeDefined();
    expect(screen.getByText("설치 안 됨")).toBeDefined();
    expect(screen.getByRole("heading", { name: "위험 구역" })).toBeDefined();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("교체"),
    );
    await waitFor(() =>
      expect(
        JSON.stringify(
          services.queryClient
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state.variables),
        ),
      ).not.toContain(KEY_TEXT),
    );
  });

  test("App ID나 파일이 없으면 서버에 묻지 않고 그 칸으로 간다", async () => {
    const { api } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APP}`]: () => json(200, UNSET),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "등록" }));
    await user.click(screen.getByRole("button", { name: "확인하고 저장" }));
    expect(screen.getByText("App ID를 숫자로 넣어 주세요.")).toBeDefined();
    expect(document.activeElement === screen.getByLabelText("App ID")).toBe(
      true,
    );
    await user.type(screen.getByLabelText("App ID"), "4242");
    await user.click(screen.getByRole("button", { name: "확인하고 저장" }));
    expect(screen.getByText(".pem 파일을 골라 주세요.")).toBeDefined();
    expect(
      document.activeElement === screen.getByLabelText("Private key (.pem)"),
    ).toBe(true);
    expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  test("서버가 거절한 이유마다 그 문구를 보이고 서버의 영어 문구는 없다", async () => {
    const cases = [
      [
        refusal(400, "BAD_REQUEST", "invalid_private_key"),
        "이 파일은 RSA private key가 아닙니다. GitHub App 페이지의 Private keys에서 받은 .pem 파일을 고르세요.",
      ],
      [
        refusal(400, "BAD_REQUEST", "github_app_rejected"),
        "GitHub가 이 App ID와 키를 받지 않았습니다. App ID와, 그 App에서 받은 키인지 확인하세요.",
      ],
      [
        refusal(503, "BACKEND_UNAVAILABLE", "github_unreachable"),
        "GitHub에 연결하지 못해 저장하지 않았습니다. 잠시 뒤 다시 시도하세요.",
      ],
      [
        apiError(503, "BACKEND_UNAVAILABLE", "The secret store is off"),
        "비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요.",
      ],
    ] as const;
    for (const [response, text] of cases) {
      renderAt(PATH, {
        "GET /v1/auth/me": () => json(200, me()),
        [`GET ${APP}`]: () => json(200, UNSET),
        [`PUT ${APP}`]: () => response.clone(),
      });
      await register();
      expect((await screen.findByRole("alert")).textContent).toBe(text);
      // The form stays so the owner can pick another file.
      expect(screen.getByLabelText("App ID")).toBeDefined();
      cleanup();
    }
  });

  test("GitHub에 닿지 못한 읽기는 확인 실패와 설치 상태를 모른다고 보인다", async () => {
    renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APP}`]: () =>
        json(200, {
          ...REGISTERED,
          check: { state: "failed", reason_code: "github_unreachable" },
          installations: [],
          repositories: REGISTERED.repositories.map((r) => ({
            ...r,
            installation_id: null,
          })),
        }),
    });
    expect(await screen.findByText("확인 실패")).toBeDefined();
    expect(screen.getAllByText("확인 못 함")).toHaveLength(2);
    expect(screen.queryByText("설치 안 됨")).toBeNull();
  });

  test("삭제를 확인하면 지우고 등록 안 됨으로 돌아간다", async () => {
    let deleted = false;
    const { api } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APP}`]: () => json(200, deleted ? UNSET : REGISTERED),
      [`DELETE ${APP}`]: () => {
        deleted = true;
        return json(200, {
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
        });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "GitHub App을 삭제했습니다.",
    );
    expect(await screen.findByText("등록 안 됨")).toBeDefined();
    expect(api.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  test("저장을 두 번 눌러도 한 번만 보낸다", async () => {
    const { api } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APP}`]: () => json(200, UNSET),
      [`PUT ${APP}`]: () =>
        json(200, {
          github_app: REGISTERED.github_app,
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
        }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "등록" }));
    await user.type(screen.getByLabelText("App ID"), "4242");
    await user.upload(screen.getByLabelText("Private key (.pem)"), keyFile());
    // Two submits in one tick, before the first has read the file.
    const form = screen
      .getByRole("button", { name: "확인하고 저장" })
      .closest("form");
    form?.requestSubmit();
    form?.requestSubmit();
    await screen.findByRole("status");
    expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  test("키가 거절되면 확인 실패이고, 빈 설치 카드도 다시 등록하라고 말한다", async () => {
    renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APP}`]: () =>
        json(200, {
          ...REGISTERED,
          check: { state: "failed", reason_code: "github_rejected" },
          installations: [],
        }),
    });
    expect(await screen.findByText("확인 실패")).toBeDefined();
    expect(
      screen.getAllByText(
        "GitHub가 이 App을 받지 않습니다. App이 삭제되었거나 키가 폐기되었다면 새 키로 다시 등록하세요.",
      ),
    ).toHaveLength(2);
    expect(screen.queryByText(/GitHub에 연결하지 못해/)).toBeNull();
  });

  test("구성원은 이유만 읽고 서버에 묻지 않는다", async () => {
    const { api } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "등록" })).toBeNull(),
    );
    expect(api.calls.some((c) => c.path === APP)).toBe(false);
  });
});
