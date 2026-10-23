import { type PagePromise, paginate } from "../core/page.ts";
import {
  call,
  type MutationOptions,
  type RequestOptions,
} from "../core/request.ts";
import {
  type EventStream,
  openEventStream,
  type StreamOptions,
} from "../core/stream.ts";
import type {
  AnswerAccepted,
  AnswerBody,
  ChangeProfileParams,
  CommentPullRequestParams,
  CreateSessionParams,
  DecidePushParams,
  InterruptParams,
  ListSessionsParams,
  ListTurnsParams,
  MessageAccepted,
  OpenPullRequestParams,
  PauseParams,
  PendingRequest,
  PullRequestCommentResult,
  PullRequestResult,
  PushRequest,
  PushRequestId,
  ReceiptAccepted,
  RecoveryDecisionParams,
  ResumeParams,
  SendMessageParams,
  Session,
  SessionCreated,
  SessionId,
  SessionShare,
  SessionSummary,
  SessionUsage,
  TerminateAccepted,
  TerminateParams,
  Turn,
  TurnId,
  TurnSummary,
} from "../types.ts";
import { type CloseParams, closeSession } from "./close.ts";
import type { Context } from "./context.ts";

export interface Sessions {
  create(
    params: CreateSessionParams,
    options?: MutationOptions,
  ): Promise<SessionCreated>;
  get(id: SessionId, options?: RequestOptions): Promise<Session>;
  list(
    params?: ListSessionsParams,
    options?: RequestOptions,
  ): PagePromise<SessionSummary>;
  usage(id: SessionId, options?: RequestOptions): Promise<SessionUsage>;
  share(id: SessionId, options?: RequestOptions): Promise<SessionShare>;
  interrupt(
    id: SessionId,
    params: InterruptParams,
    options?: MutationOptions,
  ): Promise<ReceiptAccepted>;
  pause(
    id: SessionId,
    params: PauseParams,
    options?: MutationOptions,
  ): Promise<ReceiptAccepted>;
  resume(
    id: SessionId,
    params: ResumeParams,
    options?: MutationOptions,
  ): Promise<ReceiptAccepted>;
  terminate(
    id: SessionId,
    params: TerminateParams,
    options?: MutationOptions,
  ): Promise<TerminateAccepted>;
  /** Ends a session whose work is done. See resources/close.ts. */
  close(
    id: SessionId,
    params: CloseParams,
    options?: MutationOptions,
  ): Promise<ReceiptAccepted>;
  changeProfile(
    id: SessionId,
    params: ChangeProfileParams,
    options?: MutationOptions,
  ): Promise<ReceiptAccepted>;
  recoveryDecisions: {
    create(
      id: SessionId,
      params: RecoveryDecisionParams,
      options?: MutationOptions,
    ): Promise<ReceiptAccepted>;
  };
  messages: {
    send(
      id: SessionId,
      params: SendMessageParams,
      options?: MutationOptions,
    ): Promise<MessageAccepted>;
  };
  turns: {
    get(id: SessionId, turnId: TurnId, options?: RequestOptions): Promise<Turn>;
    list(
      id: SessionId,
      params?: ListTurnsParams,
      options?: RequestOptions,
    ): PagePromise<TurnSummary>;
  };
  events: {
    stream(id: SessionId, options?: StreamOptions): EventStream;
  };
  requests: {
    list(id: SessionId, options?: RequestOptions): Promise<PendingRequest[]>;
    /** The key defaults to `answer:<request_id>`: one request has one answer. */
    answer(
      id: SessionId,
      body: AnswerBody,
      options?: MutationOptions,
    ): Promise<AnswerAccepted>;
  };
  pushRequests: {
    create(id: SessionId, options?: MutationOptions): Promise<PushRequest>;
    list(id: SessionId, options?: RequestOptions): Promise<PushRequest[]>;
    get(
      id: SessionId,
      pushRequestId: PushRequestId,
      options?: RequestOptions,
    ): Promise<PushRequest>;
    decide(
      id: SessionId,
      pushRequestId: PushRequestId,
      params: DecidePushParams,
      options?: MutationOptions,
    ): Promise<PushRequest>;
    /** No Idempotency-Key in the API: retried on a retryable answer, never after a lost one. */
    openPullRequest(
      id: SessionId,
      pushRequestId: PushRequestId,
      params?: OpenPullRequestParams,
      options?: RequestOptions,
    ): Promise<PullRequestResult>;
    commentPullRequest(
      id: SessionId,
      pushRequestId: PushRequestId,
      params: CommentPullRequestParams,
      options?: RequestOptions,
    ): Promise<PullRequestCommentResult>;
  };
}

export function sessions(context: Context): Sessions {
  const { api, policy } = context;
  const header = (idempotencyKey: string) => ({
    "Idempotency-Key": idempotencyKey,
  });

  return {
    create: (params, options) =>
      call(
        policy,
        "keyed",
        ({ signal, headers, idempotencyKey }) =>
          api.POST("/v1/sessions", {
            params: { header: header(idempotencyKey) },
            body: params,
            signal,
            headers,
          }),
        options,
      ),
    get: (id, options) =>
      call(
        policy,
        "read",
        ({ signal, headers }) =>
          api.GET("/v1/sessions/{id}", {
            params: { path: { id } },
            signal,
            headers,
          }),
        options,
      ),
    list: (params, options) =>
      paginate(
        (cursor, pageOptions) =>
          call(
            policy,
            "read",
            ({ signal, headers }) =>
              api.GET("/v1/sessions", {
                params: { query: { ...params, ...(cursor ? { cursor } : {}) } },
                signal,
                headers,
              }),
            pageOptions,
          ),
        options,
      ),
    usage: (id, options) =>
      call(
        policy,
        "read",
        ({ signal, headers }) =>
          api.GET("/v1/sessions/{id}/usage", {
            params: { path: { id } },
            signal,
            headers,
          }),
        options,
      ),
    share: (id, options) =>
      call(
        policy,
        "read",
        ({ signal, headers }) =>
          api.GET("/v1/sessions/{id}/share", {
            params: { path: { id } },
            signal,
            headers,
          }),
        options,
      ),
    interrupt: (id, params, options) =>
      call(
        policy,
        "keyed",
        ({ signal, headers, idempotencyKey }) =>
          api.POST("/v1/sessions/{id}/interrupt", {
            params: { path: { id }, header: header(idempotencyKey) },
            body: params,
            signal,
            headers,
          }),
        options,
      ),
    pause: (id, params, options) =>
      call(
        policy,
        "keyed",
        ({ signal, headers, idempotencyKey }) =>
          api.POST("/v1/sessions/{id}/pause", {
            params: { path: { id }, header: header(idempotencyKey) },
            body: params,
            signal,
            headers,
          }),
        options,
      ),
    resume: (id, params, options) =>
      call(
        policy,
        "keyed",
        ({ signal, headers, idempotencyKey }) =>
          api.POST("/v1/sessions/{id}/resume", {
            params: { path: { id }, header: header(idempotencyKey) },
            body: params,
            signal,
            headers,
          }),
        options,
      ),
    terminate: (id, params, options) =>
      call(
        policy,
        "keyed",
        ({ signal, headers, idempotencyKey }) =>
          api.POST("/v1/sessions/{id}/terminate", {
            params: { path: { id }, header: header(idempotencyKey) },
            body: params,
            signal,
            headers,
          }),
        options,
      ),
    close: (id, params, options) => closeSession(context, id, params, options),
    changeProfile: (id, params, options) =>
      call(
        policy,
        "keyed",
        ({ signal, headers, idempotencyKey }) =>
          api.POST("/v1/sessions/{id}/profile", {
            params: { path: { id }, header: header(idempotencyKey) },
            body: params,
            signal,
            headers,
          }),
        options,
      ),
    recoveryDecisions: {
      create: (id, params, options) =>
        call(
          policy,
          "keyed",
          ({ signal, headers, idempotencyKey }) =>
            api.POST("/v1/sessions/{id}/recovery-decisions", {
              params: { path: { id }, header: header(idempotencyKey) },
              body: params,
              signal,
              headers,
            }),
          options,
        ),
    },
    messages: {
      send: (id, params, options) =>
        call(
          policy,
          "keyed",
          ({ signal, headers, idempotencyKey }) =>
            api.POST("/v1/sessions/{id}/messages", {
              params: { path: { id }, header: header(idempotencyKey) },
              body: { mode: "enqueue", ...params },
              signal,
              headers,
            }),
          options,
        ),
    },
    turns: {
      get: (id, turnId, options) =>
        call(
          policy,
          "read",
          ({ signal, headers }) =>
            api.GET("/v1/sessions/{id}/turns/{turn_id}", {
              params: { path: { id, turn_id: turnId } },
              signal,
              headers,
            }),
          options,
        ),
      list: (id, params, options) =>
        paginate(
          (cursor, pageOptions) =>
            call(
              policy,
              "read",
              ({ signal, headers }) =>
                api.GET("/v1/sessions/{id}/turns", {
                  params: {
                    path: { id },
                    query: { ...params, ...(cursor ? { cursor } : {}) },
                  },
                  signal,
                  headers,
                }),
              pageOptions,
            ),
          options,
        ),
    },
    events: {
      stream: (id, options) => openEventStream(api, id, options),
    },
    requests: {
      list: async (id, options) =>
        (
          await call(
            policy,
            "read",
            ({ signal, headers }) =>
              api.GET("/v1/sessions/{id}/pending-requests", {
                params: { path: { id } },
                signal,
                headers,
              }),
            options,
          )
        ).items,
      answer: (id, body, options) =>
        call(
          policy,
          "keyed",
          ({ signal, headers, idempotencyKey }) =>
            api.POST("/v1/sessions/{id}/answers", {
              params: { path: { id }, header: header(idempotencyKey) },
              body,
              signal,
              headers,
            }),
          options,
          `answer:${body.request_id}`,
        ),
    },
    pushRequests: {
      create: (id, options) =>
        call(
          policy,
          "keyed",
          ({ signal, headers, idempotencyKey }) =>
            api.POST("/v1/sessions/{id}/push-requests", {
              params: { path: { id }, header: header(idempotencyKey) },
              body: {},
              signal,
              headers,
            }),
          options,
        ),
      list: async (id, options) =>
        (
          await call(
            policy,
            "read",
            ({ signal, headers }) =>
              api.GET("/v1/sessions/{id}/push-requests", {
                params: { path: { id } },
                signal,
                headers,
              }),
            options,
          )
        ).items,
      get: (id, pushRequestId, options) =>
        call(
          policy,
          "read",
          ({ signal, headers }) =>
            api.GET("/v1/sessions/{id}/push-requests/{push_request_id}", {
              params: { path: { id, push_request_id: pushRequestId } },
              signal,
              headers,
            }),
          options,
        ),
      decide: (id, pushRequestId, params, options) =>
        call(
          policy,
          "keyed",
          ({ signal, headers, idempotencyKey }) =>
            api.POST(
              "/v1/sessions/{id}/push-requests/{push_request_id}/decision",
              {
                params: {
                  path: { id, push_request_id: pushRequestId },
                  header: header(idempotencyKey),
                },
                body: params,
                signal,
                headers,
              },
            ),
          options,
        ),
      openPullRequest: (id, pushRequestId, params, options) =>
        call(
          policy,
          "unkeyed",
          ({ signal, headers }) =>
            api.POST(
              "/v1/sessions/{id}/push-requests/{push_request_id}/pull-request",
              {
                params: { path: { id, push_request_id: pushRequestId } },
                body: params ?? {},
                signal,
                headers,
              },
            ),
          options,
        ),
      commentPullRequest: (id, pushRequestId, params, options) =>
        call(
          policy,
          "unkeyed",
          ({ signal, headers }) =>
            api.POST(
              "/v1/sessions/{id}/push-requests/{push_request_id}/pull-request/comments",
              {
                params: { path: { id, push_request_id: pushRequestId } },
                body: params,
                signal,
                headers,
              },
            ),
          options,
        ),
    },
  };
}
