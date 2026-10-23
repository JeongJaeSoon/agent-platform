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
        () => json(200, { answerable: true, items: [] }),
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

const OTHER = "0192f0c4-7d3a-7b4e-9f00-0000000000a2";

/**
 * `layout="row"`: each permission request is one line with its answers at
 * the end; a question stays a card.
 */
export const Rows: Story = {
  render: (_args, context) => (
    <ApprovalInbox {...shared(hostFor(context))} layout="row" />
  ),
  parameters: {
    api: {
      "GET /v1/sessions": () =>
        page([
          { ...SESSION, status: "needs_input" },
          { ...SESSION, id: OTHER, status: "needs_input" },
        ]),
      [`GET ${base}/pending-requests`]: () =>
        json(200, {
          ...PENDING,
          items: [
            PENDING.items[0],
            {
              ...PENDING.items[0],
              request_id: "req_3",
              tool: "Write",
              input: { file_path: "src/billing/notify.ts" },
            },
            PENDING.items[1],
          ],
        }),
      [`GET /v1/sessions/${OTHER}/pending-requests`]: () =>
        json(200, {
          answerable: true,
          items: [
            {
              ...PENDING.items[0],
              request_id: "req_4",
              tool: "mcp__github__create_pull_request",
            },
          ],
        }),
      [`POST ${base}/answers`]: accepted,
      [`POST /v1/sessions/${OTHER}/answers`]: accepted,
    } satisfies FakeRoutes,
  },
};

export const RowsDark: Story = {
  ...Rows,
  name: "Rows (dark)",
  globals: { theme: "dark" },
};

export const RowsMobile: Story = {
  ...Rows,
  name: "Rows (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const RowsJapanese: Story = {
  ...Rows,
  name: "Rows (日本語)",
  globals: { locale: "ja" },
};

export const RowsEnglish: Story = {
  ...Rows,
  name: "Rows (English)",
  globals: { locale: "en" },
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
