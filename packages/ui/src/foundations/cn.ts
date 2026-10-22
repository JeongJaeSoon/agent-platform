import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "caption",
            "control",
            "body",
            "description",
            "title",
            "number",
          ],
        },
      ],
      rounded: [{ rounded: ["control", "card"] }],
      shadow: [{ shadow: ["pop"] }],
    },
  },
});

// tailwind-merge lets a caller's `className` override a variant's utility
// (`px-2` beats `px-4`); class names it does not know, like `ap-*`, pass through.
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
