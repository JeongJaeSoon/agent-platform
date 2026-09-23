// The control host's one executable (94S-117): `bun run src/main.ts <role>`.
// The role is named, never defaulted, so a container runs what its command
// says. Each role module is imported only when chosen: a process reads and
// validates only its own role's settings, and only the scheduler ever loads
// the Docker backend.
const ROLES = ["api", "scheduler", "reconciler"] as const;
type Role = (typeof ROLES)[number];

function isRole(value: string | undefined): value is Role {
  return (ROLES as readonly (string | undefined)[]).includes(value);
}

const role = process.argv[2];
if (!isRole(role)) {
  console.error(
    `usage: bun run src/main.ts <${ROLES.join("|")}> (got ${role ?? "nothing"})`,
  );
  process.exit(2);
}

switch (role) {
  case "api":
    // Serves until a signal stops it (api/shutdown.ts).
    await import("./api/server.ts");
    break;
  case "scheduler": {
    const { exitCodeFor, main } = await import("./scheduler/main.ts");
    process.exitCode = exitCodeFor(await main());
    break;
  }
  case "reconciler": {
    const { main } = await import("./reconciler/main.ts");
    await main();
    break;
  }
}
