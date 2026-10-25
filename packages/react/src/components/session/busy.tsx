import { LoaderCircle } from "lucide-react";

/**
 * Drawn inside the button whose answer is on its way. The button is
 * disabled and its card is aria-busy; this is only the visible part.
 */
export function Busy({ shown }: { readonly shown: boolean }) {
  return shown ? (
    <LoaderCircle
      data-slot="busy"
      className="animate-spin motion-reduce:animate-none"
      aria-hidden="true"
    />
  ) : null;
}
