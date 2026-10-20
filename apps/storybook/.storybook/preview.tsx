import type { Decorator, Preview } from "@storybook/react-vite";

import "./preview.css";

// tokens.css keys dark off `data-theme` on <html>; set it explicitly either
// way so a dark OS does not turn the light stories dark.
const withTheme: Decorator = (Story, { globals }) => {
  document.documentElement.dataset.theme =
    globals.theme === "dark" ? "dark" : "light";
  return <Story />;
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: "Colour theme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  parameters: {
    layout: "padded",
    // `error` fails the story's test on any axe violation, so CI's a11y
    // check is the story run itself.
    a11y: { test: "error" },
    viewport: {
      options: {
        mobile390: {
          name: "Mobile 390",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
        narrow360: {
          name: "Narrowest 360",
          styles: { width: "360px", height: "780px" },
          type: "mobile",
        },
        tablet768: {
          name: "Tablet 768",
          styles: { width: "768px", height: "1024px" },
          type: "tablet",
        },
        desktop1440: {
          name: "Desktop 1440",
          styles: { width: "1440px", height: "900px" },
          type: "desktop",
        },
      },
    },
  },
};

export default preview;
