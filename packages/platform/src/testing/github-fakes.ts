import { randomBytes } from "node:crypto";

/** A GitHub OAuth client secret's shape, made per run, never written into a file. */
export function fakeGitHubClientSecret(): string {
  return randomBytes(20).toString("hex");
}
