import { Slot } from "@radix-ui/react-slot";
import { cn } from "@werft-ai/ui";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

// Stand-ins shaped like the shared SideNav web-ui is adding to
// @werft-ai/ui; swap the import once it lands.

export function SideNavLayout({
  nav,
  children,
}: {
  readonly nav: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[200px_minmax(0,720px)] md:gap-8">
      {nav}
      <div className="flex min-w-0 flex-col gap-8">{children}</div>
    </div>
  );
}

export function SideNav({ className, ...props }: ComponentProps<"nav">) {
  return (
    <nav
      className={cn(
        "flex flex-col gap-0.5 rounded-card border p-1 md:sticky md:top-4 md:border-0 md:p-0",
        className,
      )}
      {...props}
    />
  );
}

export function SideNavGroup({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls, these are links
    <div role="group" aria-labelledby={id} className="flex flex-col gap-0.5">
      <div
        id={id}
        className="px-2 pt-3 pb-1 text-caption text-subtle-foreground"
      >
        {label}
      </div>
      {children}
    </div>
  );
}

export function SideNavLink({
  asChild,
  current,
  className,
  ...props
}: ComponentProps<"a"> & {
  readonly asChild?: boolean;
  /** Set by the caller: a route link is `page`, an in-page section `location`. */
  readonly current?: "page" | "location" | undefined;
}) {
  const Comp = asChild ? Slot : "a";
  return (
    <Comp
      aria-current={current}
      className={cn(
        "relative flex min-h-8 items-center rounded-control px-2 font-medium text-control no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
        current
          ? "bg-muted text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-control-checked"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

const RELEASE = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

/**
 * The last of `ids` whose top has scrolled past the top of the viewport, or
 * the last one once the page bottom is reached, since a short final section
 * may never get that high. While the sections are hidden (another tab is
 * open) the answer is kept, not measured. A section picked from the list
 * stays current until the reader scrolls on their own: the jump may stop at
 * the page bottom, short of the section's top.
 */
export function useCurrentSection(
  ids: readonly string[],
): readonly [string | undefined, (id: string) => void] {
  const [current, setCurrent] = useState(ids[0]);
  const picked = useRef(false);
  const pick = useCallback((id: string) => {
    picked.current = true;
    setCurrent(id);
  }, []);
  const key = ids.join(" ");
  useEffect(() => {
    const names = key.split(" ");
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (picked.current) return;
      const shown = names.flatMap((id) => {
        const element = document.getElementById(id);
        return element && element.getClientRects().length > 0
          ? [{ id, top: element.getBoundingClientRect().top }]
          : [];
      });
      if (shown.length === 0) return;
      const root = document.documentElement;
      if (
        window.scrollY > 0 &&
        window.scrollY + root.clientHeight >= root.scrollHeight - 2
      )
        return setCurrent(shown.at(-1)?.id);
      const line = Math.min(96, root.clientHeight / 3);
      const passed = shown.filter((section) => section.top <= line);
      setCurrent((passed.at(-1) ?? shown[0])?.id);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const release = () => {
      picked.current = false;
    };
    // Showing the tab again resizes the page without scrolling it.
    const resized = new ResizeObserver(schedule);
    resized.observe(document.body);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    for (const type of RELEASE)
      window.addEventListener(type, release, { passive: true });
    measure();
    return () => {
      resized.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      for (const type of RELEASE) window.removeEventListener(type, release);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key]);
  return [current, pick] as const;
}
