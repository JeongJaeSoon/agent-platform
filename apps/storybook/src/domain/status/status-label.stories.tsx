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
