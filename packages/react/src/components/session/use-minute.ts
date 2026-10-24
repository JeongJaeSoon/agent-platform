import { useEffect, useState } from "react";

/**
 * Date.now(), re-read every minute while `ticking`: a poll that returns the
 * same data does not re-render, and "N분 전" would stay as first drawn.
 */
export function useMinute(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    // Switched on late (another layout, a dropped `now`): start from now.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}
