import { useEffect, useState } from "react";

/** The API's own bound on `q`; the box takes no more. */
export const SEARCH_MAX = 200;
export const SEARCH_SETTLE_MS = 300;

/**
 * What the search box sends: trimmed, once typing pauses, and nothing for
 * an empty box, which the API would refuse. Emptied, it applies at once.
 */
export function useSearchTerm(query: string): string | undefined {
  const typed = query.trim();
  const [settled, setSettled] = useState(typed);
  useEffect(() => {
    // Emptied, the old term goes at once, so the next one waits its turn.
    if (typed === "") {
      setSettled("");
      return;
    }
    const id = setTimeout(() => setSettled(typed), SEARCH_SETTLE_MS);
    return () => clearTimeout(id);
  }, [typed]);
  return typed === "" || settled === "" ? undefined : settled;
}
