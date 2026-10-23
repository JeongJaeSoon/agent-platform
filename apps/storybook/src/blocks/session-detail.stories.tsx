import type { Meta, StoryObj } from "@storybook/react-vite";
import { SessionDetail } from "@werft-ai/react/blocks";

import {
  apiError,
  type FakeRoutes,
  json,
} from "../../.storybook/fake-client.ts";
import { SESSION } from "../domain/session/session-fixtures.ts";
import {
  accepted,
  base,
  DETAIL,
  eventStream,
  type Globals,
  hostFor,
  PENDING,
  pending,
  shared,
  USAGE,
} from "./block-fixtures.tsx";

const meta = {
  title: "Blocks/SessionDetail",
  render: (_args: unknown, context: Globals) => (
    <SessionDetail id={SESSION.id} {...shared(hostFor(context))} />
  ),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  parameters: {
    api: {
      [`GET ${base}`]: () => json(200, DETAIL),
      [`GET ${base}/usage`]: () => json(200, USAGE),
      [`GET ${base}/pending-requests`]: () => json(200, PENDING),
      [`GET ${base}/events`]: eventStream,
      [`POST ${base}/answers`]: accepted,
      [`POST ${base}/interrupt`]: accepted,
      [`POST ${base}/pause`]: accepted,
      [`POST ${base}/terminate`]: accepted,
      [`POST ${base}/messages`]: () =>
        json(202, {
          turn_id: "turn_2",
          receipt_id: "0192f0c4-7d3a-7b4e-9f00-0000000000f2",
          receipt_status: "accepted",
        }),
    } satisfies FakeRoutes,
  },
};

/** A key that holds sessions:read only: every action says why it is off. */
export const Disabled: Story = {
  ...Default,
  render: (_args, context) => {
    const host = hostFor(context);
    return (
      <SessionDetail
        id={SESSION.id}
        {...shared(host)}
        unavailable={host.unavailable}
      />
    );
  },
};

export const Loading: Story = {
  parameters: { api: { [`GET ${base}`]: pending } },
};

export const Failed: Story = {
  name: "Error",
  parameters: {
    api: {
      [`GET ${base}`]: () => apiError(404, "NOT_FOUND", "Resource not found"),
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

// The stories above follow the toolbar's Language (한국어 by default); these
// pin English and Japanese so every catalog is in the sidebar and in the a11y
// run.
export const DefaultEnglish: Story = {
  ...Default,
  name: "Default (English)",
  globals: { locale: "en" },
};

export const DisabledEnglish: Story = {
  ...Disabled,
  name: "Disabled (English)",
  globals: { locale: "en" },
};

export const DefaultJapanese: Story = {
  ...Default,
  name: "Default (日本語)",
  globals: { locale: "ja" },
};

export const DefaultJapaneseMobile: Story = {
  ...DefaultMobile,
  name: "Default mobile (日本語)",
  globals: { ...DefaultMobile.globals, locale: "ja" },
};
