import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApprovalInbox } from "@werft-ai/react/blocks";
import { EmptyState, Link as TextLink } from "@werft-ai/ui";

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

const SUMMARY_NOW = Date.parse(SESSION.updated_at) + 12 * 60_000;

/**
 * `layout="summary"`, as home uses it (Console v4 "답이 필요한 요청"): each
 * request is a line under its session's name, the answer still at its end.
 * The design's avatar, agent name and "why you" wait for the API
 * (94S-811); the line says the short id and how long it waited instead.
 */
export const Summary: Story = {
  render: (_args, context) => (
    <ApprovalInbox
      {...shared(hostFor(context))}
      layout="summary"
      title="답이 필요한 요청"
      action={<TextLink href="#sessions">전체 보기</TextLink>}
      now={SUMMARY_NOW}
    />
  ),
  parameters: {
    api: {
      ...(Rows.parameters as { api: FakeRoutes }).api,
      "GET /v1/sessions": () =>
        page([
          { ...SESSION, title: "README 정리", status: "needs_input" },
          { ...SESSION, id: OTHER, status: "needs_input" },
        ]),
    } satisfies FakeRoutes,
  },
};

export const SummaryDark: Story = {
  ...Summary,
  name: "Summary (dark)",
  globals: { theme: "dark" },
};

export const SummaryMobile: Story = {
  ...Summary,
  name: "Summary (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

/** Seen through a share only: the line says why its answers are off. */
export const SummaryNotAnswerer: Story = {
  ...Summary,
  name: "Summary (not an answerer)",
  parameters: {
    api: {
      ...(Summary.parameters as { api: FakeRoutes }).api,
      [`GET ${base}/pending-requests`]: () =>
        json(200, { ...PENDING, answerable: false }),
    } satisfies FakeRoutes,
  },
};

export const SummaryEmpty: Story = {
  render: (_args, context) => (
    <ApprovalInbox
      {...shared(hostFor(context))}
      layout="summary"
      title="답이 필요한 요청"
      empty={
        <EmptyState
          title="지금 답할 요청이 없습니다"
          description="세션이 권한이나 답을 기다리면 여기에 먼저 나옵니다."
        />
      }
    />
  ),
  name: "Summary (empty)",
  parameters: { api: { "GET /v1/sessions": () => page([]) } },
};
