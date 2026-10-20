import type { RefObject } from "react";

/**
 * Copies `text` to the clipboard and resolves whether it worked. On a
 * refusal, or outside a secure context where there is no clipboard, it
 * focuses `field` so its onFocus can select the value for a manual copy.
 */
export async function copyText(
  text: string,
  field: RefObject<HTMLInputElement | null>,
): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) throw new Error("clipboard unavailable");
    await clipboard.writeText(text);
    return true;
  } catch {
    field.current?.focus();
    return false;
  }
}
