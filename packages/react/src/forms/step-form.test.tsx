/// <reference lib="dom" />
import { describe, expect, mock, test } from "bun:test";
import { type ApiClient, ApiError } from "@agent-platform/client";
import {
  type AgentCard,
  createAgentRequestSchema,
} from "@agent-platform/contracts";
import {
  type AgentCardDraft,
  agentCardStep,
  agentIdentityStep,
} from "@agent-platform/core/forms";
import { Field, FieldError, FieldLabel, Input } from "@agent-platform/ui";
import { setupDom, setupUser } from "@agent-platform/ui/test-support/dom";
import type { ReactNode } from "react";
import type { DefaultValues } from "react-hook-form";
import type { z } from "zod";
import { defaultMessages } from "../messages/index.ts";
import { AgentPlatformProvider } from "../provider.tsx";
import {
  formAlerts,
  type StepForm,
  type StepSchema,
  submitStep,
  useStepForm,
} from "./step-form.ts";

const { render, screen, waitFor } = await setupDom();
const ko = defaultMessages.ko;

function Wrap({ children }: { readonly children: ReactNode }) {
  return (
    <AgentPlatformProvider
      client={{} as ApiClient}
      locale="ko"
      renderLink={({ children: label }) => label}
    >
      {children}
    </AgentPlatformProvider>
  );
}

// The host's wording for a failed request; the console's comes from errorKey.
const serverMessage = (error: unknown) =>
  error instanceof ApiError ? `server:${error.code}` : "server:UNKNOWN";

/** The convention as a step screen writes it: alerts on top, a Field each. */
function StepFormView<S extends StepSchema>({
  schema,
  fields,
  defaultValues,
  send,
}: {
  readonly schema: S;
  readonly fields: readonly (keyof z.input<S> & string)[];
  readonly defaultValues: DefaultValues<z.input<S>>;
  readonly send: (values: z.output<S>) => unknown;
}) {
  const form: StepForm<S> = useStepForm(schema, { defaultValues });
  const { errors } = form.formState;
  return (
    <form noValidate onSubmit={submitStep(form, send, serverMessage)}>
      {formAlerts(errors, fields).map((message) => (
        <p key={message} role="alert" data-testid="form-alert">
          {message}
        </p>
      ))}
      {fields.map((name) => (
        <Field key={name}>
          <FieldLabel>{name}</FieldLabel>
          <Input {...form.register(name as never)} />
          <FieldError>
            {(errors as Record<string, { message?: string }>)[name]?.message}
          </FieldError>
        </Field>
      ))}
      <button type="submit">submit</button>
    </form>
  );
}

const identity = (send: (values: { slug: string; name: string }) => unknown) =>
  render(
    <Wrap>
      <StepFormView
        schema={agentIdentityStep}
        fields={["slug", "name"]}
        defaultValues={{ slug: "", name: "" }}
        send={send}
      />
    </Wrap>,
  );

const fill = async (values: Record<string, string>) => {
  const user = await setupUser();
  for (const [name, value] of Object.entries(values)) {
    const input = screen.getByLabelText(name);
    await user.clear(input);
    if (value) await user.type(input, value);
  }
  await user.click(screen.getByRole("button", { name: "submit" }));
};

const fieldError = (name: string) =>
  screen
    .getByLabelText(name)
    .closest("[data-slot=field]")
    ?.querySelector("[data-slot=field-error]")?.textContent ?? null;

describe("a step form", () => {
  test("whitespace alone is an empty field, and nothing is sent", async () => {
    const send = mock();
    const { unmount } = identity(send);
    await fill({ slug: "   ", name: " " });
    await waitFor(() =>
      expect(fieldError("name")).toBe(ko["form.error.required"]),
    );
    expect(fieldError("slug")).toBe(ko["form.error.required"]);
    expect(screen.getByLabelText("slug").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(send).not.toHaveBeenCalled();
    unmount();
  });

  test("a contract check's own English message is replaced by ours", async () => {
    const { unmount } = identity(mock());
    await fill({ slug: "Not Kebab", name: "Refunds" });
    await waitFor(() =>
      expect(fieldError("slug")).toBe(ko["form.error.format"]),
    );
    expect(screen.queryByText(/kebab-case/)).toBeNull();
    unmount();
  });

  test("every field valid goes to the request, trimmed", async () => {
    const post = mock(async (_path: string, init: { body: unknown }) => {
      createAgentRequestSchema.parse(init.body);
      return { data: {} };
    });
    const card = agentCardStep().parse({
      role: "Support",
      instructions: "Answer.",
      tone: "",
      language: "ko",
      model: "claude-sonnet-5",
      toolsMode: "all",
      tools: "",
      forbidden: "",
    });
    const { unmount } = identity((values) =>
      post("/v1/agents", { body: { ...values, card } }),
    );
    await fill({ slug: "  refunds ", name: " Refunds " });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[1].body).toEqual({
      slug: "refunds",
      name: "Refunds",
      card,
    });
    expect(screen.queryAllByTestId("form-alert")).toEqual([]);
    unmount();
  });

  test("a server 400 is one line above the form, no field marked", async () => {
    const send = mock(async () => {
      throw new ApiError(400, "BAD_REQUEST", "Request body is invalid", {
        details: null,
      });
    });
    const { unmount } = identity(send);
    await fill({ slug: "refunds", name: "Refunds" });
    await waitFor(() =>
      expect(
        screen.getAllByTestId("form-alert").map((line) => line.textContent),
      ).toEqual(["server:BAD_REQUEST"]),
    );
    const form = screen.getByRole("button", { name: "submit" }).closest("form");
    expect(form?.firstElementChild?.textContent).toBe("server:BAD_REQUEST");
    expect(fieldError("slug")).toBeNull();
    expect(fieldError("name")).toBeNull();
    unmount();
  });

  test("an error on a path no field shows is listed above the form", async () => {
    const base: AgentCard = {
      role: "Support",
      instructions: "Answer.",
      language: "ko",
      model: "claude-sonnet-5",
      capabilities: { tools: null, mcp: null, forbidden: [] },
      rules: [],
    };
    const send = mock();
    const draft: AgentCardDraft = {
      role: "Support",
      instructions: "Answer.",
      tone: "",
      language: "ko",
      model: "claude-sonnet-5",
      toolsMode: "list",
      tools: "x".repeat(129),
      forbidden: "",
    };
    const { unmount } = render(
      <Wrap>
        <StepFormView
          schema={agentCardStep(base)}
          fields={["role", "instructions", "model"]}
          defaultValues={draft}
          send={send}
        />
      </Wrap>,
    );
    await fill({});
    await waitFor(() =>
      expect(
        screen.getAllByTestId("form-alert").map((line) => line.textContent),
      ).toEqual([ko["form.error.tooLong"].replace("{max}", "128")]),
    );
    expect(send).not.toHaveBeenCalled();
    unmount();
  });
});

describe("formAlerts", () => {
  test("the server's line first, then root errors, then unmapped paths", () => {
    expect(
      formAlerts(
        {
          name: { type: "too_small", message: "name" },
          capabilities: {
            tools: [{ type: "too_big", message: "tool" }],
          },
          root: {
            type: "custom",
            message: "root",
            server: { type: "server", message: "server" },
            other: { type: "custom", message: "other" },
          },
        } as never,
        ["name"],
      ),
    ).toEqual(["server", "root", "other", "tool"]);
  });

  test("an error inside a field's path belongs to that field", () => {
    expect(
      formAlerts({ tools: [{ type: "too_big", message: "tool" }] } as never, [
        "tools",
      ]),
    ).toEqual([]);
  });
});
