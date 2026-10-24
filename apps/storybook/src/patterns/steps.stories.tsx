import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Card, Steps } from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    completed: "완료",
    home: [
      [
        "연동 계정 연결",
        "세션이 저장소와 외부 서비스에 접근할 계정을 연결합니다.",
        "확인",
      ],
      [
        "첫 세션 시작",
        "에이전트를 고르고 할 일을 적습니다. 프로필은 에이전트가 정한 값을 씁니다.",
        "새 세션",
      ],
      [
        "에이전트 담당 정하기",
        "반복되는 일은 에이전트로 만들고 담당자를 정합니다.",
        "에이전트",
      ],
    ],
  },
  ja: {
    completed: "完了",
    home: [
      [
        "連携アカウントを接続",
        "セッションがリポジトリや外部サービスにアクセスするアカウントを接続します。",
        "確認",
      ],
      [
        "最初のセッションを開始",
        "エージェントを選び、やることを書きます。プロフィールはエージェントの設定を使います。",
        "新しいセッション",
      ],
      [
        "エージェントの担当を決める",
        "繰り返す作業はエージェントにして担当者を決めます。",
        "エージェント",
      ],
    ],
  },
  en: {
    completed: "completed",
    home: [
      [
        "Connect accounts",
        "Connect the accounts sessions use to reach repositories and other services.",
        "Check",
      ],
      [
        "Start a first session",
        "Pick an agent and write what to do. The profile comes from the agent.",
        "New session",
      ],
      [
        "Assign agent owners",
        "Turn repeated work into agents and give each an owner.",
        "Agents",
      ],
    ],
  },
} as const;

type Locale = keyof typeof COPY;
type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  const locale: Locale =
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko";
  return COPY[locale];
}

const meta = {
  title: "Patterns/Steps",
  component: Steps,
  args: { items: [] },
  render: (args, context) => {
    const copy = copyFor(context);
    // The first item is done; the next one to do gets the primary button.
    return (
      <Card className="p-4">
        <Steps
          {...args}
          completedLabel={copy.completed}
          items={copy.home.map(([title, description, action], index) => ({
            id: String(index),
            title,
            description,
            done: index === 0,
            action: (
              <Button
                type="button"
                size="sm"
                variant={index === 1 ? "default" : "outline"}
              >
                {action}
              </Button>
            ),
          }))}
        />
      </Card>
    );
  },
} satisfies Meta<typeof Steps>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The home "getting started" list; follows the toolbar's Language. */
export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const Japanese: Story = { globals: { locale: "ja" } };

export const English: Story = { globals: { locale: "en" } };

export const Mobile: Story = {
  name: "Mobile (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

/** Rows without an action keep their height; the lock note is the screen's own. */
export const Credentials: Story = {
  render: (args) => (
    <Card className="p-4">
      <Steps
        {...args}
        items={[
          {
            id: "account",
            title: "연동 계정 고르기",
            description: "에이전트가 쓸 GitHub App 설치를 고릅니다.",
            action: (
              <Button type="button" size="sm" aria-disabled="true">
                연결
              </Button>
            ),
          },
          {
            id: "scopes",
            title: "권한 확인",
            description: "contents: write · pull_requests: write",
          },
          {
            id: "test",
            title: "연결 테스트",
            description: "앞 단계를 마치면 자동으로 확인합니다.",
          },
        ]}
      />
      <p className="text-caption text-subtle-foreground leading-normal">
        자격 증명은 이 에이전트의 담당자만 연결할 수 있습니다.
      </p>
    </Card>
  ),
};

export const CredentialsDone: Story = {
  name: "Credentials (done)",
  render: (args) => (
    <Card className="p-4">
      <Steps
        {...args}
        items={[
          {
            id: "account",
            title: "연동 계정 고르기",
            description: "GitHub App · m2m-check 조직",
            done: true,
          },
          {
            id: "scopes",
            title: "권한 확인",
            description: "contents: write · pull_requests: write",
            done: true,
          },
          {
            id: "test",
            title: "연결 테스트",
            description: "마지막 테스트 통과 · 10/22 02:00",
            done: true,
          },
        ]}
      />
    </Card>
  ),
};

export const CredentialsDark: Story = {
  ...Credentials,
  name: "Credentials (dark)",
  globals: { theme: "dark" },
};

export const CredentialsMobile: Story = {
  ...Credentials,
  name: "Credentials (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
