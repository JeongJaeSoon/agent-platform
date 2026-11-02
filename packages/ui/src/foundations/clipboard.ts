/**
 * Writes `text` to the clipboard and resolves whether it worked. Outside a
 * secure context there is no clipboard, which counts as a refusal.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) throw new Error("clipboard unavailable");
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
