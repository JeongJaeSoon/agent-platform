import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  InstallationProfileOptionsResponse,
  ToolBoundaryValue,
} from "@werft-ai/contracts";
import {
  Badge,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@werft-ai/ui";
import { useId } from "react";
import { scopedKey } from "../api/queries.ts";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";
import {
  blockedOf,
  needsAccepting,
  type ToolChoiceModel,
  type ToolPicks,
} from "./profile-tools-model.ts";

/** GET /v1/installation-profiles/options, which only an owner may read. */
export const installationOptionsQuery = (client: ApiClient) => ({
  queryKey: scopedKey(client, "installation-profile-options"),
  queryFn: () =>
    unwrap(
      client.GET("/v1/installation-profiles/options"),
    ) as Promise<InstallationProfileOptionsResponse>,
  retry: false,
});

const TOOL_REFUSALS: Readonly<Record<string, MessageKey>> = {
  mcp_tool: "profiles.tools.error.mcpTool",
  tool_pattern: "profiles.tools.error.toolPattern",
  unknown_tool: "profiles.tools.error.unknownTool",
  no_tool_catalog: "profiles.tools.error.noToolCatalog",
  base_denies: "profiles.tools.error.baseDenies",
  added_tool_not_accepted: "profiles.tools.asked",
};

/** What a save refused over its deny or accepted tools says, by reason code. */
export function toolRefusalKey(reason: unknown): MessageKey | undefined {
  return typeof reason === "string" && Object.hasOwn(TOOL_REFUSALS, reason)
    ? TOOL_REFUSALS[reason]
    : undefined;
}

/**
 * The form field a refusal's path names: the tools a save works out, and
 * the tools it accepts, are both drawn by the checklist.
 */
export const toolField = (path: string | undefined): string | undefined =>
  path === "tools" || path === "accept_added_tools" ? "deny" : path;

/** The reason code a refusal carries, if any. */
export const reasonOf = (failure: ApiError): unknown =>
  (failure.details as { readonly reason_code?: unknown } | undefined)
    ?.reason_code;

const BOUNDARY_BADGE: Record<ToolBoundaryValue, "gray" | "blue" | "amber"> = {
  local: "gray",
  egress: "blue",
  provider: "amber",
};

/**
 * A profile form's "built-in tools to block" checklist: a ticked box blocks
 * that tool. On a next version it also lists how the catalog changed and
 * asks for each tool the previous version never had before it may run.
 */
export function DenyChecklist({
  model,
  picks,
  onPicks,
  disabled,
  previousId,
  error,
}: {
  readonly model: ToolChoiceModel;
  readonly picks: ToolPicks;
  readonly onPicks: (picks: ToolPicks) => void;
  readonly disabled: boolean;
  /** The version the catalog change is read against. */
  readonly previousId: string | undefined;
  readonly error: string | undefined;
}) {
  const { t } = useI18n();
  // A FieldSet's error reaches no checkbox by itself: each Field links only its own parts.
  const errorId = useId();
  const describedBy = error ? errorId : undefined;
  const blocked = new Set(blockedOf(model, picks));
  const fixed = new Set(model.fixed);
  const accepting = needsAccepting(model, picks);
  const fresh = new Set(accepting);
  const accepted = new Set(picks.accepted);
  const hasProvider = model.catalog.tools.some(
    (tool) => model.boundaries?.get(tool.name) === "provider",
  );

  return (
    <>
      <FieldSet className="gap-3">
        <FieldLegend variant="label" className="mb-2">
          {t("profiles.tools.legend")}
        </FieldLegend>
        <FieldDescription>{t("profiles.tools.hint")}</FieldDescription>
        <FieldDescription>
          {t("profiles.tools.unlimited", { catalog: model.catalog.id })}
        </FieldDescription>
        {hasProvider ? (
          <FieldDescription className="nth-last-2:mt-0">
            {t("profiles.tools.providerNote")}
          </FieldDescription>
        ) : null}
        {model.catalog.tools.map(({ name }) => {
          const boundary = model.boundaries?.get(name);
          const locked = fixed.has(name);
          return (
            <Field key={name} orientation="horizontal">
              <Checkbox
                checked={blocked.has(name)}
                disabled={disabled || locked}
                aria-describedby={describedBy}
                onCheckedChange={(checked) =>
                  onPicks({
                    ...picks,
                    blocked: { ...picks.blocked, [name]: checked === true },
                  })
                }
              />
              <FieldContent>
                <FieldLabel className="font-mono">{name}</FieldLabel>
                {boundary || locked || fresh.has(name) ? (
                  <FieldDescription className="flex flex-wrap items-center gap-1">
                    {boundary ? (
                      <Badge variant={BOUNDARY_BADGE[boundary]}>
                        {t(`profiles.tools.boundary.${boundary}`)}
                      </Badge>
                    ) : null}
                    {fresh.has(name) ? (
                      <Badge variant="blue">{t("profiles.tools.new")}</Badge>
                    ) : null}
                    {locked ? t("profiles.tools.fixed") : null}
                  </FieldDescription>
                ) : null}
              </FieldContent>
            </Field>
          );
        })}
        <FieldError id={errorId}>{error}</FieldError>
      </FieldSet>

      {model.versioned && (accepting.length > 0 || model.removed.length > 0) ? (
        <FieldSet className="gap-3 rounded-card border bg-muted/40 p-3">
          <FieldLegend variant="label" className="mb-0">
            {t("profiles.tools.diff.legend")}
          </FieldLegend>
          <FieldDescription>
            {t("profiles.tools.diff.text", { id: previousId ?? "" })}
          </FieldDescription>
          {accepting.map((name) => (
            <Field key={name} orientation="horizontal">
              <Checkbox
                checked={accepted.has(name)}
                disabled={disabled}
                aria-describedby={describedBy}
                aria-invalid={
                  error && !blocked.has(name) && !accepted.has(name)
                    ? true
                    : undefined
                }
                onCheckedChange={(checked) =>
                  onPicks({
                    ...picks,
                    accepted:
                      checked === true
                        ? [...picks.accepted, name]
                        : picks.accepted.filter((other) => other !== name),
                  })
                }
              />
              <FieldContent>
                <FieldLabel>
                  {t("profiles.tools.diff.accept", { tool: name })}
                </FieldLabel>
                <FieldDescription>
                  {t(
                    blocked.has(name)
                      ? "profiles.tools.diff.stillBlocked"
                      : "profiles.tools.diff.opens",
                  )}
                </FieldDescription>
              </FieldContent>
            </Field>
          ))}
          {model.removed.length > 0 ? (
            <FieldDescription className="flex flex-wrap items-center gap-1">
              {t("profiles.tools.diff.removed")}
              {model.removed.map((name) => (
                <Badge key={name} variant="mono">
                  {name}
                </Badge>
              ))}
            </FieldDescription>
          ) : null}
        </FieldSet>
      ) : null}
    </>
  );
}
