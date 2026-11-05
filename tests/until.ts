/** Polls `read` until it returns a value, then fails with `label` after `timeoutMs`. */
export async function until<T>(
  read: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
