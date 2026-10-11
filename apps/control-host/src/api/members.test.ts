import { describe, expect, test } from "bun:test";
import { parseMembersCommand } from "./members.ts";

const USER = "019A0000-0000-7000-8000-0000000000C1";
const OWNER = "019a0000-0000-7000-8000-0000000000c2";

describe("members CLI arguments", () => {
  test("offboard <user_id> --by <owner_user_id>", () => {
    expect(parseMembersCommand(["offboard", USER, "--by", OWNER])).toEqual({
      command: "offboard",
      userId: USER.toLowerCase(),
      byUserId: OWNER,
    });
  });

  test("refuses a missing actor, a non-UUID or anything extra", () => {
    expect(() => parseMembersCommand(["offboard", USER])).toThrow("Usage");
    expect(() =>
      parseMembersCommand(["offboard", "alice", "--by", OWNER]),
    ).toThrow("must be UUIDs");
    expect(() =>
      parseMembersCommand(["offboard", USER, "extra", "--by", OWNER]),
    ).toThrow("Usage");
    expect(() => parseMembersCommand(["disable", USER, "--by", OWNER])).toThrow(
      "Usage",
    );
    expect(() =>
      parseMembersCommand(["offboard", USER, "--as", OWNER]),
    ).toThrow("Usage");
  });
});
