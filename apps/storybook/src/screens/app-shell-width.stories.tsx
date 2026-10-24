import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card, CardContent, PageHeader } from "@werft-ai/ui";

import { type ContentWidth, MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * The content column beside the sidebar (V4-CENTER): it grows to 1620px for
 * lists, tables and details (Vercel) or 1100px for forms and settings
 * (Cloudflare), then centres; narrower, only the gutters remain.
 */

function ShellWidth({ width }: { readonly width: ContentWidth }) {
  return (
    <ScreenShell current="home" crumb={["홈"]} width={width}>
      <div className="flex flex-col gap-[var(--ap-space-page-head)]">
        <PageHeader
          title={width === "wide" ? "목록 화면" : "설정 화면"}
          description={
            width === "wide"
              ? "목록·표·상세는 최대 1620px까지 넓어진 뒤 가운데에 놓입니다."
              : "설정·폼은 최대 1100px까지 넓어진 뒤 가운데에 놓입니다."
          }
        />
        <Card>
          <CardContent className="py-6 text-muted-foreground">
            콘텐츠 영역
          </CardContent>
        </Card>
      </div>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/AppShell content width (v4)",
  component: ShellWidth,
  parameters: { layout: "fullscreen" },
  args: { width: "wide" },
  argTypes: {
    width: { control: "inline-radio", options: ["wide", "narrow"] },
  },
} satisfies Meta<typeof ShellWidth>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Wide: Story = { name: "Wide (lists, details)" };
export const Narrow: Story = {
  name: "Narrow (forms, settings)",
  args: { width: "narrow" },
};
export const WideDark: Story = {
  name: "Wide (dark)",
  globals: { theme: "dark" },
};
export const Mobile: Story = { name: "Wide (390px)", globals: MOBILE };
