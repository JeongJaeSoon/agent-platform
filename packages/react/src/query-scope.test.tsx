/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApiClient } from "@werft-ai/client";
import { type QueryScope, queryKeysOf } from "@werft-ai/core";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import {
  AgentPlatformProvider,
  QueryScopeProvider,
  useAgentPlatform,
} from "./index.ts";

const { render } = await setupDom();

const OWNER = { actor: "user:owner", workspace: "w-1" };
const MEMBER = { actor: "user:member", workspace: "w-1" };

test("the client below caches under the scope, and a new scope drops the old one's entries", () => {
  const queryClient = new QueryClient();
  const seen: ApiClient[] = [];
  function Probe() {
    seen.push(useAgentPlatform().client);
    return null;
  }
  const tree = (scope: QueryScope) => (
    <QueryClientProvider client={queryClient}>
      <AgentPlatformProvider
        client={{} as ApiClient}
        locale="en"
        renderLink={() => null}
      >
        <QueryScopeProvider scope={scope}>
          <Probe />
        </QueryScopeProvider>
      </AgentPlatformProvider>
    </QueryClientProvider>
  );
  const view = render(tree(OWNER));
  const ownerKey = queryKeysOf(seen.at(-1) as ApiClient).agents;
  expect(ownerKey[0]).toEqual(OWNER);
  queryClient.setQueryData(ownerKey, { items: ["owner's"] });
  queryClient.setQueryData(["me"], { signed_in: true });

  view.rerender(tree(MEMBER));
  const memberKey = queryKeysOf(seen.at(-1) as ApiClient).agents;
  expect(memberKey[0]).toEqual(MEMBER);
  expect(queryClient.getQueryData(ownerKey)).toBeUndefined();
  expect(queryClient.getQueryData(memberKey)).toBeUndefined();
  // Who is signed in is not any one scope's to drop.
  expect<unknown>(queryClient.getQueryData(["me"])).toEqual({
    signed_in: true,
  });
  view.unmount();
});
