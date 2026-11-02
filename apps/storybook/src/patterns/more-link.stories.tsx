import type { Meta, StoryObj } from "@storybook/react-vite";
import { MoreLink, Text } from "@werft-ai/ui";

const meta = {
  title: "Patterns/MoreLink",
  component: MoreLink,
  args: { href: "#operations/tools", children: "도구 활동" },
} satisfies Meta<typeof MoreLink>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 12px on a section title's line, as on the operations tabs. */
export const Caption: Story = {};

/** 13px with a trailing arrow, as on the home sections. */
export const ControlWithArrow: Story = {
  args: { size: "control", arrow: true, children: "모두 보기" },
};

/** 13px without the arrow, as on the agent overview. */
export const Control: Story = {
  args: { size: "control", children: "모두 보기" },
};

/** The shapes beside a section title, where the screens put them. */
export const BesideTitles: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-6">
      {(
        [
          [
            "운영 · 사용량",
            <MoreLink key="c" href="#operations/usage">
              사용량 자세히
            </MoreLink>,
          ],
          [
            "홈 · 최근 세션",
            <MoreLink key="a" href="#sessions" size="control" arrow>
              모두 보기
            </MoreLink>,
          ],
          [
            "에이전트 개요 · 최근 세션",
            <MoreLink key="n" href="#sessions" size="control">
              모두 보기
            </MoreLink>,
          ],
        ] as const
      ).map(([title, link]) => (
        <div key={title} className="flex items-baseline justify-between gap-3">
          <Text weight="medium">{title}</Text>
          {link}
        </div>
      ))}
    </div>
  ),
};

export const BesideTitlesDark: Story = {
  ...BesideTitles,
  name: "Beside titles (dark)",
  globals: { theme: "dark" },
};

export const BesideTitlesMobile: Story = {
  ...BesideTitles,
  name: "Beside titles (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
