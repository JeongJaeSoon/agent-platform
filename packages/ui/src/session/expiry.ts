import { useEffect, useState } from "react";

const TIMER_MAX = 2 ** 31 - 1;

/**
 * Whether a pending request has lapsed. A card left open past its expiry
 * must stop taking answers without waiting for the screen to render again.
 * `now` is the screen's clock in epoch ms.
 */
export function useExpired(
  requestId: string,
  expiresAtText: string,
  now: number,
): boolean {
  const expiresAt = Date.parse(expiresAtText);
  const [lapsedId, setLapsedId] = useState<string | null>(null);
  const expired = lapsedId === requestId || expiresAt <= now;

  useEffect(() => {
    if (expired) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // `now` may be the screen's clock; the wait runs on this one.
    const deadline = Date.now() + (expiresAt - now);
    // setTimeout fires at once past 2^31-1 ms, so a far expiry waits in
    // steps, each measured again in case the machine slept.
    const wait = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) setLapsedId(requestId);
      else timer = setTimeout(wait, Math.min(remaining, TIMER_MAX));
    };
    wait();
    return () => clearTimeout(timer);
  }, [expired, expiresAt, now, requestId]);

  return expired;
}
