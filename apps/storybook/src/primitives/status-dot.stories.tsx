import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusDot, type StatusDotStatus } from "@werft-ai/ui";

const STATUSES: StatusDotStatus[] = ["wait", "run", "idle", "done", "failed"];

// The kit has no messages of its own; these stand in for apps/web's.
const LABEL = {
  ko: {
    wait: "답변 대기",
    run: "실행 중",
    idle: "쉬는 중",
    done: "끝남",
    failed: "실패",
  },
  ja: {
    wait: "回答待ち",
    run: "実行中",
    idle: "待機中",
    done: "完了",
    failed: "失敗",
  },
  en: {
    wait: "Waiting",
    run: "Running",
    idle: "Idle",
    done: "Done",
    failed: "Failed",
  },
} as const;

const meta = {
  title: "Primitives/StatusDot",
  component: StatusDot,
  args: { status: "wait" },
  argTypes: { status: { control: "select", options: STATUSES } },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The dot is colour only and hidden from screen readers: the caller always
 * puts the status's name beside it. `run` turns; with reduced motion it is a
 * still dot.
 */
export const Statuses: Story = {
  render: (_args, { globals }) => {
    const locale: string = globals.locale;
    const label = LABEL[locale === "ja" || locale === "en" ? locale : "ko"];
    return (
      <div className="flex flex-col gap-2">
        {STATUSES.map((status) => (
          <span
            key={status}
            className="inline-flex items-center gap-2 text-control"
          >
            <StatusDot status={status} />
            {label[status]}
          </span>
        ))}
      </div>
    );
  },
};

export const StatusesDark: Story = {
  ...Statuses,
  name: "Statuses (dark)",
  globals: { theme: "dark" },
};
