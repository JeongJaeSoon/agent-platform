import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// tailwind-merge lets a caller's `className` override a variant's utility
// (`px-2` beats `px-4`); class names it does not know, like `ap-*`, pass through.
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
