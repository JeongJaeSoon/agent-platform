import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApiErrorState, InstallationLimits } from "@werft-ai/react/components";

import { LIMITS } from "../../screens/operations-fixtures.ts";
import { MOBILE } from "../../screens/screen-kit.tsx";

/**
 * GET /v1/limits for the installation operator: slots and stored input over
 * every limit. The per-session rows have no installation-wide figure.
 */
const meta = {
  title: "Domain/Operations/InstallationLimits",
  component: InstallationLimits,
  args: { limits: LIMITS, timeZone: "Asia/Seoul" },
} satisfies Meta<typeof InstallationLimits>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The design's installation sets no token limit: "설정 안 됨". */
export const Default: Story = {};

export const TokenLimitSet: Story = {
  args: {
    limits: {
      ...LIMITS,
      limits: { ...LIMITS.limits, session_token_limit: 2_000_000 },
    },
  },
};

export const Loading: Story = { args: { limits: undefined } };

export const ErrorState: Story = {
  name: "Error",
  args: {
    limits: undefined,
    error: (
      <ApiErrorState
        title="한도를 읽지 못했습니다"
        message="upstream timeout"
        code="INTERNAL"
      />
    ),
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = { name: "Default (390px)", globals: MOBILE };

export const English: Story = { globals: { locale: "en" } };

export const Japanese: Story = { name: "日本語", globals: { locale: "ja" } };
