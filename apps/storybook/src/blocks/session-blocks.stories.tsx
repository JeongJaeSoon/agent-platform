import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  SessionDetail as SessionDetailData,
  SessionUsageResponse,
} from "@werft-ai/contracts";
import {
  ApprovalInbox,
  SessionDetail,
  SessionList,
} from "@werft-ai/react/blocks";
import { ErrorState, Skeleton } from "@werft-ai/ui";

import {
  apiError,
  type FakeRoutes,
  json,
} from "../../.storybook/fake-client.ts";
import { SESSION, TURN_EVENTS } from "../patterns/session-fixtures.ts";

// The host's own words, which the blocks take as props. The toolbar's
// Language switches them along with the blocks' catalog.
const HOST = {
  ko: {
    loading: "불러오는 중",
    failed: "불러오지 못했습니다.",
    retry: "다시 시도",
    unavailable: {
      answer: "세션 승인 권한이 있어야 답할 수 있습니다.",
      control: "세션 제어 권한이 있어야 할 수 있습니다.",
      send: "메시지 보내기 권한이 있어야 할 수 있습니다.",
    },
  },
  en: {
    loading: "Loading",
    failed: "The read failed.",
    retry: "Retry",
    unavailable: {
      answer: "You need the sessions:approve permission for this.",
      control: "You need the sessions:control permission for this.",
      send: "You need the sessions:write permission for this.",
    },
  },
};

type Host = (typeof HOST)["ko"];
type Globals = { readonly globals: { readonly locale?: string } };

const hostFor = ({ globals }: Globals): Host =>
  globals.locale === "en" ? HOST.en : HOST.ko;

const shared = (host: Host) => ({
  loading: <Skeleton lines={3} label={host.loading} />,
  renderError: (_error: unknown, retry: () => void) => (
    <ErrorState message={host.failed} retry={retry} retryLabel={host.retry} />
  ),
});
const renderList = (_args: unknown, context: Globals) => (
  <SessionList {...shared(hostFor(context))} />
);
const renderDetail = (_args: unknown, context: Globals) => (
  <SessionDetail id={SESSION.id} {...shared(hostFor(context))} />
);

const meta = {
  title: "Blocks/Session",
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
// Far enough ahead that the requests still take answers.
const OPEN_UNTIL = "2099-01-01T00:00:00.000Z";
const accepted = () =>
  json(202, {
    receipt_id: "0192f0c4-7d3a-7b4e-9f00-0000000000f1",
    receipt_status: "accepted",
  });

const PENDING = {
  items: [
    {
      kind: "permission",
      request_id: "req_1",
      turn_id: "turn_1",
      attempt_id: "att_1",
      created_at: SESSION.updated_at,
      expires_at: OPEN_UNTIL,
      tool: "Bash",
      input: { command: "bun test" },
    },
    {
      kind: "question",
      request_id: "req_2",
      turn_id: "turn_1",
      attempt_id: "att_1",
      created_at: SESSION.updated_at,
      expires_at: OPEN_UNTIL,
      questions: [
        {
          question_id: "q_1",
          // What the agent asks is in its own language, not the catalog's;
          // long Korean here checks the card's wrapping (v2 V:467).
          prompt:
            "결제 실패 알림을 고친 커밋을 어느 브랜치에 올릴까요? 릴리스 브랜치에 올리면 다음 패치 배포에 함께 나가고, main에만 올리면 다음 정기 배포까지 기다립니다.",
          options: [
            { option_id: "main", label: "main에만 올리기" },
            { option_id: "release", label: "release/1.4에도 함께 올리기" },
          ],
          multi_select: false,
          allow_free_text: true,
        },
      ],
    },
  ],
};

export const Detail: Story = {
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
  render: renderDetail,
};

/** A key that holds sessions:read only: every action says why it is off. */
export const DetailReadOnly: Story = {
  ...Detail,
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

const renderInbox = (_args: unknown, context: Globals) => (
  <ApprovalInbox {...shared(hostFor(context))} />
);

export const Inbox: Story = {
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
  render: renderInbox,
};

export const InboxEmpty: Story = {
  parameters: { api: { "GET /v1/sessions": () => page([]) } },
  render: renderInbox,
};

export const InboxDark: Story = {
  ...Inbox,
  name: "Inbox (dark)",
  globals: { theme: "dark" },
};

export const InboxMobile: Story = {
  ...Inbox,
  name: "Inbox (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
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

// The stories above follow the toolbar's Language (한국어 by default); these
// pin English so both catalogs are in the sidebar and in the a11y run.
export const DetailEnglish: Story = {
  ...Detail,
  name: "Detail (English)",
  globals: { locale: "en" },
};

export const DetailReadOnlyEnglish: Story = {
  ...DetailReadOnly,
  name: "Detail read-only (English)",
  globals: { locale: "en" },
};

export const InboxEnglish: Story = {
  ...Inbox,
  name: "Inbox (English)",
  globals: { locale: "en" },
};

export const ListEnglish: Story = {
  ...List,
  name: "List (English)",
  globals: { locale: "en" },
};
