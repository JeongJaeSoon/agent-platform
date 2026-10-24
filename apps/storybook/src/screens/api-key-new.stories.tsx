import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  Card,
  CardFooter,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Link,
  NativeSelect,
  NativeSelectOption,
  PageHeader,
} from "@werft-ai/ui";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";

import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * Making an API key as apps/web draws it (routes/api-keys.tsx). From the v4
 * mockup (Console.dc.html L818-823) it takes only the look: the way back
 * above the title, a `card flush` form with a 16px body, and the
 * `form-foot` strip with cancel and generate on the right. The fields stay
 * the console's own; the mockup's kind radios and expiry presets have no API.
 */

type Kind = "personal" | "agent";
type State = "ready" | "noScope" | "failed";

// The scopes an owner holds (GET /v1/auth/me), in the console's words.
const SCOPES = [
  {
    scope: "sessions:read",
    name: "세션 보기",
    hint: "세션과 그 턴·이벤트·영수증·사용량·공유 설정, 답을 기다리는 요청을 읽습니다.",
  },
  {
    scope: "sessions:write",
    name: "세션 만들기",
    hint: "새 세션을 시작하고 세션에 메시지를 보냅니다.",
  },
  {
    scope: "sessions:approve",
    name: "요청에 답하기",
    hint: "세션이 기다리는 권한 요청과 질문에 답합니다.",
  },
  {
    scope: "sessions:control",
    name: "세션 제어",
    hint: "세션을 멈추고, 다시 잇고, 중단하고, 끝내고, 실행 프로필을 바꿉니다.",
  },
  {
    scope: "sessions:recover",
    name: "세션 복구",
    hint: "복구가 필요한 세션을 어떻게 이을지 정합니다: 턴 버리기·완료 확정·닫기·새로 시작·복원 재시도.",
  },
] as const;

const SCREEN: Record<
  Kind,
  { readonly list: string; readonly title: string; readonly intro: string }
> = {
  personal: {
    list: "개인 key",
    title: "새 개인 key",
    intro:
      "나로 동작하는 key입니다. CLI나 스크립트가 내 권한 안에서 API를 부를 때 씁니다.",
  },
  agent: {
    list: "에이전트 key",
    title: "새 에이전트 key",
    intro:
      "사람이 아니라 에이전트 하나에 속한 key입니다. 그 에이전트의 세션에만 닿고, 발급한 사람이 떠나도 계속 동작합니다.",
  },
};

function NewKeyScreen({
  kind,
  state,
}: {
  readonly kind: Kind;
  readonly state: State;
}) {
  const screen = SCREEN[kind];
  // An agent key never approves, so its form does not offer it.
  const scopes = SCOPES.filter(
    (scope) => kind === "personal" || scope.scope !== "sessions:approve",
  );
  // As in the console, generate waits for at least one scope.
  const [chosen, setChosen] = useState<readonly string[]>(
    state === "noScope" ? [] : ["sessions:read"],
  );
  return (
    <ScreenShell current="settings" crumb={["내 설정", "API key"]}>
      <div className="flex w-full flex-col gap-2">
        <Link
          href={`#${kind}`}
          className="inline-flex items-center gap-1 self-start text-control"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          {screen.list}
        </Link>
        <PageHeader title={screen.title} description={screen.intro} />
        <div className="flex flex-col gap-[var(--ap-space-section)]">
          {state === "failed" ? (
            <div role="alert" className="text-destructive">
              처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.
            </div>
          ) : null}
          <Card flush>
            <form onSubmit={(event) => event.preventDefault()}>
              <div className="flex flex-col items-start gap-4 p-4">
                {kind === "agent" ? (
                  <Field>
                    <FieldLabel>에이전트</FieldLabel>
                    <div>
                      <NativeSelect defaultValue="review" required>
                        <NativeSelectOption value="" disabled>
                          에이전트를 고르세요
                        </NativeSelectOption>
                        <NativeSelectOption value="review">
                          리뷰 봇
                        </NativeSelectOption>
                      </NativeSelect>
                    </div>
                    <FieldDescription>
                      key를 쓸 에이전트입니다. 발급한 뒤에는 바꿀 수 없습니다.
                    </FieldDescription>
                  </Field>
                ) : null}
                <Field className="w-full">
                  <FieldLabel>이름(필수 아님)</FieldLabel>
                  <Input
                    className="max-w-sm"
                    autoComplete="off"
                    maxLength={64}
                  />
                  <FieldDescription>
                    목록에서 이 key를 알아보는 이름입니다. 예: ci-deploy
                  </FieldDescription>
                </Field>
                <FieldSet className="w-full gap-3">
                  <FieldLegend variant="label" className="mb-0">
                    권한
                  </FieldLegend>
                  {scopes.map((scope) => (
                    <Field key={scope.scope} orientation="horizontal">
                      <Checkbox
                        checked={chosen.includes(scope.scope)}
                        onCheckedChange={(checked) =>
                          setChosen(
                            checked === true
                              ? [...chosen, scope.scope]
                              : chosen.filter((s) => s !== scope.scope),
                          )
                        }
                      />
                      <FieldContent>
                        <FieldLabel>
                          {scope.name} {scope.scope}
                        </FieldLabel>
                        <FieldDescription>{scope.hint}</FieldDescription>
                      </FieldContent>
                    </Field>
                  ))}
                  {kind === "agent" ? (
                    <FieldDescription>
                      '요청에 답하기'(sessions:approve)는 에이전트 key에 넣을 수
                      없습니다. 승인과 질문 답변은 사람이 합니다.
                    </FieldDescription>
                  ) : null}
                </FieldSet>
                <Field>
                  <FieldLabel>만료일(필수 아님)</FieldLabel>
                  <div>
                    <Input
                      type="date"
                      className="w-auto"
                      // As in the console: no past day (local YYYY-MM-DD).
                      min={new Date().toLocaleDateString("sv")}
                      // An agent key starts 90 days out, as in the console.
                      defaultValue={
                        kind === "agent"
                          ? new Date(
                              Date.now() + 90 * 24 * 60 * 60 * 1000,
                            ).toLocaleDateString("sv")
                          : undefined
                      }
                    />
                  </div>
                  <FieldDescription>
                    {kind === "agent"
                      ? "기본은 90일 뒤입니다. 비워 두면 폐기할 때까지 유효합니다."
                      : "비워 두면 폐기할 때까지 유효합니다."}
                  </FieldDescription>
                </Field>
              </div>
              <CardFooter
                variant="form"
                className="flex-wrap items-start justify-end"
              >
                <Button type="button" variant="outline">
                  취소
                </Button>
                <Button type="submit" disabled={chosen.length === 0}>
                  key 만들기
                </Button>
              </CardFooter>
            </form>
          </Card>
        </div>
      </div>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/New API key (v4)",
  component: NewKeyScreen,
  parameters: { layout: "fullscreen" },
  args: { kind: "personal", state: "ready" },
  argTypes: {
    kind: { control: "inline-radio", options: ["personal", "agent"] },
    state: {
      control: "inline-radio",
      options: ["ready", "noScope", "failed"],
    },
  },
} satisfies Meta<typeof NewKeyScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewPersonalKey: Story = { name: "Owner · new personal key" };
export const NewAgentKey: Story = {
  name: "Owner · new agent key",
  args: { kind: "agent" },
};
export const NewKeyNoScope: Story = {
  name: "No scope picked (generate disabled)",
  args: { state: "noScope" },
};
export const NewKeyFailed: Story = {
  name: "Generate failed",
  args: { state: "failed" },
};
export const NewKeyDark: Story = {
  name: "Owner (dark)",
  globals: { theme: "dark" },
};
export const NewKeyMobile: Story = {
  name: "Owner (390px)",
  globals: MOBILE,
};
export const NewKeyMobileDark: Story = {
  name: "Owner (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};
