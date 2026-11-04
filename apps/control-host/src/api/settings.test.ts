import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InstallationProfileRecord,
  type InstallationProfileStore,
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

const OLD_CATALOG = {
  "connections.yaml": `connections:
  fake-messages:
    kind: anthropic
    endpoint: http://fake-messages:4010
    auth:
      kind: api_key
      secret_id: agent-platform/local/fake-messages
`,
  "repositories.yaml": `repositories:
  sample-app:
    url: http://fake-git:3000/agent/sample-app.git
    branch: main
    profiles: [coding]
  bare:
    url: http://fake-git:3000/agent/bare.git
    branch: main
`,
  "mcp-servers.yaml": `mcp_servers:
  fake:
    url: http://fake-mcp:4020/mcp
    credential_ref: mcp/fake
    auth:
      kind: bearer
      secret_id: agent-platform/local/fake-mcp
    workspaces: [verify]
`,
  "profiles.yaml": `profiles:
  coding:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read]
    permission_mode: default
    provider:
      kind: anthropic
      endpoint: http://fake-messages:4010
      auth:
        kind: api_key
        secret_id: agent-platform/local/fake-messages
`,
  "platform.yaml": `secret_key:
  value_env: UNREAD
`,
};

let root: string;
let oldCatalog: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "settings-cli-"));
  oldCatalog = join(root, "catalog");
  await mkdir(oldCatalog);
  for (const [name, text] of Object.entries(OLD_CATALOG)) {
    await writeFile(join(oldCatalog, name), text);
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

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

function fakeProfiles(rows: InstallationProfileRecord[] = []) {
  const seeded: Array<Parameters<InstallationProfileStore["seedCatalog"]>[0]> =
    [];
  const store: Pick<InstallationProfileStore, "listAll" | "seedCatalog"> = {
    listAll: async () => rows,
    seedCatalog: async (seed) => {
      seeded.push(seed);
      const entries = await seed.entries();
      return { seeded: entries.map((entry) => entry.id), migrated: [] };
    },
  };
  return { store, seeded };
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
      source: { dir: "/app/config", ifPresent: false },
      dryRun: false,
    });
    expect(
      parseSettingsCommand([
        "import",
        "--from-dir",
        "/legacy-config",
        "--if-present",
      ]),
    ).toMatchObject({
      source: { dir: "/legacy-config", ifPresent: true },
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
      ["import", "--document", "a", "--if-present"],
      ["export", "--if-present"],
    ]) {
      expect(() => parseSettingsCommand(argv)).toThrow("Usage:");
    }
  });
});

describe("settings CLI", () => {
  test("--from-dir turns the old files into the document, the fake-messages connection included, and says what it leaves out", async () => {
    const { document, profiles, notes } = await documentFromDir(oldCatalog);
    const entries = parseSettingsDocument(document);
    expect(Object.keys(entries.connections)).toEqual(["fake-messages"]);
    expect(entries.connections["fake-messages"]).toMatchObject({
      kind: "anthropic",
      endpoint: "http://fake-messages:4010",
    });
    expect(Object.keys(entries.repositories).sort()).toEqual([
      "bare",
      "sample-app",
    ]);
    expect(Object.keys(entries.mcp_servers)).toEqual(["fake"]);
    expect(notes).toEqual([
      "platform.yaml is not imported: set the master key in PLATFORM_SECRET_KEY",
    ]);
    expect(document).not.toHaveProperty("profiles");
    expect(Object.keys(profiles)).toEqual(["coding"]);
  });

  test("import --from-dir hands the operator's import every entry, external references allowed, and seeds its ceilings", async () => {
    const { store, asked } = fakeStore({
      ...PLAN,
      outcome: "applied",
      receipt_ids: [],
    });
    const { store: profiles, seeded } = fakeProfiles();
    const { output, out, err } = captured();
    const ok = await runSettingsCommand(
      {
        command: "import",
        source: { dir: oldCatalog, ifPresent: false },
        dryRun: false,
      },
      { settings: store, profiles },
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
      databaseOwnsRepositories: true,
      actor: null,
    });
    expect(err.some((line) => line.includes("platform.yaml"))).toBe(true);
    expect(seeded[0]?.repositoryIdsOf("coding")).toEqual(["sample-app"]);
    expect(JSON.parse(out.join("\n")).profiles).toEqual({
      seed: ["coding"],
      fill: [],
      unfilled: [],
    });
  });

  test("a kept repository is named on stderr, and a document import keeps none", async () => {
    const { store, asked } = fakeStore({
      ...PLAN,
      kept: ["repository:app"],
      outcome: "applied",
      receipt_ids: [],
    });
    const { store: profiles } = fakeProfiles();
    const { output, err } = captured();
    await runSettingsCommand(
      {
        command: "import",
        source: { dir: oldCatalog, ifPresent: false },
        dryRun: true,
      },
      { settings: store, profiles },
      output,
    );
    expect(err).toContain(
      "note: repository:app from the file is not applied; the database keeps its row",
    );
    expect(asked[0]?.[1]).toHaveProperty("databaseOwnsRepositories", true);
  });

  test("a runtime this image lacks stops a seed, not an upgrade whose table is filled", async () => {
    const dir = join(root, "other-runtime");
    await mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(OLD_CATALOG)) {
      await writeFile(join(dir, name), text);
    }
    const profilesFile = await Bun.file(join(dir, "profiles.yaml")).text();
    await writeFile(
      join(dir, "profiles.yaml"),
      profilesFile
        .replace("claude_agent_sdk", "pi_coding_agent")
        .replace("permission_mode: default", "permission_mode: auto"),
    );
    const command = {
      command: "import" as const,
      source: { dir, ifPresent: false },
      dryRun: true,
    };
    const applied = fakeStore({ ...PLAN, outcome: "dry_run", receipt_ids: [] });
    const { store: empty } = fakeProfiles();
    await expect(
      runSettingsCommand(
        command,
        { settings: applied.store, profiles: empty },
        captured().output,
      ),
    ).rejects.toThrow("Catalog profile(s) refused");
    const { store: filled } = fakeProfiles([
      { id: "older", repository_ids: ["sample-app"] },
    ] as never);
    expect(
      await runSettingsCommand(
        command,
        { settings: applied.store, profiles: filled },
        captured().output,
      ),
    ).toBe(true);
  });

  test("--if-present skips a missing or empty directory, and only that", async () => {
    const { store, asked } = fakeStore({
      ...PLAN,
      outcome: "applied",
      receipt_ids: [],
    });
    const { store: profiles, seeded } = fakeProfiles();
    const empty = join(root, "empty");
    await mkdir(empty, { recursive: true });
    for (const dir of [empty, join(root, "absent")]) {
      const { output, err } = captured();
      expect(
        await runSettingsCommand(
          {
            command: "import",
            source: { dir, ifPresent: true },
            dryRun: false,
          },
          { settings: store, profiles },
          output,
        ),
      ).toBe(true);
      expect(err).toEqual([`nothing to import from ${dir}`]);
    }
    expect(asked).toEqual([]);
    expect(seeded).toEqual([]);

    const partial = join(root, "partial");
    await mkdir(partial, { recursive: true });
    await writeFile(
      join(partial, "repositories.yaml"),
      OLD_CATALOG["repositories.yaml"],
    );
    await expect(
      runSettingsCommand(
        {
          command: "import",
          source: { dir: partial, ifPresent: true },
          dryRun: false,
        },
        { settings: store, profiles },
        captured().output,
      ),
    ).rejects.toThrow("connections.yaml is missing");
    expect(asked).toEqual([]);
  });

  test("a dry run reports the ceilings without seeding them", async () => {
    const { store } = fakeStore({
      ...PLAN,
      outcome: "dry_run",
      receipt_ids: [],
    });
    const older = {
      id: "older",
      repository_ids: null,
    } as InstallationProfileRecord;
    const coding = { id: "coding", repository_ids: null };
    for (const [rows, report] of [
      [[], { seed: ["coding"], fill: [], unfilled: [] }],
      [
        [older, coding as InstallationProfileRecord],
        { seed: [], fill: ["older", "coding"], unfilled: ["older"] },
      ],
    ] as const) {
      const { store: profiles, seeded } = fakeProfiles([...rows]);
      const { output, out } = captured();
      await runSettingsCommand(
        {
          command: "import",
          source: { dir: oldCatalog, ifPresent: false },
          dryRun: true,
        },
        { settings: store, profiles },
        output,
      );
      expect(JSON.parse(out.join("\n")).profiles).toEqual(report);
      expect(seeded).toEqual([]);
    }
  });

  test("a document's profiles key is the CLI's seed; without one no ceiling is touched", async () => {
    const { store } = fakeStore({
      ...PLAN,
      outcome: "applied",
      receipt_ids: [],
    });
    const { store: profiles, seeded } = fakeProfiles();
    const path = join(root, "no-seed.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        connections: {},
        repositories: {},
        mcp_servers: {},
      }),
    );
    const { output, out } = captured();
    await runSettingsCommand(
      { command: "import", source: { document: path }, dryRun: false },
      { settings: store, profiles },
      output,
    );
    expect(seeded).toEqual([]);
    expect(JSON.parse(out.join("\n"))).not.toHaveProperty("profiles");
  });

  test("a refused import exits non-zero, names the conflicts and seeds nothing", async () => {
    const path = join(root, "settings.json");
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
    const { store: profiles, seeded } = fakeProfiles();
    const { output, err, out } = captured();
    const ok = await runSettingsCommand(
      { command: "import", source: { document: path }, dryRun: true },
      { settings: store, profiles },
      output,
    );
    expect(ok).toBe(false);
    expect(seeded).toEqual([]);
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
    expect(
      await runSettingsCommand(
        { command: "export" },
        { settings: store, profiles: fakeProfiles().store },
        output,
      ),
    ).toBe(true);
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
