import { randomBytes } from "node:crypto";
import {
  type SearchSlackChannelsQuery,
  type SearchSlackChannelsResponse,
  SLACK_BINDING_MESSAGES,
  SLACK_CHANNEL_SEARCH_MESSAGES,
  type SlackChannel,
} from "@werft-ai/contracts";
import { z } from "zod";
import type { SecretStore } from "../ports/secret-store.ts";
import type { SlackAppStore } from "../ports/slack-app-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import type { AgentAuthority, AuthorizationPolicy, Caller } from "./policy.ts";
import {
  SLACK_API_URL,
  SLACK_HTTP_TIMEOUT_MS,
  SlackApiError,
} from "./slack-config-api.ts";
import type { SurfaceBindingService } from "./surface-binding-service.ts";

// The channel picker's search (94S-898): one app's whole channel list is read
// from Slack into a short cache, then filtered and paged here, so typing in
// the picker costs no Slack call. The cursor is ours, not Slack's: it names
// the cached list it pages through and stops working once that list is
// replaced.
//
// conversations.list is Slack's Tier 2 (20+ per minute):
// https://docs.slack.dev/reference/methods/conversations.list
// When 94S-791's bot-token Slack client lands, `createSlackChannelApi` moves
// into it as one more method.

export const SLACK_CHANNEL_CACHE_TTL_MS = 60_000;
/** Channels kept per app; past this the list says `truncated`. */
export const SLACK_CHANNEL_CACHE_MAX_CHANNELS = 10_000;
/** Apps cached at once; the least recently used is dropped first. */
export const SLACK_CHANNEL_CACHE_MAX_APPS = 500;
/** Slack advises no more than 200 per page. */
export const SLACK_CHANNEL_PAGE_SIZE = 200;
/** Used when a 429 carries no readable Retry-After. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

const ACTION = "binding.manage";

/** Slack answered 429: no call before `retryAfterSeconds` have passed. */
export class SlackRateLimitedError extends SlackApiError {
  constructor(
    method: string,
    readonly retryAfterSeconds: number,
  ) {
    super(method, "ratelimited", true);
    this.name = "SlackRateLimitedError";
  }
}

export type SlackChannelPage = {
  channels: SlackChannel[];
  nextCursor: string | null;
};

export interface SlackChannelApi {
  /** One page of the public channels and the private ones the bot is in. */
  listChannels(
    botToken: string,
    cursor: string | null,
  ): Promise<SlackChannelPage>;
}

const listAnswer = z.object({
  channels: z.array(
    z.object({
      id: z.string().regex(/^[A-Z0-9]{1,64}$/),
      name: z.string().min(1).max(255),
      is_private: z.boolean().default(false),
      is_member: z.boolean().default(false),
      is_archived: z.boolean().default(false),
    }),
  ),
  response_metadata: z
    .object({ next_cursor: z.string().max(4096).optional() })
    .optional(),
});

const ERROR_CODE = /^[a-z_]{1,64}$/;

function retryAfterOf(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isSafeInteger(seconds) && seconds > 0
    ? seconds
    : DEFAULT_RETRY_AFTER_SECONDS;
}

export function createSlackChannelApi(options?: {
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SlackChannelApi {
  const apiUrl = (options?.apiUrl ?? SLACK_API_URL).replace(/\/+$/, "");
  const fetchImpl = options?.fetch ?? fetch;
  const timeoutMs = options?.timeoutMs ?? SLACK_HTTP_TIMEOUT_MS;
  const method = "conversations.list";

  return {
    async listChannels(botToken, cursor) {
      const body = new URLSearchParams({
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: String(SLACK_CHANNEL_PAGE_SIZE),
        ...(cursor === null ? {} : { cursor }),
      });
      let response: Response;
      try {
        response = await fetchImpl(`${apiUrl}/${method}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${botToken}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new SlackApiError(
          method,
          error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : "unreachable",
          false,
        );
      }
      if (response.status === 429) {
        await response.body?.cancel();
        throw new SlackRateLimitedError(method, retryAfterOf(response));
      }
      const answer = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (answer === null || typeof answer !== "object") {
        throw new SlackApiError(method, `http_${response.status}`, false);
      }
      if (answer.ok !== true) {
        const code =
          typeof answer.error === "string" && ERROR_CODE.test(answer.error)
            ? answer.error
            : `http_${response.status}`;
        throw new SlackApiError(method, code, response.status < 500);
      }
      const parsed = listAnswer.safeParse(answer);
      if (!parsed.success) {
        throw new SlackApiError(method, "unexpected_answer", false);
      }
      return {
        channels: parsed.data.channels
          .filter((channel) => !channel.is_archived)
          .map((channel) => ({
            id: channel.id,
            name: channel.name,
            is_private: channel.is_private,
            is_member: channel.is_member,
          })),
        nextCursor: parsed.data.response_metadata?.next_cursor || null,
      };
    },
  };
}

type Snapshot = {
  id: string;
  /** Sorted by name. */
  channels: readonly SlackChannel[];
  truncated: boolean;
  readAt: number;
};

type Slot = {
  snapshot: Snapshot | null;
  /** Slack's Retry-After, as a time: no call to Slack for this app before it. */
  blockedUntil: number;
};

export type SlackChannelLookup = {
  snapshot: Snapshot;
  cache: "hit" | "miss" | "stale";
};

/**
 * Per-process cache of each app's channel list, keyed by our slack app id.
 * Concurrent misses on one key share one read. A read already running when
 * the key is invalidated still answers its callers but is not kept.
 */
export function createSlackChannelCache(options?: {
  ttlMs?: number;
  maxChannels?: number;
  maxApps?: number;
  now?: () => number;
}) {
  const ttlMs = options?.ttlMs ?? SLACK_CHANNEL_CACHE_TTL_MS;
  const maxChannels = options?.maxChannels ?? SLACK_CHANNEL_CACHE_MAX_CHANNELS;
  const maxApps = options?.maxApps ?? SLACK_CHANNEL_CACHE_MAX_APPS;
  const now = options?.now ?? (() => Date.now());
  // Map order is the LRU order: oldest first.
  const slots = new Map<string, Slot>();
  // Reads in flight are not evicted with their slot: a key pushed out
  // mid-read still shares that read and keeps its result.
  const reads = new Map<string, Promise<Snapshot>>();

  function touch(key: string, slot: Slot) {
    slots.delete(key);
    slots.set(key, slot);
    while (slots.size > maxApps) {
      slots.delete(slots.keys().next().value as string);
    }
  }

  async function readAll(
    key: string,
    listPage: (cursor: string | null) => Promise<SlackChannelPage>,
  ): Promise<Snapshot> {
    const channels: SlackChannel[] = [];
    let cursor: string | null = null;
    let truncated = false;
    try {
      do {
        const page = await listPage(cursor);
        channels.push(...page.channels);
        cursor = page.nextCursor;
        if (channels.length > maxChannels) {
          truncated = true;
          break;
        }
      } while (cursor !== null);
    } catch (error) {
      if (error instanceof SlackRateLimitedError) {
        const slot = slots.get(key) ?? { snapshot: null, blockedUntil: 0 };
        slot.blockedUntil = now() + error.retryAfterSeconds * 1000;
        touch(key, slot);
      }
      throw error;
    }
    channels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      id: randomBytes(9).toString("base64url"),
      channels: channels.slice(0, maxChannels),
      truncated,
      readAt: now(),
    };
  }

  return {
    /** The cached list of `key`, reading it from Slack when it has expired. */
    async lookup(
      key: string,
      listPage: () => Promise<
        (cursor: string | null) => Promise<SlackChannelPage>
      >,
    ): Promise<SlackChannelLookup> {
      const slot = slots.get(key);
      const cached = slot?.snapshot ?? null;
      if (slot && cached && now() - cached.readAt < ttlMs) {
        touch(key, slot);
        return { snapshot: cached, cache: "hit" };
      }
      if (slot && now() < slot.blockedUntil) {
        if (cached) {
          touch(key, slot);
          return { snapshot: cached, cache: "stale" };
        }
        throw new SlackRateLimitedError(
          "conversations.list",
          Math.ceil((slot.blockedUntil - now()) / 1000),
        );
      }
      let read = reads.get(key);
      if (read === undefined) {
        const started = (async () => readAll(key, await listPage()))();
        read = started;
        reads.set(key, started);
        started.then(
          (snapshot) => {
            if (reads.get(key) !== started) return;
            reads.delete(key);
            const current = slots.get(key) ?? {
              snapshot: null,
              blockedUntil: 0,
            };
            current.snapshot = snapshot;
            touch(key, current);
          },
          () => {
            if (reads.get(key) === started) reads.delete(key);
          },
        );
      }
      try {
        return { snapshot: await read, cache: "miss" };
      } catch (error) {
        const fallback = slots.get(key)?.snapshot ?? null;
        if (error instanceof SlackRateLimitedError && fallback) {
          return { snapshot: fallback, cache: "stale" };
        }
        throw error;
      }
    },

    /**
     * The cached snapshot when it is still the one `snapshotId` names; stale
     * while Slack is rate limiting the app, as the first page was.
     */
    held(key: string, snapshotId: string): SlackChannelLookup | null {
      const slot = slots.get(key);
      if (!slot?.snapshot || slot.snapshot.id !== snapshotId) return null;
      touch(key, slot);
      return {
        snapshot: slot.snapshot,
        cache: now() < slot.blockedUntil ? "stale" : "hit",
      };
    },

    /** Forgets the list, keeping any rate limit Slack set. */
    invalidate(key: string): void {
      reads.delete(key);
      const slot = slots.get(key);
      if (slot) slot.snapshot = null;
    },

    size: () => slots.size,
  };
}

export type SlackChannelCache = ReturnType<typeof createSlackChannelCache>;

type CursorState = { snapshot: string; offset: number; q: string };

const cursorShape = z
  .object({
    s: z.string().min(1).max(64),
    o: z.number().int().positive(),
    q: z.string().max(255),
  })
  .strict();

function encodeCursor(state: CursorState): string {
  return Buffer.from(
    JSON.stringify({ s: state.snapshot, o: state.offset, q: state.q }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): CursorState {
  let raw: unknown = null;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {}
  const parsed = cursorShape.safeParse(raw);
  if (!parsed.success) {
    throw new SessionServiceError("BAD_REQUEST", "Invalid cursor");
  }
  return { snapshot: parsed.data.s, offset: parsed.data.o, q: parsed.data.q };
}

/** Lower case, without a leading `#` or surrounding space. */
export function normalizeChannelQuery(q: string): string {
  return q.trim().replace(/^#+/, "").toLowerCase();
}

// Slack's answers for a bot token that no longer works.
const TOKEN_GONE = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

const notInstalled = () =>
  new SessionServiceError(
    "SLACK_NOT_INSTALLED",
    SLACK_BINDING_MESSAGES.notInstalled,
  );

export type SlackChannelSearchResult = {
  page: SearchSlackChannelsResponse;
  slackAppId: string;
  cache: SlackChannelLookup["cache"];
};

export function createSlackChannelSearchService(deps: {
  authorization: AuthorizationPolicy;
  agents: Pick<AgentAuthority, "agentOf">;
  /** Null when the API runs without a master key. */
  apps: Pick<SlackAppStore, "findForAgent"> | null;
  secrets: Pick<SecretStore, "get"> | null;
  api: SlackChannelApi;
  cache?: SlackChannelCache;
}) {
  const { authorization, api } = deps;
  const cache = deps.cache ?? createSlackChannelCache();

  return {
    cache,

    /** Drops the cached channels of the agent's app, if it has one. */
    async forgetAgent(workspaceId: string, agentId: string): Promise<void> {
      const app = await deps.apps?.findForAgent(workspaceId, agentId);
      if (app) cache.invalidate(app.id);
    },

    async searchSlackChannels(
      caller: Caller,
      agentId: string,
      query: SearchSlackChannelsQuery,
    ): Promise<SlackChannelSearchResult> {
      await requirePermitted(authorization, caller, ACTION, {
        kind: "agent",
        id: agentId,
      });
      if (deps.apps === null || deps.secrets === null) {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
        );
      }
      const secrets = deps.secrets;
      const app = await deps.apps.findForAgent(caller.ownerId, agentId);
      if (app === null || app.state !== "created") {
        // The policy lets an owner through for any id; an agent of another
        // workspace, or none, is not found rather than not installed.
        const agent = await deps.agents.agentOf(caller.ownerId, {
          kind: "agent",
          id: agentId,
        });
        throw agent === null
          ? new SessionServiceError("NOT_FOUND", "Resource not found")
          : notInstalled();
      }
      const q = normalizeChannelQuery(query.q);
      const from =
        query.cursor === undefined ? null : decodeCursor(query.cursor);
      if (from !== null && from.q !== q) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "The cursor belongs to another search",
        );
      }

      let lookup: SlackChannelLookup;
      const held = from === null ? null : cache.held(app.id, from.snapshot);
      if (held !== null) {
        lookup = held;
      } else if (from !== null) {
        throw new SessionServiceError(
          "CURSOR_EXPIRED",
          SLACK_CHANNEL_SEARCH_MESSAGES.cursorExpired,
        );
      } else {
        try {
          lookup = await cache.lookup(app.id, async () => {
            const botToken = await secrets.get({
              workspaceId: app.workspaceId,
              owner: { kind: "slack_app", id: app.id },
              purpose: "slack_bot_token",
            });
            if (botToken === null) throw notInstalled();
            return (cursor) => api.listChannels(botToken, cursor);
          });
        } catch (error) {
          if (error instanceof SlackRateLimitedError) {
            throw new SessionServiceError(
              "BACKEND_UNAVAILABLE",
              SLACK_CHANNEL_SEARCH_MESSAGES.rateLimited,
              { afterSeconds: error.retryAfterSeconds },
            );
          }
          if (error instanceof SlackApiError) {
            if (error.answered && TOKEN_GONE.has(error.code)) {
              throw notInstalled();
            }
            throw new SessionServiceError(
              "BACKEND_UNAVAILABLE",
              `Slack did not answer ${error.method}; try again`,
            );
          }
          throw error;
        }
      }

      const { snapshot } = lookup;
      const matches =
        q === ""
          ? snapshot.channels
          : snapshot.channels.filter((channel) =>
              channel.name.toLowerCase().startsWith(q),
            );
      const offset = from?.offset ?? 0;
      const end = offset + query.limit;
      return {
        page: {
          items: matches.slice(offset, end),
          next_cursor:
            end < matches.length
              ? encodeCursor({ snapshot: snapshot.id, offset: end, q })
              : null,
          truncated: snapshot.truncated,
          stale: lookup.cache === "stale",
        },
        slackAppId: app.id,
        cache: lookup.cache,
      };
    },
  };
}

export type SlackChannelSearchService = ReturnType<
  typeof createSlackChannelSearchService
>;

/**
 * The binding service, with a set binding also dropping that agent's cached
 * channels in this process. Other processes wait out the TTL. The binding is
 * already written when the drop runs, so a failed drop is not the PUT's error.
 */
export function forgettingChannelsOnBindingPut(
  bindings: SurfaceBindingService,
  search: Pick<SlackChannelSearchService, "forgetAgent">,
): SurfaceBindingService {
  return {
    ...bindings,
    async putSlackBinding(caller, agentId, request) {
      const set = await bindings.putSlackBinding(caller, agentId, request);
      await search.forgetAgent(caller.ownerId, agentId).catch(() => {});
      return set;
    },
  };
}
