import { createLucideIcon } from "lucide-react";

// The operations design's own nodes (ccdeck-features-design.html), so the
// finding icons match it stroke for stroke.

export const FindingClock = createLucideIcon("finding-clock", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "finding-clock-0" }],
  ["path", { d: "M12 6v6l4 2", key: "finding-clock-1" }],
]);

export const FindingFailed = createLucideIcon("finding-failed", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "finding-failed-0" }],
  ["path", { d: "m15 9-6 6M9 9l6 6", key: "finding-failed-1" }],
]);

export const FindingSlow = createLucideIcon("finding-slow", [
  ["path", { d: "M12 4v8l5 3", key: "finding-slow-0" }],
  ["circle", { cx: "12", cy: "12", r: "9", key: "finding-slow-1" }],
]);
