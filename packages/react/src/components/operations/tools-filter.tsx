import {
  SearchInput,
  SegmentedControl,
  SegmentedControlItem,
} from "@werft-ai/ui";
import { type JSX, useEffect, useRef, useState } from "react";

import type { ToolSort, ToolsFilterMessages } from "./messages.ts";
import type { UsageTool } from "./tools.ts";
import { useOperationsMessages } from "./use-messages.ts";

const SORTS: readonly ToolSort[] = ["calls", "time", "slow", "failed"];
const SORT_KEY: Readonly<Record<ToolSort, keyof UsageTool>> = {
  calls: "calls",
  time: "total_ms",
  slow: "median_ms",
  failed: "failed",
};

/** The search waits this long after the last keystroke. */
export const TOOL_SEARCH_DEBOUNCE_MS = 200;

/** `tools` by the chosen figure, largest first; ties keep the API's order. */
export function sortTools(
  tools: readonly UsageTool[],
  sort: ToolSort,
): readonly UsageTool[] {
  const key = SORT_KEY[sort];
  return [...tools].sort((a, b) => Number(b[key]) - Number(a[key]));
}

/** Tools whose name holds `query`, case aside. */
export function findTools(
  tools: readonly UsageTool[],
  query: string,
): readonly UsageTool[] {
  const needle = query.trim().toLowerCase();
  return needle
    ? tools.filter((tool) => tool.name.toLowerCase().includes(needle))
    : tools;
}

export interface ToolsFilterProps {
  readonly sort: ToolSort;
  readonly onSortChange: (sort: ToolSort) => void;
  /** Called with the search text once typing stops. */
  readonly onQueryChange: (query: string) => void;
  readonly messages?: Partial<ToolsFilterMessages> | undefined;
}

/** The tools table's sort and search, over the table. */
export function ToolsFilter({
  sort,
  onSortChange,
  onQueryChange,
  messages: override,
}: ToolsFilterProps): JSX.Element {
  const { messages } = useOperationsMessages("toolsFilter", override);
  const [text, setText] = useState("");
  const report = useRef(onQueryChange);
  report.current = onQueryChange;
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current) return;
    const timer = setTimeout(
      () => report.current(text),
      TOOL_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div
      data-slot="tools-filter"
      className="mb-3 flex flex-wrap items-center justify-between gap-3"
    >
      <SegmentedControl
        aria-label={messages.sort}
        value={sort}
        onValueChange={(value) => onSortChange(value as ToolSort)}
      >
        {SORTS.map((id) => (
          <SegmentedControlItem key={id} value={id}>
            {messages.by[id]}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      <SearchInput
        aria-label={messages.search}
        type="search"
        placeholder={messages.placeholder}
        value={text}
        onChange={(event) => {
          typed.current = true;
          setText(event.currentTarget.value);
        }}
        wrapperClassName="max-w-none flex-[1_1_100%] sm:ml-auto sm:w-60 sm:flex-none"
      />
    </div>
  );
}
