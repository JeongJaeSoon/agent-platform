import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Primitives/Card",
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card>
      <CardHeader>
        <CardTitle>결제 담당</CardTitle>
        <CardDescription>
          청구서 문의에 답하고 환불을 접수합니다.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">초안</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {/* An unbreakable identifier: the case that overflows a narrow card. */}
        <p className="break-all font-mono text-sm">{`agt_${"0".repeat(60)}`}</p>
      </CardContent>
      <CardFooter className="gap-2">
        <Button type="button">이어서 설정</Button>
        <Button type="button" variant="ghost">
          나중에
        </Button>
      </CardFooter>
    </Card>
  ),
};

export const Dark: Story = {
  ...Default,
  globals: { theme: "dark" },
};

export const Mobile: Story = {
  ...Default,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
