import { Link, useRouterState } from "@tanstack/react-router";
import { Button } from "@werft-ai/ui";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useI18n } from "../i18n/i18n.tsx";
import { type NavItem, useSettingsNavGroups } from "./app-sidebar.tsx";
import { MAIN_CONTENT_ID } from "./main.tsx";

// A page's own sub-paths (a key's new page, the Slack link callback) keep
// their item current; 일반 alone has a sibling under its path.
function isCurrent(item: NavItem, pathname: string): boolean {
  if (item.to === "/settings/workspace") return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/**
 * Settings as GitHub lays them out (V4-SETTINGS-LAYOUT A): the settings nav
 * on the left, the page in one column beside it. Below md the nav folds
 * behind one button that names the current page, as the shell's menu does.
 */
export function SettingsLayout({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const groups = useSettingsNavGroups();
  // The router also opens a page at its path with a trailing slash.
  const pathname = useRouterState({
    select: (state) => state.location.pathname.replace(/(.)\/$/, "$1"),
  });
  const [open, setOpen] = useState(false);
  const listId = useId();
  const here = groups
    .flatMap((group) => group.items)
    .find((item) => isCurrent(item, pathname));
  return (
    <div className="flex w-full flex-col gap-6 md:flex-row md:gap-8">
      <nav aria-label={t("nav.settings")} className="md:w-55 md:flex-none">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-between md:hidden"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="min-w-0 truncate">
            {t("nav.settings")}
            {here ? (
              <>
                <span className="text-muted-foreground"> · </span>
                {t(here.label)}
              </>
            ) : null}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
        </Button>
        <div
          id={listId}
          className={`${open ? "mt-2 flex rounded-card border p-2" : "hidden"} flex-col gap-4 md:mt-0 md:flex md:border-0 md:p-0`}
        >
          {groups.map((group) => (
            <SettingsGroup
              key={group.label}
              label={t(group.label)}
              items={group.items}
              pathname={pathname}
              onPick={() => {
                if (!open) return;
                setOpen(false);
                // The followed link hides with the list; focus lands on the page.
                document.getElementById(MAIN_CONTENT_ID)?.focus();
              }}
            />
          ))}
        </div>
      </nav>
      <div className="min-w-0 max-w-180 flex-1">{children}</div>
    </div>
  );
}

function SettingsGroup({
  label,
  items,
  pathname,
  onPick,
}: {
  readonly label: string;
  readonly items: readonly NavItem[];
  readonly pathname: string;
  readonly onPick: () => void;
}) {
  const { t } = useI18n();
  const headingId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls, these are links
    <div
      role="group"
      aria-labelledby={headingId}
      className="flex flex-col gap-1"
    >
      <p id={headingId} className="m-0 px-3 text-caption text-muted-foreground">
        {label}
      </p>
      {items.map((item) => {
        const current = isCurrent(item, pathname);
        return (
          <Button
            key={item.to}
            asChild
            variant={current ? "secondary" : "ghost"}
            className="w-full justify-start"
          >
            <Link
              to={item.to}
              activeOptions={{ exact: true }}
              aria-current={current ? "page" : undefined}
              onClick={onPick}
            >
              {t(item.label)}
            </Link>
          </Button>
        );
      })}
    </div>
  );
}
