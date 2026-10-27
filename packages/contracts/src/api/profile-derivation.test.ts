import { describe, expect, test } from "bun:test";
import { narrowOnlyPolicy } from "./profile-derivation.ts";
import { PERMISSION_MODE_VALUES } from "./session.ts";

const UNATTENDED = ["bypassPermissions", "auto", "dontAsk"] as const;

describe("narrowOnlyPolicy", () => {
  test("never offers or accepts an unattended mode over an attended base", () => {
    for (const mode of PERMISSION_MODE_VALUES) {
      const base = { model: "m", tools: [], permission_mode: mode };
      const offered = narrowOnlyPolicy.choices(base).permission_modes;
      expect(offered).toContain(mode);
      if ((UNATTENDED as readonly string[]).includes(mode)) continue;
      for (const unattended of UNATTENDED) {
        expect(offered).not.toContain(unattended);
        expect(
          narrowOnlyPolicy.refusal(base, {
            model: "m",
            models: ["m"],
            tools: [],
            permission_mode: unattended,
          })?.field,
        ).toBe("permission_mode");
      }
    }
  });
});
