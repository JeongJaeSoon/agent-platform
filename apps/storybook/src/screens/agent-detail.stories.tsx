import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card, ErrorState, Skeleton, TabsContent } from "@werft-ai/ui";

import {
  type AgentCard,
  AgentCardTab,
  AgentHead,
  AgentOverview,
  AgentTabs,
  type AgentView,
} from "./agent-detail-parts.tsx";
import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * Console v4 agent detail (Console.dc.html L709-788): one column, the
 * overview's three figures, the steps before the agent runs, recent
 * sessions; the card tab as words beside the raw card. The parts live in
 * agent-detail-parts.tsx, which the Slack console's detail shares.
 */

type ScreenState = "owner" | "member-draft" | "loading" | "error";
type Tab = "overview" | "card";

const CARD: AgentCard = {
  role: "결제 문의 담당",
  instructions:
    "결제 실패·환불 문의를 받아 원인을 찾고, 필요한 경우 담당자에게 넘긴다.",
  language: "ko",
  model: "claude-sonnet-5",
  capabilities: {
    tools: null,
    forbidden: ["Bash"],
    mcp: [{ server: "billing-db" }],
    credential_refs: ["BILLING_DB"],
  },
  rules: [],
};

const RELEASED: AgentView = {
  name: "결제 담당",
  slug: "billing",
  released: true,
  card: CARD,
  version: "version 2",
  profile: "claude-coding",
  versionAt: "2026. 10. 22. 오후 2:00",
  releases: 2,
};
const DRAFT: AgentView = { ...RELEASED, released: false };

function AgentDetailScreen({
  state,
  tab,
}: {
  readonly state: ScreenState;
  readonly tab: Tab;
}) {
  const manager = state === "owner";
  const agent = state === "member-draft" ? DRAFT : RELEASED;
  return (
    <ScreenShell
      current="agents"
      crumb={["에이전트", agent.name]}
      role={manager ? "owner" : "member"}
    >
      {state === "loading" ? (
        <Card className="p-4">
          <Skeleton lines={4} label="불러오는 중입니다" />
        </Card>
      ) : state === "error" ? (
        <ErrorState
          title="에이전트를 불러오지 못했습니다."
          guidance="잠시 후 다시 시도하세요."
          code="INTERNAL"
        />
      ) : (
        <>
          <AgentHead agent={agent} />
          <AgentTabs value={tab}>
            <TabsContent value={tab}>
              {tab === "overview" ? (
                <AgentOverview agent={agent} />
              ) : (
                <AgentCardTab agent={agent} />
              )}
            </TabsContent>
          </AgentTabs>
        </>
      )}
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Agent detail (v4)",
  component: AgentDetailScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "owner", tab: "overview" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["owner", "member-draft", "loading", "error"],
    },
    tab: { control: "inline-radio", options: ["overview", "card"] },
  },
} satisfies Meta<typeof AgentDetailScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentDetail: Story = { name: "Overview (owner, released)" };
export const AgentDetailMemberDraft: Story = {
  name: "Overview (member, not released)",
  args: { state: "member-draft" },
};
export const AgentDetailCard: Story = {
  name: "Card tab",
  args: { tab: "card" },
};
export const AgentDetailLoading: Story = { args: { state: "loading" } };
export const AgentDetailError: Story = { args: { state: "error" } };
export const AgentDetailDark: Story = {
  name: "Overview (dark)",
  globals: { theme: "dark" },
};
export const AgentDetailMobile: Story = {
  name: "Overview (390px)",
  globals: MOBILE,
};
export const AgentDetailCardMobileDark: Story = {
  name: "Card tab (390px, dark)",
  args: { tab: "card" },
  globals: { ...MOBILE, theme: "dark" },
};
