import { LinkTab, LinkTabs, PageHeader } from "@werft-ai/ui";
import type { JSX, ReactElement } from "react";

import type { OperationsHeadMessages, OperationsTab } from "./messages.ts";
import { useOperationsMessages } from "./use-messages.ts";

export interface OperationsHeadProps {
  /** The tabs the viewer may open, in order. */
  readonly tabs: readonly OperationsTab[];
  readonly current: OperationsTab;
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
  tabLink,
  messages: override,
}: OperationsHeadProps): JSX.Element {
  const { messages } = useOperationsMessages("head", override);
  return (
    <>
      <PageHeader title={messages.title} description={messages.description} />
      <LinkTabs aria-label={messages.tabs} className="mb-6">
        {tabs.map((tab) => (
          <LinkTab key={tab} asChild current={tab === current}>
            {tabLink(tab, messages.tab[tab])}
          </LinkTab>
        ))}
      </LinkTabs>
    </>
  );
}
