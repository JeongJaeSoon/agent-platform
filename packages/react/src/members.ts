import { useInfiniteQuery } from "@tanstack/react-query";
import { memberPagesQuery } from "@werft-ai/core";
import { useWerft } from "./provider.tsx";

/**
 * The workspace's members a page at a time, searched on the server by `q`.
 * Only owners and admins may list them; others pass `enabled: false`.
 */
export function useMemberPages(q?: string, { enabled = true } = {}) {
  const { client } = useWerft();
  return useInfiniteQuery({ ...memberPagesQuery(client, q), enabled });
}
