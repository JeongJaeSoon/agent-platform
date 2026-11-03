import {
  type CredentialRef,
  type InstallationSettingsStore,
  type SettingsSnapshot,
  settingsCredentialRefs,
  settingsSnapshot,
} from "@werft-ai/platform";
import type { SecretReader } from "./catalog-config.ts";

/**
 * Where the api's registry reads the installation settings from, every
 * credential resolved: a stored value from the database on each read, an
 * env reference from `env`, a Secrets Manager one once per process
 * (rotating it means a restart, as with the files). A reference that cannot
 * be read leaves its row out of that read and is tried again on the next.
 */
export function settingsSource(options: {
  store: Pick<InstallationSettingsStore, "read">;
  env: Record<string, string | undefined>;
  readSecret: SecretReader;
}): { read(): Promise<SettingsSnapshot> } {
  const fetched = new Map<string, string>();
  return {
    async read() {
      const settings = await options.store.read({ openStored: true });
      for (const ref of settingsCredentialRefs(settings)) {
        if (!("secret_id" in ref) || fetched.has(ref.secret_id)) continue;
        try {
          const value = await options.readSecret(ref.secret_id);
          if (value) fetched.set(ref.secret_id, value);
        } catch {
          // Named in left_out by the snapshot below.
        }
      }
      return settingsSnapshot(settings, (ref: CredentialRef) =>
        "value_env" in ref
          ? options.env[ref.value_env]
          : "secret_id" in ref
            ? fetched.get(ref.secret_id)
            : undefined,
      );
    },
  };
}

/**
 * The egress proxy's credential allowlist when the api is given the same
 * value: the console warns about an endpoint outside it (owner decision 4,
 * a warning only). Null when unset: the api does not know it.
 */
export function credentialHostsFromEnv(
  env: Record<string, string | undefined>,
): string[] | null {
  const lists = [
    env.EGRESS_CREDENTIAL_ALLOWLIST,
    env.EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST,
  ].filter((raw): raw is string => raw !== undefined && raw.trim() !== "");
  if (lists.length === 0) return null;
  return lists.flatMap((raw) =>
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  );
}

export function leftOutReporter(
  warn: (message: string, fields: Record<string, unknown>) => void,
): (snapshot: SettingsSnapshot) => void {
  let last = "[]";
  return (snapshot) => {
    const now = JSON.stringify(snapshot.left_out);
    if (now === last) return;
    last = now;
    if (snapshot.left_out.length > 0) {
      warn("Installation settings left out of this replica's catalog", {
        left_out: snapshot.left_out,
      });
    }
  };
}
