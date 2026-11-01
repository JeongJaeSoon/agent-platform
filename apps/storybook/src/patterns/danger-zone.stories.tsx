import type { Meta, StoryObj } from "@storybook/react-vite";
import { DangerZone, DangerZoneRow } from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY: Record<
  string,
  {
    title: string;
    replace: string;
    replaceDesc: string;
    replaceAction: string;
    remove: string;
    removeDesc: string;
    removeAction: string;
    reason: string;
  }
> = {
  ko: {
    title: "위험 구역",
    replace: "GitHub App 교체",
    replaceDesc: "App ID와 private key를 다시 등록합니다.",
    replaceAction: "교체",
    remove: "GitHub App 삭제",
    removeDesc: "다시 등록할 때까지 저장소에서 clone·push·PR을 할 수 없습니다.",
    removeAction: "삭제",
    reason: "워크스페이스 owner와 admin만 바꿀 수 있습니다.",
  },
  ja: {
    title: "危険な操作",
    replace: "GitHub App を置き換え",
    replaceDesc: "App ID と private key を登録し直します。",
    replaceAction: "置き換え",
    remove: "GitHub App を削除",
    removeDesc:
      "登録し直すまで、リポジトリで clone・push・PR ができなくなります。",
    removeAction: "削除",
    reason: "ワークスペースの owner と admin だけが変更できます。",
  },
  en: {
    title: "Danger zone",
    replace: "Replace the GitHub App",
    replaceDesc: "Registers an App ID and private key again.",
    replaceAction: "Replace",
    remove: "Delete the GitHub App",
    removeDesc:
      "Repositories cannot clone, push or open pull requests until an App is registered again.",
    removeAction: "Delete",
    reason: "Only workspace owners and admins can change this.",
  },
};

const meta = {
  title: "Patterns/DangerZone",
  component: DangerZone,
  // The render supplies the rows.
  args: { title: "", children: null },
  render: (_, { globals }) => {
    const copy = COPY[globals.locale] ?? COPY.ko;
    if (!copy) return <></>;
    return (
      <DangerZone title={copy.title}>
        <DangerZoneRow
          title={copy.replace}
          description={copy.replaceDesc}
          actionLabel={copy.replaceAction}
          actionName={copy.replace}
          onAction={() => {}}
        />
        <DangerZoneRow
          title={copy.remove}
          description={copy.removeDesc}
          actionLabel={copy.removeAction}
          actionName={copy.remove}
          onAction={() => {}}
          reason={copy.reason}
        />
      </DangerZone>
    );
  },
} satisfies Meta<typeof DangerZone>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = {
  globals: { theme: "dark" },
};

export const Mobile390: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
