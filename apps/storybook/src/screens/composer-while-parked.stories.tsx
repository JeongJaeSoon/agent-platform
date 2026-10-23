import type { Meta, StoryObj } from "@storybook/react-vite";
import { Composer } from "@werft-ai/react/components";
import { Badge } from "@werft-ai/ui";

/*
 * S-A6: the message box while the session is parked. The server still
 * answers 409 SESSION_PAUSED; the screen says why before anyone types.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type ComposerState = "parked";

function ComposerWhileParkedBody(_: { readonly state: ComposerState }) {
  return (
    <Composer
      messages={{
        label: "다음 지시",
        send: "보내기",
        hint: "Ctrl+Enter(⌘+Enter)로도 보냅니다. 지금 turn이 끝나면 다음 turn으로 이어집니다.",
        queued: "기다리는 메시지",
      }}
      onSend={() => {}}
      disabled={true}
      disabledReason="일시정지 중에는 메시지를 보낼 수 없습니다. 위 요청에 답하면 이어서 진행합니다."
    />
  );
}

function ComposerWhileParkedScreen(
  props: Parameters<typeof ComposerWhileParkedBody>[0],
) {
  return (
    <div className="story-stack">
      {API_CHANGE}
      <ComposerWhileParkedBody {...props} />
    </div>
  );
}

const meta = {
  title: "Screens/Composer while parked (v3)",
  component: ComposerWhileParkedScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "parked" },
  argTypes: {
    state: { control: "inline-radio", options: ["parked"] },
  },
} satisfies Meta<typeof ComposerWhileParkedScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ComposerWhileParked: Story = { name: "Parked" };

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const ComposerWhileParkedMobile: Story = {
  name: "Parked (390px)",
  globals: MOBILE,
};

export const ComposerWhileParkedMobileDark: Story = {
  name: "Parked (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};
