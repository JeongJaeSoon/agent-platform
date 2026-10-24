import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Avatar,
  Badge,
  Card,
  CardFooter,
  KeyValueList,
  Link,
  StatusDot,
} from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    model: "모델",
    runs: "이번 주 실행",
    last: "마지막 실행",
    status: "상태",
    owner: "담당",
    models: "허용 모델",
    lastValue: "3분 전",
    running: "실행 중",
    done: "끝남",
    team: "결제팀",
    eyebrow: "에이전트",
    title: "결제 문의 담당",
    kpiNote: "지난주보다 4회 많음",
    foot: "어제 18:20에 설정을 바꿨습니다",
    open: "열기",
    fresh: "새로 고침",
  },
  ja: {
    model: "モデル",
    runs: "今週の実行",
    last: "最後の実行",
    status: "状態",
    owner: "担当",
    models: "許可モデル",
    lastValue: "3分前",
    running: "実行中",
    done: "完了",
    team: "決済チーム",
    eyebrow: "エージェント",
    title: "決済問い合わせ担当",
    kpiNote: "先週より4回多い",
    foot: "昨日18:20に設定を変更しました",
    open: "開く",
    fresh: "更新",
  },
  en: {
    model: "Model",
    runs: "Runs this week",
    last: "Last run",
    status: "Status",
    owner: "Owner",
    models: "Allowed models",
    lastValue: "3 min ago",
    running: "Running",
    done: "Done",
    team: "Billing team",
    eyebrow: "Agent",
    title: "Billing questions",
    kpiNote: "4 more than last week",
    foot: "Settings changed yesterday at 18:20",
    open: "Open",
    fresh: "Refreshed",
  },
} as const;

type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

function itemsFor(copy: ReturnType<typeof copyFor>) {
  return [
    { label: copy.model, value: "claude-opus-5-5" },
    { label: copy.runs, value: "128" },
    { label: copy.last, value: copy.lastValue },
    {
      label: copy.status,
      value: (
        <>
          <StatusDot status="run" />
          {copy.running}
        </>
      ),
    },
    { label: copy.owner, value: copy.team },
  ];
}

const meta = {
  title: "Patterns/KeyValueList",
  component: KeyValueList,
  args: { items: [] },
  render: (args, context) => (
    <div className="max-w-[360px]">
      <KeyValueList {...args} items={itemsFor(copyFor(context))} />
    </div>
  ),
} satisfies Meta<typeof KeyValueList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A card's summary (mockup v4 `.kv-list`): 4px apart, values on the right. */
export const List: Story = {};

export const ListDark: Story = {
  name: "List (dark)",
  globals: { theme: "dark" },
};

/** A detail page's facts (mockup v4 `.dl`): a 140px label column. */
export const Grid: Story = {
  args: { variant: "grid" },
  render: (args, context) => (
    <KeyValueList {...args} items={itemsFor(copyFor(context))} />
  ),
};

export const GridDark: Story = {
  ...Grid,
  name: "Grid (dark)",
  globals: { theme: "dark" },
};

/** A chip list as a value, kept to the right as it wraps (L459). */
export const ChipValue: Story = {
  render: (args, context) => {
    const copy = copyFor(context);
    const chips = (
      <ul className="m-0 flex list-none flex-wrap justify-end gap-1 p-0">
        {MODELS.map((model) => (
          <li key={model}>
            <Badge variant="mono">{model}</Badge>
          </li>
        ))}
      </ul>
    );
    return (
      <div className="flex max-w-[360px] flex-col gap-6">
        <KeyValueList
          {...args}
          items={[{ label: copy.models, value: chips }]}
        />
        <KeyValueList
          {...args}
          variant="grid"
          items={[{ label: copy.models, value: chips }]}
        />
      </div>
    );
  },
};

/**
 * Mockup v4's home card (L544-550): Card, KeyValueList, a status dot and the
 * card's foot, put together by the screen.
 */
export const HomeCard: Story = {
  render: (_args, context) => {
    const copy = copyFor(context);
    return (
      <Card className="max-w-[360px]">
        <div className="flex items-start justify-between gap-2 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar size="lg" shape="square" tone={1} initials="BQ" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-caption text-subtle-foreground leading-normal">
                {copy.eyebrow}
              </span>
              <h3 className="m-0 truncate font-semibold text-body leading-5">
                {copy.title}
              </h3>
            </div>
          </div>
          <Badge variant="green">{copy.fresh}</Badge>
        </div>
        <div className="px-4">
          <div className="font-semibold text-number tracking-[-0.5px] tabular-nums">
            128
          </div>
          <div className="text-caption text-subtle-foreground leading-normal">
            {copy.kpiNote}
          </div>
        </div>
        <KeyValueList
          className="px-4"
          items={[
            {
              label: copy.status,
              value: (
                <>
                  <StatusDot status="done" />
                  <span className="truncate">{copy.done}</span>
                </>
              ),
            },
            { label: copy.model, value: "claude-opus-5-5" },
            { label: copy.owner, value: copy.team },
          ]}
        />
        <CardFooter className="justify-between gap-2 border-t">
          <span className="truncate text-caption text-subtle-foreground">
            {copy.foot}
          </span>
          <Link href="#agent">{copy.open}</Link>
        </CardFooter>
      </Card>
    );
  },
};

export const HomeCardDark: Story = {
  ...HomeCard,
  name: "Home card (dark)",
  globals: { theme: "dark" },
};

export const HomeCardMobile: Story = {
  ...HomeCard,
  name: "Home card (390px)",
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};

export const GridMobile: Story = {
  ...Grid,
  name: "Grid (390px)",
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};
