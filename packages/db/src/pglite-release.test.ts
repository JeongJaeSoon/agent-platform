import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

// pglite-release.ts reaches into PGlite's `mod`: a PGlite that renamed it, or
// a run without the preload, would keep every closed memory again unnoticed.
test("a closed PGlite lets go of its WebAssembly module (94S-436)", async () => {
  const client = new PGlite();
  await client.query("select 1");
  const internals = client as unknown as { mod?: unknown };
  expect(internals.mod).toBeDefined();

  await client.close();

  expect(internals.mod).toBeUndefined();
});
