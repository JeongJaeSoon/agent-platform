import type { ApiErrorCode } from "@werft-ai/contracts";

/**
 * Whether a session's release pins GitHub settings (`policy_pins.github`).
 * This server issues no GitHub token to such a session: it cannot narrow a
 * token to them yet, and running the release as if it had none would hand
 * it everything its profile allows.
 */
export interface SessionGitHubSettings {
  /** False for a release without them, and for a session with no release. */
  pinned(sessionId: string): Promise<boolean>;
}

export const GITHUB_SETTINGS_UNSUPPORTED: {
  code: ApiErrorCode;
  message: string;
} = {
  code: "GITHUB_REFUSED",
  message:
    "The session's release has GitHub settings this server cannot apply yet",
};
