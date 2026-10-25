import {
  cn,
  LinkTab,
  LinkTabs,
  PageHeader,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import type { JSX, ReactElement } from "react";

import type { OperationsHeadMessages, OperationsTab } from "./messages.ts";
import { useOperationsMessages } from "./use-messages.ts";

export interface OperationsHeadProps {
  /** The tabs the viewer may see, in order. */
  readonly tabs: readonly OperationsTab[];
  readonly current: OperationsTab;
  /** Tabs shown in their place but not openable yet, saying so. */
  readonly soon?: readonly OperationsTab[] | undefined;
  /**
   * The host's link to a tab's route with `label` as its text; the tab
   * styles it. A router link that marks parent paths active needs exact
   * matching.
   */
  readonly tabLink: (tab: OperationsTab, label: string) => ReactElement;
  readonly messages?: Partial<OperationsHeadMessages> | undefined;
}

/** The operations menu's title and the tabs under it. */
export function OperationsHead({
  tabs,
  current,
  soon = [],
  tabLink,
  messages: override,
}: OperationsHeadProps): JSX.Element {
  const { messages } = useOperationsMessages("head", override);
  return (
    <>
      <PageHeader title={messages.title} description={messages.description} />
      <LinkTabs aria-label={messages.tabs} className="mb-6">
        {tabs.map((tab) =>
          soon.includes(tab) ? (
            <SoonTab
              key={tab}
              label={messages.tab[tab]}
              reason={messages.soon}
            />
          ) : (
            <LinkTab key={tab} asChild current={tab === current}>
              {tabLink(tab, messages.tab[tab])}
            </LinkTab>
          ),
        )}
      </LinkTabs>
    </>
  );
}

/**
 * The withheld-action shape (ReasonButton): in place, inert, focusable and
 * described by its reason, which shows on hover, focus or a tap.
 */
function SoonTab({
  label,
  reason,
}: {
  readonly label: string;
  readonly reason: string;
}): JSX.Element {
  return (
    <li className="flex">
      <Tooltip>
        <TooltipTrigger asChild={true} type={undefined}>
          {/* biome-ignore lint/a11y/useSemanticElements: an <a> without href is no link; this one has no route yet */}
          <span
            role="link"
            aria-disabled={true}
            tabIndex={0}
            data-slot="link-tab"
            className={cn(
              "relative flex h-9 cursor-not-allowed items-center whitespace-nowrap rounded-control px-2 font-medium text-control text-muted-foreground opacity-45",
              "focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2",
            )}
          >
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{reason}</TooltipContent>
      </Tooltip>
    </li>
  );
}
