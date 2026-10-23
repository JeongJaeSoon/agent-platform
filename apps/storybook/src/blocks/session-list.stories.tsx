import type { Meta, StoryObj } from "@storybook/react-vite";
import { SessionList } from "@werft-ai/react/blocks";

import { apiError, type FakeRoutes } from "../../.storybook/fake-client.ts";
import { SESSION } from "../domain/session/session-fixtures.ts";
import {
  type Globals,
  hostFor,
  page,
  pending,
  shared,
} from "./block-fixtures.tsx";

const meta = {
  title: "Blocks/SessionList",
  render: (_args: unknown, context: Globals) => (
    <SessionList {...shared(hostFor(context))} />
  ),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  parameters: {
    api: {
      "GET /v1/sessions": () =>
        page(
          [
            SESSION,
            {
              ...SESSION,
              id: "0192f0c4-7d3a-7b4e-9f00-0000000000a2",
              status: "needs_input",
            },
            {
              ...SESSION,
              id: "0192f0c4-7d3a-7b4e-9f00-0000000000a3",
              status: "failed",
              admission_state: "recovery_required",
              queued_turn_count: 0,
            },
          ],
          "next",
        ),
    } satisfies FakeRoutes,
  },
};

export const Loading: Story = {
  parameters: { api: { "GET /v1/sessions": pending } },
};

export const Empty: Story = {
  parameters: { api: { "GET /v1/sessions": () => page([]) } },
};

export const Failed: Story = {
  name: "Error",
  parameters: {
    api: {
      "GET /v1/sessions": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "backend unavailable"),
    },
  },
};

// The stories above follow the toolbar's Language (한국어 by default); these
// pin English and Japanese so every catalog is in the sidebar and in the a11y
// run.
export const DefaultEnglish: Story = {
  ...Default,
  name: "Default (English)",
  globals: { locale: "en" },
};

export const DefaultJapanese: Story = {
  ...Default,
  name: "Default (日本語)",
  globals: { locale: "ja" },
};
