import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Primitives/Dialog",
  component: Dialog,
  // Open from the start so the a11y run and a screenshot see the dialog,
  // not only its trigger.
  args: { defaultOpen: true },
  render: (args) => (
    <Dialog {...args}>
      <DialogTrigger asChild={true}>
        <Button type="button" variant="outline">
          다이얼로그 열기
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>초대 링크를 다시 만들까요?</DialogTitle>
          <DialogDescription>
            지금 링크는 바로 쓸 수 없게 되고, 새 링크가 만들어집니다.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild={true}>
            <Button type="button" variant="ghost">
              취소
            </Button>
          </DialogClose>
          <Button type="button">다시 만들기</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const OpenDark: Story = {
  name: "Open (dark)",
  globals: { theme: "dark" },
};

export const Closed: Story = { args: { defaultOpen: false } };
