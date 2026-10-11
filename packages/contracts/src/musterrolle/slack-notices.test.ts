import { describe, expect, test } from "bun:test";
import {
  AUTHORIZATION_REASON_VALUES,
  type AuthorizationReason,
  authorizationSurfaceSchema,
  slackUserKindOf,
} from "./authorization.ts";
import { SLACK_NOTICE_MESSAGES, slackNoticeFor } from "./slack-notices.ts";

const links = { connectUrl: "https://app.example/settings/accounts" };
const deny = (reason_code: AuthorizationReason) => ({
  outcome: "deny" as const,
  reason_code,
});

describe("slackNoticeFor", () => {
  test.each([
    ["unlinked", "session.submit", SLACK_NOTICE_MESSAGES.connect, true],
    ["stale_link", "session.submit", SLACK_NOTICE_MESSAGES.connect, true],
    ["role", "session.submit", SLACK_NOTICE_MESSAGES.noRequestRight, false],
    [
      "surface_ceiling",
      "session.submit",
      SLACK_NOTICE_MESSAGES.noRequestRight,
      false,
    ],
    ["role", "session.approve", SLACK_NOTICE_MESSAGES.noApproveRight, false],
    [
      "surface_ceiling",
      "session.approve",
      SLACK_NOTICE_MESSAGES.noApproveRight,
      false,
    ],
    ["unlinked", "session.approve", SLACK_NOTICE_MESSAGES.connect, true],
    [
      "guest_disabled",
      "session.submit",
      SLACK_NOTICE_MESSAGES.guestDisabled,
      false,
    ],
    [
      "external_user",
      "session.submit",
      SLACK_NOTICE_MESSAGES.membersOnly,
      false,
    ],
    ["not_found", "session.approve", SLACK_NOTICE_MESSAGES.outOfShare, false],
    [
      "credential_unbound",
      "session.submit",
      SLACK_NOTICE_MESSAGES.credentialUnbound,
      false,
    ],
    ["error", "session.submit", SLACK_NOTICE_MESSAGES.failed, false],
  ] as const)("%s on %s", (reason, action, text, linked) => {
    expect(slackNoticeFor(deny(reason), action, links)).toEqual(
      linked ? { text, link_url: links.connectUrl } : { text },
    );
  });

  test("the copy is the wording the design gives", () => {
    expect(SLACK_NOTICE_MESSAGES).toMatchObject({
      connect: "웹에서 Slack 계정을 연결해 주세요",
      noRequestRight: "이 채널에서 이 에이전트에게 요청할 권한이 없어요",
      noApproveRight: "이 요청을 승인할 권한이 없어요",
      guestDisabled:
        "이 워크스페이스는 guest의 에이전트 사용을 허용하지 않아요",
      membersOnly: "이 에이전트는 이 워크스페이스 멤버만 쓸 수 있어요",
    });
    for (const text of Object.values(SLACK_NOTICE_MESSAGES)) {
      expect(text).not.toMatch(/Musterrolle|Werft|Kollegium|Kiel|Lotse/);
    }
  });

  test("every refusal reason has a notice; an allow or a redact has none", () => {
    for (const reason of AUTHORIZATION_REASON_VALUES) {
      if (reason === "ok") continue;
      expect(
        slackNoticeFor(deny(reason), "session.submit", links)?.text,
      ).toEqual(expect.any(String));
    }
    expect(
      slackNoticeFor(
        { outcome: "allow", reason_code: "ok" },
        "session.submit",
        links,
      ),
    ).toBeNull();
    expect(
      slackNoticeFor(
        { outcome: "redact", reason_code: "surface_ceiling" },
        "session.read",
        links,
      ),
    ).toBeNull();
  });
});

describe("slackUserKindOf", () => {
  const TEAM = "T0OPS";
  test.each([
    [{}, "member"],
    [{ is_restricted: true }, "guest"],
    [{ is_restricted: true, is_ultra_restricted: true }, "guest"],
    [{ is_stranger: true }, "external"],
    [{ is_external: true }, "external"],
    // A Slack Connect user is not marked restricted, but a guest flag on
    // someone from elsewhere does not make them a guest of this workspace.
    [{ is_restricted: true, team_id: "T0PARTNER" }, "external"],
    [{ team_id: "T0PARTNER" }, "external"],
  ] as const)("%o is %s", (fields, kind) => {
    expect(slackUserKindOf({ id: "U0", team_id: TEAM, ...fields }, TEAM)).toBe(
      kind,
    );
  });
});

describe("authorizationSurfaceSchema", () => {
  test("only a slack surface carries the user's kind and a channel ceiling", () => {
    const ceiling = { actions: ["session.submit"], disclosure: "full" };
    expect(
      authorizationSurfaceSchema.safeParse({
        kind: "slack",
        slack_user_kind: "external",
        ceiling,
      }).success,
    ).toBe(true);
    for (const extra of [{ slack_user_kind: "member" }, { ceiling }]) {
      expect(
        authorizationSurfaceSchema.safeParse({ kind: "web", ...extra }).success,
      ).toBe(false);
    }
  });

  test("no channel ceiling can name a web-only action", () => {
    for (const action of [
      "session.recover",
      "session.delete",
      "workspace.manage",
    ]) {
      expect(
        authorizationSurfaceSchema.safeParse({
          kind: "slack",
          ceiling: { actions: [action], disclosure: "full" },
        }).success,
      ).toBe(false);
    }
  });
});
