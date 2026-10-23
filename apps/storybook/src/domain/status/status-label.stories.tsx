import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  STATUS_AXIS_VALUES,
  STATUS_VOCABULARY,
  type StatusAxis,
  StatusLabel,
  type StatusStateOf,
} from "@werft-ai/react/components";

const meta = {
  title: "Domain/Status/StatusLabel",
  component: StatusLabel,
  args: { axis: "turn", state: "running" },
} satisfies Meta<typeof StatusLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

function AxisRow<A extends StatusAxis>({ axis }: { axis: A }) {
  const states = Object.keys(STATUS_VOCABULARY[axis]) as StatusStateOf<A>[];
  return (
    <section>
      <h3>{axis}</h3>
      <div className="story-row">
        {states.map((state) => (
          <StatusLabel key={String(state)} axis={axis} state={state} />
        ))}
      </div>
    </section>
  );
}

export const Default: Story = {};

export const EveryState: Story = {
  render: () => (
    <div className="story-stack">
      {STATUS_AXIS_VALUES.map((axis) => (
        <AxisRow key={axis} axis={axis} />
      ))}
    </div>
  ),
};

export const EveryStateDark: Story = {
  ...EveryState,
  name: "Every state (dark)",
  globals: { theme: "dark" },
};

export const DetailStaleAndOverride: Story = {
  render: () => (
    <div className="story-row">
      <StatusLabel
        axis="turn"
        state="running"
        detail="2분 12초 경과"
        stale={true}
      />
      <StatusLabel
        axis="admission"
        state="paused"
        label="관리자가 세웠습니다"
      />
      {/* An unbreakable identifier: the case that pushed the row past 360px
          before `.ap-status__detail` got a min-width of 0. */}
      <StatusLabel
        axis="execution"
        state="suspended"
        detail={`exec_${"0".repeat(60)}`}
      />
    </div>
  ),
};

export const Mobile: Story = {
  ...DetailStaleAndOverride,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

const SESSION_STATES = [
  "needs_input",
  "running",
  "idle",
  "stopped",
  "failed",
  "queued",
] as const;

// The sessions.status.* messages, so each locale's width shows here.
const SESSION_WORDS = {
  ko: ["답변 대기", "작업 중", "쉬는 중", "멈춤", "실패", "대기 중"],
  en: [
    "Waiting for an answer",
    "Working",
    "Idle",
    "Stopped",
    "Failed",
    "Queued",
  ],
  ja: ["回答待ち", "作業中", "アイドル", "停止", "失敗", "待機中"],
} as const;

const WAITED = { ko: "12분", en: "12 min", ja: "12分" } as const;

function DotColumn({ locale }: { locale: keyof typeof SESSION_WORDS }) {
  return (
    <section className="flex w-[116px] flex-col gap-3">
      <h3>{locale}</h3>
      {SESSION_STATES.map((state, index) => (
        <StatusLabel
          key={state}
          appearance="dot"
          axis="session"
          state={state}
          label={SESSION_WORDS[locale][index]}
          detail={state === "needs_input" ? WAITED[locale] : undefined}
        />
      ))}
    </section>
  );
}

/**
 * The session list's mark: a dot, a turning ring while running, the wait
 * after a middle dot. Each column is the list's 116px status column, so a
 * long word is cut and the wait stays. Reduced motion stops the ring; see
 * status-label.test.tsx.
 */
export const Dot: Story = {
  render: () => (
    <div className="story-row items-start">
      <DotColumn locale="ko" />
      <DotColumn locale="en" />
      <DotColumn locale="ja" />
    </div>
  ),
};

export const DotDark: Story = {
  ...Dot,
  name: "Dot (dark)",
  globals: { theme: "dark" },
};

export const DotMobile: Story = {
  ...Dot,
  name: "Dot (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
