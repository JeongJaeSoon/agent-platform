import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TurnEventMessage } from "@werft-ai/contracts";
import { sessionsEn, sessionsJa, sessionsKo } from "@werft-ai/react";
import { Timeline, type TimelineMessages } from "@werft-ai/react/components";

import {
  FAILED_EVENTS,
  LONG_DETAIL_EVENTS,
  NO_TURN_EVENTS,
  pairedTimelineEntries,
  RUNNING_EVENTS,
  TIMELINE_NOW,
  TURN_EVENTS,
  TWO_TURN_EVENTS,
  timelineEntries,
  WAIT_FAIL_EVENTS,
} from "./session-fixtures.ts";

type Catalog = Record<keyof typeof sessionsKo, string>;

// The blocks' own wording, so each language story reads as the console does.
function copyFrom(catalog: Catalog) {
  const fill = (template: string, params: Record<string, unknown> = {}) =>
    template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    );
  const formatMessage = ({ key, params }: TurnEventMessage) =>
    fill(catalog[key as keyof Catalog] ?? key, params);
  const messages: TimelineMessages = {
    label: catalog["session.events"],
    empty: catalog["session.events.empty"],
    connecting: catalog["session.events.connecting"],
    closed: catalog["session.events.closed"],
    turn: (turn) => fill(catalog["session.events.turn"], { turn }),
    kind: (kind) => catalog[`session.events.kind.${kind}`],
    folded: (count) => fill(catalog["session.events.folded"], { count }),
    running: catalog["session.events.running"],
    waiting: catalog["sessions.status.needs_input"],
  };
  return { formatMessage, messages };
}

const EN = copyFrom(sessionsEn);

const meta = {
  title: "Domain/Session/Timeline",
  globals: { locale: "en" },
  component: Timeline,
  args: {
    entries: pairedTimelineEntries(TWO_TURN_EVENTS),
    ...EN,
    locale: "en",
    now: TIMELINE_NOW,
  },
  // Console v4 L599: the list sits in a flush card, 16px in from its edge.
  decorators: [
    (Story) => (
      <div className="rounded-card border bg-card px-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Timeline>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Two turns under their heads: the call and its result in one row, the
 * failure red, the wait amber, status and system lines folded, a time only
 * where the minute changes.
 */
export const Default: Story = {};

export const WithDebug: Story = { args: { showDebug: true } };

/** The one turn of the user's capture (4.png), drawn the new way. */
export const SameAsCapture: Story = {
  name: "One turn with debug (4.png)",
  args: {
    entries: pairedTimelineEntries(TURN_EVENTS, 4000),
    showDebug: true,
  },
};

/** A call whose result has not arrived yet. */
export const RunningCall: Story = {
  args: { entries: pairedTimelineEntries(RUNNING_EVENTS) },
};

/** The same call held by a permission request that has no answer yet. */
export const WaitingCall: Story = {
  args: {
    entries: pairedTimelineEntries(RUNNING_EVENTS),
    held: new Set(["call_4"]),
  },
};

/** The turn's end reported no usage, so its head has no token count. */
export const TurnWithoutTokens: Story = {
  args: { entries: pairedTimelineEntries(WAIT_FAIL_EVENTS) },
};

/** Events before the first turn stand outside any group. */
export const WithoutTurn: Story = {
  args: { entries: pairedTimelineEntries(NO_TURN_EVENTS) },
};

export const LongDetail: Story = {
  args: { entries: pairedTimelineEntries(LONG_DETAIL_EVENTS) },
};

/** Without `folded` and `running` wording each line stands alone. */
export const WithoutNewWording: Story = {
  args: {
    messages: {
      ...EN.messages,
      folded: undefined,
      running: undefined,
    },
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile390: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const Korean: Story = {
  name: "Default (한국어)",
  globals: { locale: "ko" },
  args: { ...copyFrom(sessionsKo), locale: "ko" },
};

export const Japanese: Story = {
  name: "Default (日本語)",
  globals: { locale: "ja" },
  args: { ...copyFrom(sessionsJa), locale: "ja" },
};

export const English: Story = {
  name: "Default (English)",
};

export const Empty: Story = { args: { entries: [] } };

export const Loading: Story = { args: { entries: [], state: "connecting" } };

export const Failed: Story = {
  name: "Error",
  args: { entries: timelineEntries(FAILED_EVENTS), state: "closed" },
};

/** Every state above in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-6">
      {Object.entries({ Default, Empty, Loading, Failed }).map(
        ([name, story]) => (
          <Timeline key={name} {...args} {...story.args} />
        ),
      )}
    </div>
  ),
};

export const StatesDark: Story = {
  ...States,
  name: "States (dark)",
  globals: { theme: "dark" },
};

export const StatesMobile: Story = {
  ...States,
  name: "States (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
