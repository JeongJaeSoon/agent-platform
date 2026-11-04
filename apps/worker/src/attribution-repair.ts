import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  type BootstrapClaimResponse,
  IMAGE_GIT_AUTHOR,
  type WorkerScope,
} from "@werft-ai/contracts";
import {
  type AttributionExpectation,
  type AttributionMismatch,
  rangeAttribution,
  type WorkerGatewayClient,
} from "@werft-ai/runtime-core";
import type { WorkerLogger } from "./worker-host.ts";

const run = promisify(execFile);

/** Where the image installs the repair tool (apps/worker/Dockerfile). */
export const REPAIR_TOOL_PATH = "/usr/local/bin/werft-repair-attribution";
const REPAIR_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 30_000;

export type RepairOutcome =
  | { status: "clean" }
  | { status: "repaired" }
  /** Two of the session's commits are parents of one merge; nothing written. */
  | { status: "nested_merge" }
  /** Not attempted: no tool, no server answer. The pushes' checks still hold. */
  | { status: "skipped"; reason: string }
  | { status: "failed"; detail: string };

/**
 * What the claim asked this session's commits to carry, or null when it asked
 * for nothing checkable (a server without `git` or `git_author`). The server
 * keeps the same values for the push's own check.
 */
export function claimExpectation(
  claim: Pick<BootstrapClaimResponse, "session_id" | "git" | "git_author">,
): AttributionExpectation | null {
  if (claim.git === undefined || claim.git_author === undefined) return null;
  return {
    author: claim.git_author ?? IMAGE_GIT_AUTHOR,
    coAuthor: claim.git.co_author ?? null,
    agentSession: claim.git.session_url ?? claim.session_id,
  };
}

/**
 * At a turn's end, with the checkpoint lease held and the engine stopped:
 * remakes this session's own commits whose attribution is wrong. The tool
 * (apps/worker/git-hooks/werft-repair-attribution) is plumbing only and writes
 * one ref update at the end, or nothing. Never throws: a repair that cannot
 * run leaves the commits for the request_push and push checks to refuse.
 */
export async function repairAttribution(input: {
  root: string;
  home: string;
  /** Absent outside the image. */
  tool: string | undefined;
  gateway: Partial<Pick<WorkerGatewayClient, "protectedCommits">>;
  scope: WorkerScope;
  /** A directory this call may write one file into. */
  spool: string;
  logger: WorkerLogger;
}): Promise<RepairOutcome> {
  const { tool, gateway } = input;
  if (tool === undefined) return { status: "skipped", reason: "no_tool" };
  if (gateway.protectedCommits === undefined) {
    return { status: "skipped", reason: "no_gateway_route" };
  }
  let commits: readonly string[];
  try {
    commits = (await gateway.protectedCommits(input.scope)).commits;
  } catch (error) {
    // An older server has no route; a failing one leaves the commits to the
    // pushes' checks. Remaking without the boundary could rewrite pushed
    // history, so there is no repair without it.
    return {
      status: "skipped",
      reason: `protected_commits: ${error instanceof Error ? error.name : "error"}`,
    };
  }
  const file = `${input.spool}/protected-commits`;
  await writeFile(file, `${commits.join("\n")}\n`);
  try {
    const { stdout } = await run(tool, [input.root, file], {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: input.home,
        TMPDIR: input.spool,
        // Where git finds the system config, when it is not /etc/gitconfig.
        ...(process.env.GIT_CONFIG_SYSTEM === undefined
          ? {}
          : { GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM }),
      },
      timeout: REPAIR_TIMEOUT_MS,
    });
    const line = stdout.trim();
    return line.startsWith("repaired ")
      ? { status: "repaired" }
      : { status: "clean" };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    if (failure.code === 2) return { status: "nested_merge" };
    input.logger.warn("worker.attribution_repair.failed", {
      detail: (failure.stdout ?? "").trim().slice(0, 200),
    });
    return {
      status: "failed",
      detail: (failure.stdout ?? "").trim().slice(0, 200),
    };
  }
}

/**
 * The commits this workspace holds that no remote-tracking ref does, judged
 * against the claim's values. Advice for request_push: the worker shares a
 * container with the agent, and the push re-checks from what the server
 * issued. Empty when nothing is wrong or the check could not run.
 */
export async function workspaceMismatches(input: {
  root: string;
  tip: string;
  expectation: AttributionExpectation | null;
  stripEmails: readonly string[];
}): Promise<AttributionMismatch[]> {
  if (input.expectation === null) return [];
  try {
    const judged = await rangeAttribution(
      async (args) => {
        try {
          const { stdout } = await run(
            "git",
            [
              "-c",
              "core.fsmonitor=false",
              "-c",
              "core.hooksPath=/dev/null",
              ...args,
            ],
            {
              cwd: input.root,
              env: {
                PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_TERMINAL_PROMPT: "0",
                LC_ALL: "C",
              },
              maxBuffer: 16 * 1024 * 1024,
              timeout: GIT_TIMEOUT_MS,
            },
          );
          return { exitCode: 0, stdout };
        } catch (error) {
          return {
            exitCode: (error as { code?: number }).code ?? 1,
            stdout: "",
          };
        }
      },
      {
        tip: input.tip,
        not: ["--remotes"],
        expectations: [input.expectation],
        stripEmails: input.stripEmails,
      },
    );
    return judged.status === "ok" ? judged.mismatches : [];
  } catch {
    return [];
  }
}
