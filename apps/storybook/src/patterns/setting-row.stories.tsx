import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  NativeSelect,
  NativeSelectOption,
  RowList,
  SettingRow,
  Switch,
} from "@werft-ai/ui";
import { useId, useState } from "react";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    slack: "Slack 연결",
    slackDesc: "워크스페이스의 Slack에서 에이전트를 부릅니다.",
    dm: "DM 받기",
    dmDesc: "에이전트가 DM으로도 답합니다.",
    dmOff: "Slack 연결을 켜야 바꿀 수 있습니다.",
    reaction: "새 채널의 기본 반응",
    reactionDesc: "에이전트를 처음 초대한 채널에 씁니다.",
    reactions: ["멘션할 때", "모든 메시지", "꺼짐"],
    events: "이벤트 주소",
    error: "오류",
    eventsDesc: "Slack이 이벤트를 보내는 주소입니다.",
    eventsMeta: "마지막 실패 3분 전 · 응답 없음",
    guest: "게스트 허용",
    guestDesc: "Slack 게스트 계정도 에이전트를 부를 수 있습니다.",
    on: "켜짐",
    off: "꺼짐",
    disconnect: "연결 끊기",
    disconnectDesc: "연결을 끊으면 진행 중인 세션이 멈춥니다.",
    remove: "워크스페이스 삭제",
    removeDesc: "모든 에이전트와 기록을 지웁니다. 되돌릴 수 없습니다.",
    delete: "삭제",
    export: "내보내기",
    long: "아주 긴 설정 이름이 한 줄을 넘어가면 제목이 다음 줄로 넘어가고 컨트롤은 제자리에 있습니다",
    longDesc:
      "설명도 길어지면 글 칸 안에서 줄을 바꿉니다. 컨트롤은 줄어들지 않고, 좁은 화면에서는 글 아래 오른쪽 끝으로 내려갑니다. 그래도 페이지가 옆으로 넘치지 않습니다.",
  },
  ja: {
    slack: "Slack 連携",
    slackDesc: "ワークスペースの Slack からエージェントを呼び出します。",
    dm: "DM を受け取る",
    dmDesc: "エージェントが DM でも返信します。",
    dmOff: "Slack 連携をオンにすると変更できます。",
    reaction: "新しいチャンネルの既定の反応",
    reactionDesc: "エージェントを初めて招待したチャンネルで使います。",
    reactions: ["メンションされたとき", "すべてのメッセージ", "オフ"],
    events: "イベント URL",
    error: "エラー",
    eventsDesc: "Slack がイベントを送る URL です。",
    eventsMeta: "最後の失敗 3分前 · 応答なし",
    guest: "ゲストを許可",
    guestDesc: "Slack のゲストアカウントもエージェントを呼び出せます。",
    on: "オン",
    off: "オフ",
    disconnect: "連携を解除",
    disconnectDesc: "解除すると進行中のセッションが止まります。",
    remove: "ワークスペースを削除",
    removeDesc: "すべてのエージェントと記録を消します。元に戻せません。",
    delete: "削除",
    export: "エクスポート",
    long: "とても長い設定名が一行を超えると、タイトルは次の行に折り返し、コントロールはその場に残ります",
    longDesc:
      "説明が長くなってもテキスト欄の中で折り返します。コントロールは縮まず、狭い画面ではテキストの下の右端に移ります。それでもページは横にはみ出しません。",
  },
  en: {
    slack: "Slack connection",
    slackDesc: "Call the agent from the workspace's Slack.",
    dm: "Receive DMs",
    dmDesc: "The agent answers in DMs too.",
    dmOff: "Turn on the Slack connection to change this.",
    reaction: "Default reaction in new channels",
    reactionDesc: "Used in a channel the agent is first invited to.",
    reactions: ["When mentioned", "Every message", "Off"],
    events: "Event URL",
    error: "Error",
    eventsDesc: "Where Slack sends events.",
    eventsMeta: "Last failure 3 min ago · no response",
    guest: "Allow guests",
    guestDesc: "Slack guest accounts can call the agent too.",
    on: "On",
    off: "Off",
    disconnect: "Disconnect",
    disconnectDesc: "Disconnecting stops sessions in progress.",
    remove: "Delete workspace",
    removeDesc: "Deletes every agent and record. This cannot be undone.",
    delete: "Delete",
    export: "Export",
    long: "A very long setting name wraps onto the next line while the control stays where it is",
    longDesc:
      "A long description wraps inside the text column too. The control does not shrink, and on a narrow screen it moves under the text at the right edge, without the page scrolling sideways.",
  },
} as const;

type Copy = (typeof COPY)[keyof typeof COPY];
type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals): Copy {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

/** The Slack settings mockup's rows: switches, a select, a badge and a meta line. */
function SlackSettings({ copy }: { readonly copy: Copy }) {
  const [slack, setSlack] = useState(false);
  return (
    <RowList variant="joined">
      <SettingRow
        title={copy.slack}
        description={copy.slackDesc}
        control={<Switch checked={slack} onCheckedChange={setSlack} />}
      />
      <SettingRow
        title={copy.dm}
        description={slack ? copy.dmDesc : `${copy.dmDesc} ${copy.dmOff}`}
        control={<Switch defaultChecked={true} disabled={!slack} />}
      />
      <SettingRow
        title={copy.reaction}
        description={copy.reactionDesc}
        control={
          <NativeSelect size="sm" defaultValue={copy.reactions[0]}>
            {copy.reactions.map((reaction) => (
              <NativeSelectOption key={reaction} value={reaction}>
                {reaction}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        }
      />
      <SettingRow
        title={copy.events}
        badge={<Badge variant="red">{copy.error}</Badge>}
        description={copy.eventsDesc}
        meta={
          <>
            <span className="font-mono text-caption text-subtle-foreground">
              https://agents.example.com/slack/events
            </span>
            <span className="text-caption text-subtle-foreground">
              {copy.eventsMeta}
            </span>
          </>
        }
      />
    </RowList>
  );
}

/**
 * Buttons keep their own names; the row's description reaches them through
 * `aria-describedby` (the shape of a danger zone).
 */
function DangerRows({ copy }: { readonly copy: Copy }) {
  const disconnectId = useId();
  const removeId = useId();
  return (
    <RowList variant="joined">
      <SettingRow
        title={copy.disconnect}
        description={<span id={disconnectId}>{copy.disconnectDesc}</span>}
        actions={
          <Button
            type="button"
            variant="danger"
            size="sm"
            aria-describedby={disconnectId}
          >
            {copy.disconnect}
          </Button>
        }
      />
      <SettingRow
        title={copy.remove}
        description={<span id={removeId}>{copy.removeDesc}</span>}
        actions={
          <>
            <Button type="button" variant="outline" size="sm">
              {copy.export}
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              aria-describedby={removeId}
            >
              {copy.delete}
            </Button>
          </>
        }
      />
    </RowList>
  );
}

/** Words beside the control, as the console's "On"/"Off" today, and long text. */
function MoreRows({ copy }: { readonly copy: Copy }) {
  const [guest, setGuest] = useState(true);
  return (
    <RowList variant="joined">
      <SettingRow
        title={copy.guest}
        description={copy.guestDesc}
        status={
          <span className="text-caption text-subtle-foreground">
            {guest ? copy.on : copy.off}
          </span>
        }
        control={<Switch checked={guest} onCheckedChange={setGuest} />}
      />
      <SettingRow
        title={copy.long}
        description={copy.longDesc}
        control={<Switch />}
      />
    </RowList>
  );
}

const meta = {
  title: "Patterns/SettingRow",
  component: SettingRow,
  args: { title: COPY.ko.slack },
  render: (_args, context) => {
    const copy = copyFor(context);
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <SlackSettings copy={copy} />
        <MoreRows copy={copy} />
        <DangerRows copy={copy} />
      </div>
    );
  },
} satisfies Meta<typeof SettingRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Japanese: Story = { globals: { locale: "ja" } };

export const English: Story = { globals: { locale: "en" } };

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = {
  name: "Mobile (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

/** The danger zone's rows: a SettingRow with outlined danger buttons. */
export const DangerZoneRows: Story = {
  render: (_args, context) => <DangerRows copy={copyFor(context)} />,
};
