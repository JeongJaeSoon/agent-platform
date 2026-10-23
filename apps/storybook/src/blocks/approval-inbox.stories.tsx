import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApprovalInbox } from "@werft-ai/react/blocks";

import {
  apiError,
  type FakeRoutes,
  json,
} from "../../.storybook/fake-client.ts";
import { SESSION } from "../domain/session/session-fixtures.ts";
import {
  accepted,
  base,
  type Globals,
  hostFor,
  PENDING,
  page,
  pending,
  shared,
} from "./block-fixtures.tsx";

const meta = {
  title: "Blocks/ApprovalInbox",
  render: (_args: unknown, context: Globals) => (
    <ApprovalInbox {...shared(hostFor(context))} />
  ),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  parameters: {
    api: {
      "GET /v1/sessions": () =>
        page([
          { ...SESSION, status: "needs_input" },
          {
            ...SESSION,
            id: "0192f0c4-7d3a-7b4e-9f00-0000000000a2",
            status: "needs_input",
          },
        ]),
      [`GET ${base}/pending-requests`]: () => json(200, PENDING),
      "GET /v1/sessions/0192f0c4-7d3a-7b4e-9f00-0000000000a2/pending-requests":
        () => json(200, { items: [] }),
      [`POST ${base}/answers`]: accepted,
    } satisfies FakeRoutes,
  },
};

/** A key without sessions:approve: each answer says why it is off. */
export const Disabled: Story = {
  ...Default,
  render: (_args, context) => {
    const host = hostFor(context);
    return <ApprovalInbox {...shared(host)} unavailable={host.unavailable} />;
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

export const DefaultDark: Story = {
  ...Default,
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const DefaultMobile: Story = {
  ...Default,
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

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
