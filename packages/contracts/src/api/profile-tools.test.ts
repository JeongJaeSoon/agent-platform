import { describe, expect, test } from "bun:test";
import { narrowOnlyPolicy } from "./profile-derivation.ts";
import {
  addedTools,
  carriedDeny,
  denyOf,
  firstVersionDeny,
  parseToolNames,
  type ToolCatalogView,
  toolsUnder,
  unsupportedTools,
} from "./profile-tools.ts";

const CATALOG: ToolCatalogView = {
  id: "engine@2",
  tools: [
    { name: "Read", boundary: "local" },
    { name: "Edit", boundary: "local" },
    { name: "Bash", boundary: "local" },
    { name: "Agent", boundary: "local" },
    { name: "WebFetch", boundary: "egress" },
    { name: "WebSearch", boundary: "provider" },
  ],
  aliases: { Task: "Agent" },
};
// The options response carries no aliases.
const LISTED: ToolCatalogView = { id: CATALOG.id, tools: CATALOG.tools };

describe("a deny against a tool catalog", () => {
  test("reads an allow list as what it leaves out, through aliases, with mcp__ names left aside", () => {
    expect(denyOf(CATALOG, ["Read", "Task", "mcp__github__get_file"])).toEqual([
      "Edit",
      "Bash",
      "WebFetch",
      "WebSearch",
    ]);
    expect(denyOf(CATALOG, [])).toEqual(CATALOG.tools.map((t) => t.name));
    expect(unsupportedTools(CATALOG, ["Read", "Task", "TodoWrite"])).toEqual([
      "TodoWrite",
    ]);
    expect(unsupportedTools(CATALOG, ["mcp__github__get_file"])).toEqual([]);
  });

  test("runs the catalog less the deny, nothing outside the catalog, in the allowed list's spelling", () => {
    expect(toolsUnder(CATALOG, ["Bash", "WebSearch"])).toEqual([
      "Read",
      "Edit",
      "Agent",
      "WebFetch",
    ]);
    expect(toolsUnder(CATALOG, [])).toEqual(CATALOG.tools.map((t) => t.name));
    expect(
      toolsUnder(CATALOG, ["Edit"], ["Task", "Edit", "TodoWrite", "mcp__x__y"]),
    ).toEqual(["Task"]);
    expect(toolsUnder(CATALOG, ["Task"], ["Agent", "Read"])).toEqual(["Read"]);
  });

  test("takes whole catalog names only, aliases turned into the current name", () => {
    expect(parseToolNames(CATALOG, ["WebSearch", "Task", "Agent"])).toEqual({
      names: ["Agent", "WebSearch"],
    });
    for (const [name, reason] of [
      ["mcp__github__get_file", "mcp_tool"],
      ["Bash(rm:*)", "tool_pattern"],
      ["Bash(*)", "tool_pattern"],
      ["Bash ", "tool_pattern"],
      ["TodoWrite", "unknown_tool"],
      ["bash", "unknown_tool"],
    ] as const) {
      const parsed = parseToolNames(CATALOG, ["Read", name]);
      expect("refusal" in parsed && parsed.refusal.reason_code).toBe(reason);
    }
  });

  test("a first version starts with the provider-side tools blocked", () => {
    expect(firstVersionDeny(CATALOG)).toEqual(["WebSearch"]);
  });
});

describe("tools a previous version never weighed", () => {
  test("an allow list weighed only what it allowed", () => {
    expect(addedTools(CATALOG, { tools: ["Read", "Edit"] })).toEqual([
      "Bash",
      "Agent",
      "WebFetch",
      "WebSearch",
    ]);
    expect(
      addedTools(CATALOG, { tools: ["Read", "Task"], deny: null }),
    ).toEqual(["Edit", "Bash", "WebFetch", "WebSearch"]);
  });

  test("a deny weighed its tools and its deny, so a catalog grown under the same id is caught", () => {
    expect(
      addedTools(CATALOG, {
        tools: ["Read", "Edit", "Agent", "WebFetch"],
        deny: ["Bash", "WebSearch"],
      }),
    ).toEqual([]);
    expect(
      addedTools(CATALOG, {
        tools: ["Read", "Edit", "Bash"],
        deny: ["WebSearch"],
      }),
    ).toEqual(["Agent", "WebFetch"]);
  });

  test("a next version starts from the previous blocks plus every added tool", () => {
    expect(
      carriedDeny(CATALOG, { tools: ["Read", "Edit", "Bash"], deny: ["Task"] }),
    ).toEqual(["Agent", "WebFetch", "WebSearch"]);
    expect(carriedDeny(CATALOG, { tools: ["Read", "Bash"] })).toEqual([
      "Edit",
      "Agent",
      "WebFetch",
      "WebSearch",
    ]);
    expect(carriedDeny(CATALOG, { tools: [], deny: [] })).toEqual(
      CATALOG.tools.map((t) => t.name),
    );
  });
});

describe("the workspace derivation with a catalog", () => {
  const base = {
    model: "m",
    tools: ["Read", "Edit", "Bash", "TodoWrite"],
    permission_mode: "default" as const,
  };

  test("starts from the base's blocks, and leaves names outside the catalog out of tools", () => {
    expect(narrowOnlyPolicy.initial(base, LISTED)).toMatchObject({
      tools: ["Read", "Edit", "Bash"],
      deny: ["Agent", "WebFetch", "WebSearch"],
    });
    expect(narrowOnlyPolicy.initial(base)).toMatchObject({
      tools: base.tools,
    });
    expect("deny" in narrowOnlyPolicy.initial(base)).toBe(false);
  });

  test("offers every catalog tool to block and fixes the base's", () => {
    expect(narrowOnlyPolicy.choices(base, LISTED).deny).toEqual({
      names: ["Read", "Edit", "Bash", "Agent", "WebFetch", "WebSearch"],
      fixed: ["Agent", "WebFetch", "WebSearch"],
    });
    expect(narrowOnlyPolicy.choices(base).deny).toBeUndefined();
  });

  test("carries the previous version's blocks, the base's, and what it never weighed", () => {
    const previous = {
      model: "m",
      models: ["m"],
      tools: ["Read"],
      permission_mode: "default" as const,
    };
    const carried = narrowOnlyPolicy.carry(previous, base, LISTED);
    expect(carried.deny).toEqual([
      "Edit",
      "Bash",
      "Agent",
      "WebFetch",
      "WebSearch",
    ]);
    expect(carried.tools).toEqual(["Read"]);
    expect(narrowOnlyPolicy.refusal(base, carried)).toBeNull();
    const weighed = narrowOnlyPolicy.carry(
      { ...previous, tools: ["Read", "Edit"], deny: ["Bash", "Agent"] },
      base,
      LISTED,
    );
    expect(weighed.deny).toEqual(["Bash", "Agent", "WebFetch", "WebSearch"]);
    expect(weighed.tools).toEqual(["Read", "Edit"]);
    expect(narrowOnlyPolicy.carry(previous, base).tools).toEqual(["Read"]);
  });
});
