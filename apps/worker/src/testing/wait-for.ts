/** Polls a synchronous condition for up to two seconds, then fails with `label`. */
export async function waitFor(
  condition: () => boolean,
  label: string,
): Promise<void> {
  for (let waited = 0; waited < 2_000; waited += 5) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
