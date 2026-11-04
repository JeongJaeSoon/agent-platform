import { describe, test } from "bun:test";
import {
  ADAPTER_CONFORMANCE,
  type AdapterConformanceHarness,
} from "@werft-ai/runtime-core/testing/conformance";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { buildSdkOptions } from "./runtime.ts";

const config: ClaudeRuntimeConfig = {
  claudeConfigDir: "/tenant/config",
  correlationId: "conformance",
  mode: "new",
  cwd: "/tenant/workspace",
  home: "/tenant/home",
  model: "primary",
  profile: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "api_key", value: "placeholder" },
    principal: { ownerScope: "owner-a" },
  },
  tools: ["Bash"],
};

const harness: AdapterConformanceHarness = {
  engineSignature(permissionMode) {
    const { settings } = buildSdkOptions(
      { ...config, permissionMode },
      { onPermission: async () => ({ behavior: "allow" }) },
    );
    const attribution =
      typeof settings === "object" ? settings.attribution : undefined;
    return { commit: attribution?.commit, pr: attribution?.pr };
  },
  engineLaunch(gitEnvironment) {
    const { env, ...rest } = buildSdkOptions(
      { ...config, gitEnvironment },
      { onPermission: async () => ({ behavior: "allow" }) },
    );
    return { environment: env ?? {}, rest };
  },
};

describe("Claude adapter conformance", () => {
  for (const item of ADAPTER_CONFORMANCE) {
    test(item.name, () => item.check(harness));
  }
});
