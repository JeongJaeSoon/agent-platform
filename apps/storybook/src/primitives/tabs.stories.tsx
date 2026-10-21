import { Tabs, TabsContent, TabsList, TabsTrigger } from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Primitives/Tabs",
  component: Tabs,
  args: { defaultValue: "overview" },
  argTypes: {
    orientation: { control: "select", options: ["horizontal", "vertical"] },
  },
  render: (args) => (
    <div className="flex flex-col gap-8">
      <Tabs {...args}>
        <TabsList>
          <TabsTrigger value="overview">개요</TabsTrigger>
          <TabsTrigger value="sessions">세션</TabsTrigger>
          <TabsTrigger value="settings" disabled={true}>
            설정
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">에이전트가 하는 일과 상태</TabsContent>
        <TabsContent value="sessions">최근 세션 목록</TabsContent>
        <TabsContent value="settings">설정</TabsContent>
      </Tabs>
      <Tabs {...args}>
        <TabsList variant="line">
          <TabsTrigger value="overview">개요</TabsTrigger>
          <TabsTrigger value="sessions">세션</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">밑줄 모양 탭</TabsContent>
        <TabsContent value="sessions">최근 세션 목록</TabsContent>
      </Tabs>
    </div>
  ),
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {};

export const VariantsDark: Story = {
  name: "Variants (dark)",
  globals: { theme: "dark" },
};

export const VariantsMobile: Story = {
  name: "Variants (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
