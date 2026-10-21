import {
  type FocusEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

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

/**
 * Expiry takes the card's controls away, and the focus with them when the
 * keyboard was on one: hand it to the expiry notice instead. Spread
 * `within` on the card and put `noticeRef` on the notice.
 */
export function useExpiryFocus(expired: boolean) {
  const noticeRef = useRef<HTMLParagraphElement>(null);
  // Whether focus was inside the card; a removed element sends no blur.
  const inside = useRef(false);

  useLayoutEffect(() => {
    const notice = noticeRef.current;
    const page = notice?.ownerDocument;
    if (expired && inside.current && page?.activeElement === page?.body) {
      notice?.focus();
    }
  }, [expired]);

  return {
    noticeRef,
    within: {
      onFocus: () => {
        inside.current = true;
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          inside.current = false;
        }
      },
    },
  };
}
