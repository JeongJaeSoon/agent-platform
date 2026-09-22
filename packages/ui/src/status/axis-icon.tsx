import type { JSX } from "react";

import type { StatusAxis } from "./vocabulary.ts";

/*
 * Every axis gets its own silhouette, so two labels that happen to share a tone
 * are still told apart without reading the colour (§4.1, §6 dual encoding).
 */
const SHAPE: Record<StatusAxis, JSX.Element> = {
  admission: <rect x="2" y="2" width="10" height="10" rx="3" />,
  turn: <path d="M4.5 2.5 11 7l-6.5 4.5Z" fill="currentColor" />,
  receipt: <path d="M3.5 2h7v10l-1.75-1.2L7 12l-1.75-1.2L3.5 12Z" />,
  execution: <path d="M7 2 11.9 4.75v5.5L7 13 2.1 10.25v-5.5Z" />,
};

export function AxisIcon({ axis }: { axis: StatusAxis }): JSX.Element {
  return (
    <svg
      className="ap-status__icon"
      viewBox="0 0 14 14"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPE[axis]}
    </svg>
  );
}
