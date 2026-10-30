import { Link } from "@werft-ai/ui";
import type { JSX } from "react";
import { useBlockText } from "./text.ts";

/** Opens the Slack message an input came from, in a new tab. */
export function SlackMessageLink({
  href,
}: {
  readonly href: string;
}): JSX.Element {
  const { t } = useBlockText();
  return (
    <Link
      href={href}
      target="_blank"
      newTabLabel={t("session.slackLink.newTab")}
      className="whitespace-nowrap"
    >
      {t("session.slackLink")}
    </Link>
  );
}
