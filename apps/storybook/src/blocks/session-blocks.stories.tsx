import type {
  SessionDetail as SessionDetailData,
  SessionUsageResponse,
} from "@agent-platform/contracts";
import { SessionDetail, SessionList } from "@agent-platform/react/blocks";
import { ErrorState, Skeleton } from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  apiError,
  type FakeRoutes,
  json,
} from "../../.storybook/fake-client.ts";
import { SESSION, TURN_EVENTS } from "../patterns/session-fixtures.ts";

const loading = <Skeleton lines={3} label="Loading" />;
const renderError = (_error: unknown, retry: () => void) => (
  <ErrorState message="The read failed." retry={retry} retryLabel="Retry" />
);
const renderList = () => (
  <SessionList loading={loading} renderError={renderError} />
);
const renderDetail = () => (
  <SessionDetail id={SESSION.id} loading={loading} renderError={renderError} />
);

const meta = {
  title: "Blocks/Session",
  globals: { locale: "en" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const page = (items: unknown[], next_cursor: string | null = null) =>
  json(200, { items, next_cursor });

export const List: Story = {
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
  render: renderList,
};

export const ListEmpty: Story = {
  parameters: { api: { "GET /v1/sessions": () => page([]) } },
  render: renderList,
};

export const ListFailed: Story = {
  parameters: {
    api: {
      "GET /v1/sessions": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "backend unavailable"),
    },
  },
  render: renderList,
};

const DETAIL: SessionDetailData = {
  ...SESSION,
  status: "needs_input",
  execution: null,
  checkpoint_revision: null,
  pending_request_count: 1,
  attention: null,
  durability: {
    last_transcript_persisted_at: null,
    checkpoint_committed_at: null,
    checkpoint_revision: null,
    last_completed_turn_id: null,
    last_checkpointed_turn_id: null,
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
} as SessionDetailData;

const USAGE: SessionUsageResponse = {
  session_id: SESSION.id,
  period: "session_lifetime",
  refreshed_at: SESSION.updated_at,
  cost: {
    amount_usd: "0.4200",
    kind: "estimated",
    source: "provider_usage",
    completeness_scope: "turn_reports",
    complete: false,
    reported_turn_count: 1,
    unreported_turn_count: 0,
    open_turn_count: 1,
  },
  cost_limit_usd: "5",
  token_count: 1540,
  token_limit: null,
  budget_exceeded: false,
  queued_input_count: 0,
  queued_input_limit: 10,
};

function eventStream(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      TURN_EVENTS.forEach(([event, data], index) => {
        const envelope = {
          schema_version: 1,
          session_id: SESSION.id,
          turn_id: "turn_1",
          attempt_id: null,
          occurred_at: SESSION.updated_at,
          data,
        };
        controller.enqueue(
          encoder.encode(
            `id: ev_${index}\nevent: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`,
          ),
        );
      });
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

const base = `/v1/sessions/${SESSION.id}`;

export const Detail: Story = {
  parameters: {
    api: {
      [`GET ${base}`]: () => json(200, DETAIL),
      [`GET ${base}/usage`]: () => json(200, USAGE),
      [`GET ${base}/pending-requests`]: () =>
        json(200, {
          items: [
            {
              kind: "permission",
              request_id: "req_1",
              turn_id: "turn_1",
              attempt_id: "att_1",
              created_at: SESSION.updated_at,
              expires_at: SESSION.updated_at,
              tool: "Bash",
              input: { command: "bun test" },
            },
          ],
        }),
      [`GET ${base}/events`]: eventStream,
    } satisfies FakeRoutes,
  },
  render: renderDetail,
};

export const DetailNotFound: Story = {
  parameters: {
    api: {
      [`GET ${base}`]: () => apiError(404, "NOT_FOUND", "Resource not found"),
    },
  },
  render: renderDetail,
};

export const DetailDark: Story = {
  ...Detail,
  name: "Detail (dark)",
  globals: { theme: "dark" },
};

export const DetailMobile: Story = {
  ...Detail,
  name: "Detail (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
