import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  TranscriptEntry,
  TranscriptMirror,
} from "@agent-platform/runtime-core";

/**
 * The entry uuids of the transcript a resumed run continues. A send whose uuid
 * is already in it is deduplicated by the engine and never answered (94S-91,
 * 94S-242), so the host has to know before it sends, not after.
 *
 * Every entry's uuid counts, not only user messages': an input the engine
 * folded into a queued command or wrote on a branch is still one it will not
 * run again, and the uuids the host generates never collide with the ones the
 * engine does.
 */
export class ResumedHistory {
  readonly #settle = Promise.withResolvers<ReadonlySet<string>>();

  private constructor() {
    // Nobody may ask before the run ends, and an unobserved rejection is noise.
    this.#settle.promise.catch(() => {});
  }

  /** A new engine session holds nothing yet. */
  static empty(): ResumedHistory {
    const history = new ResumedHistory();
    history.#settle.resolve(new Set());
    return history;
  }

  /**
   * Reads the transcript a local resume hands the engine: the CLI's own file
   * under `<config dir>/projects/<sanitized cwd>/`. Deliberately minimal — the
   * CLI shortens directory names past 200 characters with a hash this does
   * not reproduce, so such a path reads as missing and the run fails closed.
   * Only local tools resume this way; a checkpoint resume goes through
   * `watching`.
   */
  static fromLocalDisk(
    claudeConfigDir: string,
    cwd: string,
    sessionId: string,
  ): ResumedHistory {
    const history = new ResumedHistory();
    const path = join(
      claudeConfigDir,
      "projects",
      cwd.replaceAll(/[^a-zA-Z0-9]/g, "-"),
      `${sessionId}.jsonl`,
    );
    void (async () => {
      try {
        const text = await readFile(path, "utf8");
        history.#settle.resolve(
          uuidsOf(
            text
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as TranscriptEntry),
          ),
        );
      } catch (error) {
        history.#settle.reject(
          new Error(
            `The resumed transcript for session ${sessionId} could not be read: ${describe(error)}`,
          ),
        );
      }
    })();
    return history;
  }

  /**
   * Wraps the mirror a checkpoint resume hands the engine, so the history is
   * exactly what the engine loaded — the SDK reads the root transcript once,
   * in this process, before it spawns the CLI. No second read, and no second
   * guess at the key it used.
   */
  static watching(store: TranscriptMirror): {
    history: ResumedHistory;
    store: TranscriptMirror;
  } {
    const history = new ResumedHistory();
    const watched: TranscriptMirror = {
      ...(store.revisionScoped === undefined
        ? {}
        : { revisionScoped: store.revisionScoped }),
      append: (key, entries) => store.append(key, entries),
      listSubkeys: (key) => store.listSubkeys(key),
      load: async (key) => {
        if (key.subpath !== undefined) return store.load(key);
        try {
          const entries = await store.load(key);
          if (entries === null) {
            history.#settle.reject(
              new Error(
                `The resumed transcript for session ${key.sessionId} is empty`,
              ),
            );
          } else {
            history.#settle.resolve(uuidsOf(entries));
          }
          return entries;
        } catch (error) {
          history.#settle.reject(
            new Error(
              `The resumed transcript for session ${key.sessionId} could not be loaded: ${describe(error)}`,
            ),
          );
          throw error;
        }
      },
    };
    return { history, store: watched };
  }

  uuids(): Promise<ReadonlySet<string>> {
    return this.#settle.promise;
  }

  /** The engine is gone; a load it never made will not come. No-op once settled. */
  abandon(): void {
    this.#settle.reject(
      new Error("The engine ended before it loaded the resumed transcript"),
    );
  }
}

function uuidsOf(entries: readonly TranscriptEntry[]): ReadonlySet<string> {
  return new Set(
    entries.flatMap((entry) =>
      typeof entry.uuid === "string" ? [entry.uuid] : [],
    ),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
