/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ApiClientOptions, createApiClient } from "@werft-ai/client";
import { withQueryScope } from "@werft-ai/core";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import type { ReactNode } from "react";
import { AgentPlatformProvider, useMemberPages } from "./index.ts";

const { renderHook, waitFor, act } = await setupDom();

function harness(
  pages: Record<string, { items: object[]; next: string | null }>,
) {
  const sent: string[] = [];
  const fakeFetch = async (request: Request) => {
    const url = new URL(request.url);
    sent.push(`${url.pathname}${url.search}`);
    const page = pages[url.searchParams.get("cursor") ?? "first"];
    return new Response(
      JSON.stringify({ items: page?.items ?? [], next_cursor: page?.next }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const client = withQueryScope(
    createApiClient({
      baseUrl: "https://console.test",
      fetch: fakeFetch as unknown as NonNullable<ApiClientOptions["fetch"]>,
    }),
    { actor: "user:u-1", workspace: "w-1" },
  );
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AgentPlatformProvider
        client={client}
        locale="en"
        renderLink={() => null}
      >
        {children}
      </AgentPlatformProvider>
    </QueryClientProvider>
  );
  return { sent, wrapper };
}

test("member pages read one page per ask, with the search, and add the next on demand", async () => {
  const { sent, wrapper } = harness({
    first: { items: [{ user_id: "a" }], next: "c2" },
    c2: { items: [{ user_id: "b" }], next: null },
  });
  const { result } = renderHook(() => useMemberPages("kim"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(sent).toEqual(["/v1/members?q=kim"]);
  expect(result.current.hasNextPage).toBe(true);

  await act(() => result.current.fetchNextPage());
  await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  expect(sent).toEqual(["/v1/members?q=kim", "/v1/members?q=kim&cursor=c2"]);
  expect(result.current.data?.pages.flatMap((page) => page.items)).toEqual([
    { user_id: "a" },
    { user_id: "b" },
  ] as never);
});

test("member pages ask nothing while disabled", async () => {
  const { sent, wrapper } = harness({});
  const { result } = renderHook(
    () => useMemberPages(undefined, { enabled: false }),
    { wrapper },
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(result.current.isPending).toBe(true);
  expect(sent).toEqual([]);
});
