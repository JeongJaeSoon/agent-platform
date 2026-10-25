import { Slot } from "@radix-ui/react-slot";
import { cn } from "@werft-ai/ui";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useId,
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

/**
 * The last of `ids` whose top has scrolled past the top of the viewport, or
 * the last one once the page bottom is reached, since a short final section
 * may never get that high.
 */
export function useCurrentSection(
  ids: readonly string[],
): readonly [string | undefined, (id: string) => void] {
  const [current, setCurrent] = useState(ids[0]);
  const key = ids.join(" ");
  useEffect(() => {
    const names = key.split(" ");
    let frame = 0;
    const measure = () => {
      frame = 0;
      const root = document.documentElement;
      if (
        window.scrollY > 0 &&
        window.scrollY + root.clientHeight >= root.scrollHeight - 2
      )
        return setCurrent(names.at(-1));
      let found = names[0];
      for (const id of names) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= Math.min(96, root.clientHeight / 3))
          found = id;
      }
      setCurrent(found);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key]);
  // A click picks its section at once; the next scroll measures again.
  return [current, setCurrent] as const;
}
