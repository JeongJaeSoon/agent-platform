import {
  createFunnel,
  type FunnelReset,
  type FunnelRouter,
} from "@agent-platform/react";
import { Button } from "@agent-platform/ui";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useI18n } from "../i18n/i18n.tsx";

type FunnelState = ReturnType<FunnelRouter>["history"][number];

const isFunnelState = (value: unknown): value is FunnelState =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as FunnelState).step === "string" &&
  typeof (value as FunnelState).context === "object" &&
  (value as FunnelState).context !== null;

/*
 * Stores a flow the way @use-funnel/react-router does: the step is in the URL
 * as `?<id>.step=`, and history.state holds the states that led to it. Each
 * history entry keeps its own copy, so back, forward and a reload come back
 * to the step and its input; a copied URL carries no input and starts over.
 * Unlike that adapter, unmounting leaves the entry alone: StrictMode's
 * second mount would otherwise wipe the state it just restored.
 */
export const tanstackFunnelRouter: FunnelRouter = ({ id, initialState }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const router = useRouter();
  const stepKey = `${id}.step`;
  const historyKey = `${id}.histories`;

  const saved = (location.state as unknown as Record<string, unknown>)[
    historyKey
  ];
  const history =
    Array.isArray(saved) && saved.length > 0 && saved.every(isFunnelState)
      ? saved
      : [initialState];
  const currentIndex = history.length - 1;

  // The flow can sit on any route, and a search updater for "." is typed
  // against every route's search at once, which no object satisfies.
  const write = (next: FunnelState[], replace: boolean) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        [stepKey]: next.at(-1)?.step,
      }),
      state: (prev: Record<string, unknown>) => ({
        ...prev,
        [historyKey]: next,
      }),
      replace,
    } as unknown as Parameters<typeof navigate>[0]);

  return {
    history,
    currentIndex,
    push: (state) => write([...history, state], false),
    replace: (state) => write([...history.slice(0, currentIndex), state], true),
    go: (delta) => router.history.go(delta),
    cleanup: () => {},
  };
};

export const useFunnel = createFunnel(tanstackFunnelRouter);

/** Says a flow started over because its saved input no longer fit. */
export function FunnelResetNotice({
  funnel,
}: {
  readonly funnel: FunnelReset;
}) {
  const { t } = useI18n();
  // The live region stays mounted so the text is read when it appears.
  return (
    <div aria-live="polite">
      {funnel.reset ? (
        <div className="web-notice flex items-start justify-between gap-3">
          <p className="m-0">{t("flow.reset")}</p>
          <Button variant="ghost" size="sm" onClick={funnel.dismissReset}>
            {t("flow.reset.dismiss")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
