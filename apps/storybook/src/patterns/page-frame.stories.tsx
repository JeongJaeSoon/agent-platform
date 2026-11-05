import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  Card,
  CardContent,
  Page,
  PageFrame,
  Section,
  Text,
} from "@werft-ai/ui";
import { expect } from "storybook/test";

import { MOBILE } from "../screens/screen-kit.tsx";

/**
 * The frame every console page sits in: 16px on every side, 24px from
 * 768px, and a column that grows to `--werft-w-page` and then centres. `Page`
 * puts the header over sections 32px apart.
 */
function Body() {
  return (
    <Page
      title="구성원"
      description="워크스페이스에 들어온 사람과 역할을 관리합니다."
      actions={<Button>초대하기</Button>}
    >
      <Section title="구성원 3명">
        <Card>
          <CardContent>
            <Text>표가 들어가는 자리입니다.</Text>
          </CardContent>
        </Card>
      </Section>
      <Section title="대기 중인 초대">
        <Card>
          <CardContent>
            <Text variant="meta">대기 중인 초대가 없습니다.</Text>
          </CardContent>
        </Card>
      </Section>
    </Page>
  );
}

const meta = {
  title: "Patterns/PageFrame",
  component: PageFrame,
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <PageFrame {...args}>
      <Body />
    </PageFrame>
  ),
} satisfies Meta<typeof PageFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const body = canvasElement.querySelector<HTMLElement>(
      "[data-slot=page-frame-body]",
    );
    await expect(body).not.toBeNull();
    await expect(getComputedStyle(body as HTMLElement).maxWidth).not.toBe(
      "none",
    );
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

/** 16px on every side below 768px. */
export const Mobile: Story = { name: "Default (390px)", globals: MOBILE };
