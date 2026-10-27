/** True when `work` settled within `ms`; a rejection is rethrown. */
export async function settledWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves with the value, or undefined once `cut` fulfills first (a
 * rejected `cut` rejects). A rejection of `work` after the cut is dropped:
 * nobody is waiting on it.
 */
export function until<T>(
  work: Promise<T>,
  cut: Promise<unknown>,
): Promise<T | undefined> {
  work.catch(() => {});
  return Promise.race([work, cut.then(() => undefined)]);
}
