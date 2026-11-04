import { useQuery } from "@tanstack/react-query";
import { meQuery } from "@werft-ai/core";
import { useWerft } from "./provider.tsx";

/** The signed-in principal: who it is, its workspace and its permissions. */
export function useMe() {
  const { client } = useWerft();
  return useQuery(meQuery(client));
}
