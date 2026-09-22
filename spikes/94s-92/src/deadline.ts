/**
 * A cancellable deadline for the losing side of a `Promise.race`.
 *
 * `Bun.sleep` cannot play that part: the timer it leaves behind is referenced,
 * so it holds the event loop open until it fires even after the race is over.
 * That is how the spike's child processes came to outlive their own result by
 * exactly the drain budget, which from the parent is indistinguishable from a
 * child that hung.
 */
export function deadline(ms: number): {
  expired: Promise<void>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
    expired,
  };
}
