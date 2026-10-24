import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Card, CardContent, Page } from "@werft-ai/ui";
import { Plus } from "lucide-react";

import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * The one page frame (V4-PAGE-FRAME): lists, settings, forms and details
 * all grow to 1620px beside the sidebar, then centre; narrower, only the
 * gutters remain. A form or settings page keeps the page's width and stops
 * its sections at 1100px inside it.
 */

function Frame({ kind }: { readonly kind: "list" | "settings" }) {
  return (
    <ScreenShell
      current={kind === "list" ? "home" : "settings"}
      crumb={[kind === "list" ? "홈" : "워크스페이스 설정"]}
    >
      <Page
        title={kind === "list" ? "목록 화면" : "설정 화면"}
        width={kind === "list" ? "full" : "form"}
        description="모든 화면이 같은 틀에서 최대 1620px까지 넓어진 뒤 가운데에 놓입니다."
        actions={
          kind === "list" ? (
            <Button type="button">
              <Plus aria-hidden="true" className="size-4" />
              새로 만들기
            </Button>
          ) : undefined
        }
      >
        <Card>
          <CardContent className="py-6 text-muted-foreground">
            {kind === "list" ? "콘텐츠 영역" : "폼 열은 안쪽에서 1100px까지"}
          </CardContent>
        </Card>
      </Page>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/AppShell page frame (v4)",
  component: Frame,
  parameters: { layout: "fullscreen" },
  args: { kind: "list" },
  argTypes: {
    kind: { control: "inline-radio", options: ["list", "settings"] },
  },
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = { name: "List" };
export const Settings: Story = { name: "Settings", args: { kind: "settings" } };
export const ListDark: Story = {
  name: "List (dark)",
  globals: { theme: "dark" },
};
export const Mobile: Story = { name: "List (390px)", globals: MOBILE };
