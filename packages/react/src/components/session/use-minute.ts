import { useEffect, useState } from "react";

/** Date.now(), re-read every minute while `ticking`, for "N분 전". */
export function useMinute(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    // Switched on late (a dropped `now`): start from now.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}
