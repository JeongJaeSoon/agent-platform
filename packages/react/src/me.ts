import { meQuery } from "@agent-platform/core";
import { useQuery } from "@tanstack/react-query";
import { useAgentPlatform } from "./provider.tsx";

/** The signed-in principal: who it is, its workspace and its permissions. */
export function useMe() {
  const { client } = useAgentPlatform();
  return useQuery(meQuery(client));
}
