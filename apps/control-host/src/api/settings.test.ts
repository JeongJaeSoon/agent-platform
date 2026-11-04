import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseSettingsDocument,
  type SettingsDocumentStore,
  type SettingsEntries,
  type SettingsImportResult,
} from "@werft-ai/platform";
import {
  documentFromDir,
  parseSettingsCommand,
  runSettingsCommand,
} from "./settings.ts";

const FAKE_MODEL_DIR = resolve(
  import.meta.dir,
  "../../../../config/fake-model",
);

const PLAN = {
  add: [],
  unchanged: [],
  inactive: [],
  needs_value: [],
  conflicts: [],
  refused_external: [],
};

function fakeStore(result: SettingsImportResult) {
  const asked: Array<Parameters<SettingsDocumentStore["importEntries"]>> = [];
  const store: Pick<SettingsDocumentStore, "exportEntries" | "importEntries"> =
    {
      exportEntries: async () => ({
        entries: {
          connections: {
            main: {
              kind: "anthropic",
              endpoint: "https://api.anthropic.invalid",
              auth: { kind: "api_key", stored: "connection:main" },
            },
          },
          repositories: {},
          mcp_servers: {},
        },
        last4: new Map([["connection:main", "wxyz"]]),
      }),
      importEntries: async (...args) => {
        asked.push(args);
        return result;
      },
    };
  return { store, asked };
}

function captured() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    output: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    },
  };
}

describe("settings CLI arguments", () => {
  test("export takes nothing; import takes one source and --dry-run", () => {
    expect(parseSettingsCommand(["export"])).toEqual({ command: "export" });
    expect(
      parseSettingsCommand(["import", "--document", "s.json", "--dry-run"]),
    ).toEqual({
      command: "import",
      source: { document: "s.json" },
      dryRun: true,
    });
    expect(
      parseSettingsCommand(["import", "--from-dir", "/app/config"]),
    ).toEqual({
      command: "import",
      source: { dir: "/app/config" },
      dryRun: false,
    });
  });

  test("no source, two sources, an unknown command or option is refused", () => {
    for (const argv of [
      ["import"],
      ["import", "--document", "a", "--from-dir", "b"],
      ["export", "--dry-run"],
      ["export", "extra"],
      ["apply"],
      ["import", "--document", "a", "--force"],
    ]) {
      expect(() => parseSettingsCommand(argv)).toThrow("Usage:");
    }
  });
});

describe("settings CLI", () => {
  test("--from-dir turns the old files into the document, the fake-messages connection included, and says what it leaves out", async () => {
    const { document, notes } = await documentFromDir(FAKE_MODEL_DIR);
    const entries = parseSettingsDocument(document);
    expect(Object.keys(entries.connections)).toEqual(["fake-messages"]);
    expect(entries.connections["fake-messages"]).toMatchObject({
      kind: "anthropic",
      endpoint: "http://fake-messages:4010",
    });
    expect(Object.keys(entries.repositories)).toEqual(["sample-app"]);
    expect(Object.keys(entries.mcp_servers)).toEqual(["fake"]);
    expect(notes).toEqual([
      expect.stringContaining(
        "profiles.yaml is not part of the settings document",
      ),
    ]);
    expect(document).not.toHaveProperty("profiles");
  });

  test("import --from-dir hands the operator's import every entry, external references allowed", async () => {
    const { store, asked } = fakeStore({
      ...PLAN,
      outcome: "applied",
      receipt_ids: [],
    });
    const { output, err } = captured();
    const ok = await runSettingsCommand(
      { command: "import", source: { dir: FAKE_MODEL_DIR }, dryRun: false },
      store,
      output,
    );
    expect(ok).toBe(true);
    const [entries, options] = asked[0] ?? [];
    expect(Object.keys((entries as SettingsEntries).connections)).toEqual([
      "fake-messages",
    ]);
    expect(options).toEqual({
      dryRun: false,
      allowExternal: true,
      actor: null,
    });
    expect(err.some((line) => line.includes("profiles.yaml"))).toBe(true);
  });

  test("a refused import exits non-zero and names the conflicts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "settings-cli-"));
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        connections: {},
        repositories: {
          open: { url: "https://git.example.invalid/a/b.git", branch: "main" },
        },
        mcp_servers: {},
      }),
    );
    const { store, asked } = fakeStore({
      ...PLAN,
      conflicts: ["repository:open"],
      outcome: "refused",
      receipt_ids: [],
    });
    const { output, err, out } = captured();
    const ok = await runSettingsCommand(
      { command: "import", source: { document: path }, dryRun: true },
      store,
      output,
    ).finally(() => rm(dir, { recursive: true, force: true }));
    expect(ok).toBe(false);
    expect(asked[0]?.[1].dryRun).toBe(true);
    expect(JSON.parse(out.join("\n")).conflicts).toEqual(["repository:open"]);
    expect(err.join("\n")).toContain("repository:open");
  });

  test("export prints the document with no stored reference, and its digest apart", async () => {
    const { store } = fakeStore({
      ...PLAN,
      outcome: "dry_run",
      receipt_ids: [],
    });
    const { output, out, err } = captured();
    expect(await runSettingsCommand({ command: "export" }, store, output)).toBe(
      true,
    );
    const document = JSON.parse(out.join("\n"));
    expect(document.connections.main.auth).toEqual({
      kind: "api_key",
      stored: true,
      last4: "wxyz",
    });
    expect(out.join("\n")).not.toContain("connection:main");
    expect(err).toEqual([
      expect.stringMatching(/^digest sha256:[0-9a-f]{64}$/),
    ]);
  });
});
