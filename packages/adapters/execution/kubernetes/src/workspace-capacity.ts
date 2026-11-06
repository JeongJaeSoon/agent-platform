import { KubernetesApiError, type KubernetesClient } from "./client.ts";

export function storageBytes(quantity: string | undefined): number | undefined {
  const match = quantity?.match(
    /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/,
  );
  if (match === undefined || match === null) return;
  const suffix = match[2] ?? "";
  const exponent =
    suffix === ""
      ? 0
      : "kMGTPE".indexOf(suffix[0] === "K" ? "k" : (suffix[0] ?? "")) + 1;
  const bytes =
    Number(match[1]) * (suffix.endsWith("i") ? 1024 : 1000) ** exponent;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

export async function workspaceCapacity(
  client: Pick<KubernetesClient, "get">,
  namespace: string,
  claimName: string,
): Promise<number | undefined> {
  try {
    const claim = await client.get(
      namespace,
      "persistentvolumeclaims",
      claimName,
    );
    return storageBytes(claim?.status?.capacity?.storage);
  } catch (error) {
    if (error instanceof KubernetesApiError && error.status === 403) return;
    throw error;
  }
}
