// preview re-up check (94S-962), reverted by the next commit
export function booleanFlag(value: string, name: string): boolean {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}
