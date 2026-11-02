import type { Meta, StoryObj } from "@storybook/react-vite";
import { RowAction, RowList, SettingRow } from "@werft-ai/ui";
import { MoreHorizontal } from "lucide-react";

// The kit has no messages of its own; these stand in for apps/web's.
type Copy = {
  readonly rows: readonly (readonly [string, string, string])[];
  readonly menu: string;
};

const KO: Copy = {
  rows: [
    ["GitHub 계정", "@octo-kim · 3일 전 연결", "연결 해제"],
    ["API 키 ak_01…", "마지막 사용 1시간 전", "삭제"],
    ["Slack 앱", "설치되지 않음", "설치"],
    ["팀원 김하나", "구성원", "관리"],
  ],
  menu: "김하나 메뉴",
};

const COPY: Record<string, Copy> = {
  ko: KO,
  ja: {
    rows: [
      ["GitHub アカウント", "@octo-kim · 3日前に接続", "接続を解除"],
      ["API キー ak_01…", "最終使用 1時間前", "削除"],
      ["Slack アプリ", "未インストール", "インストール"],
      ["チームメンバー 김하나", "メンバー", "管理"],
    ],
    menu: "김하나 のメニュー",
  },
  en: {
    rows: [
      ["GitHub account", "@octo-kim · connected 3 days ago", "Disconnect"],
      ["API key ak_01…", "Last used 1 hour ago", "Delete"],
      ["Slack app", "Not installed", "Install"],
      ["Team member 김하나", "Member", "Manage"],
    ],
    menu: "Menu for 김하나",
  },
};

const VARIANT = ["danger", "danger", "default", "outline"] as const;

const meta = {
  title: "Patterns/RowAction",
  component: RowAction,
  // Rows of a settings list: right ends line up, each width follows its
  // label down to 48px; the icon button keeps its square.
  render: (_, { globals }) => {
    const copy = COPY[globals.locale] ?? KO;
    return (
      <RowList variant="joined">
        {copy.rows.map(([title, description, action], index) => (
          <SettingRow
            key={title}
            title={title}
            description={description}
            actions={<RowAction variant={VARIANT[index]}>{action}</RowAction>}
          />
        ))}
        <SettingRow
          title={copy.rows[3]?.[0]}
          description={copy.rows[3]?.[1]}
          actions={
            <RowAction size="icon-sm" variant="outline" aria-label={copy.menu}>
              <MoreHorizontal aria-hidden="true" />
            </RowAction>
          }
        />
      </RowList>
    );
  },
} satisfies Meta<typeof RowAction>;

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

export const Japanese: Story = { globals: { locale: "ja" } };

export const English: Story = { globals: { locale: "en" } };
