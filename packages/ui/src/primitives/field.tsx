import { cva, type VariantProps } from "class-variance-authority";
import {
  type ComponentProps,
  createContext,
  type JSX,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import { cn } from "../lib/cn.ts";

/*
 * shadcn/ui new-york Field. Changed from upstream: a Field wires itself up.
 * Upstream leaves `id`, `htmlFor` and `aria-describedby` to the caller; here
 * the Field mints the ids, FieldLabel points at the control, and the single
 * control inside (Input, Textarea, Checkbox) reads them through
 * `useFieldControl`. FieldDescription and FieldError register themselves, so
 * `aria-describedby` only names elements that are on the page, and a mounted
 * FieldError marks the control `aria-invalid`. FieldLabel is a native <label>
 * rather than Radix Label, Field drops its unnamed `role="group"` (FieldSet
 * is the named group), FieldSeparator and FieldTitle are left out, and there
 * are no `dark:` variants.
 */

interface FieldContextValue {
  readonly controlId: string;
  readonly descriptionId: string;
  readonly errorId: string;
  readonly hasDescription: boolean;
  readonly hasError: boolean;
  readonly setPart: (part: "description" | "error", present: boolean) => void;
}

const FieldContext = createContext<FieldContextValue | null>(null);

interface FieldControlProps {
  readonly id?: string | undefined;
  readonly "aria-describedby"?: string | undefined;
  readonly "aria-invalid"?: ComponentProps<"input">["aria-invalid"];
}

/**
 * The id and ARIA a control inside a Field should carry. Values the caller set
 * explicitly win; a caller's `aria-describedby` is kept and the Field's parts
 * are appended.
 */
export function useFieldControl<P extends FieldControlProps>(props: P): P {
  const field = useContext(FieldContext);
  if (!field) return props;
  const describedBy = [
    props["aria-describedby"],
    field.hasDescription ? field.descriptionId : undefined,
    field.hasError ? field.errorId : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ...props,
    id: props.id ?? field.controlId,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": props["aria-invalid"] ?? (field.hasError || undefined),
  };
}

function useRegisterPart(part: "description" | "error"): string | undefined {
  const field = useContext(FieldContext);
  const setPart = field?.setPart;
  useLayoutEffect(() => {
    if (!setPart) return;
    setPart(part, true);
    return () => setPart(part, false);
  }, [setPart, part]);
  if (!field) return undefined;
  return part === "description" ? field.descriptionId : field.errorId;
}

export function FieldSet({
  className,
  ...props
}: ComponentProps<"fieldset">): JSX.Element {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        "flex flex-col gap-6",
        "has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3",
        className,
      )}
      {...props}
    />
  );
}

export function FieldLegend({
  className,
  variant = "legend",
  ...props
}: ComponentProps<"legend"> & {
  readonly variant?: "legend" | "label" | undefined;
}): JSX.Element {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        "mb-3 font-medium",
        "data-[variant=legend]:text-base",
        "data-[variant=label]:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export function FieldGroup({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "group/field-group @container/field-group flex w-full flex-col gap-7 data-[slot=checkbox-group]:gap-3 [&>[data-slot=field-group]]:gap-4",
        className,
      )}
      {...props}
    />
  );
}

export const fieldVariants = cva(
  "group/field flex w-full gap-3 data-[invalid=true]:text-destructive",
  {
    variants: {
      orientation: {
        vertical: ["flex-col [&>*]:w-full [&>.sr-only]:w-auto"],
        horizontal: [
          "flex-row items-center",
          "[&>[data-slot=field-label]]:flex-auto",
          "has-[>[data-slot=field-content]]:items-start has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
        ],
        responsive: [
          "flex-col @md/field-group:flex-row @md/field-group:items-center [&>*]:w-full @md/field-group:[&>*]:w-auto [&>.sr-only]:w-auto",
          "@md/field-group:[&>[data-slot=field-label]]:flex-auto",
          "@md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
        ],
      },
    },
    defaultVariants: { orientation: "vertical" },
  },
);

export type FieldProps = ComponentProps<"div"> &
  VariantProps<typeof fieldVariants>;

export function Field({
  className,
  orientation = "vertical",
  ...props
}: FieldProps): JSX.Element {
  const id = useId();
  const [parts, setParts] = useState({ description: false, error: false });
  // Stable, or each registration would re-run every part's effect forever.
  const setPart = useCallback(
    (part: "description" | "error", present: boolean) =>
      setParts((current) =>
        current[part] === present ? current : { ...current, [part]: present },
      ),
    [],
  );
  const value = useMemo<FieldContextValue>(
    () => ({
      controlId: `${id}-control`,
      descriptionId: `${id}-description`,
      errorId: `${id}-error`,
      hasDescription: parts.description,
      hasError: parts.error,
      setPart,
    }),
    [id, parts, setPart],
  );
  return (
    <FieldContext.Provider value={value}>
      <div
        data-slot="field"
        data-orientation={orientation}
        data-invalid={parts.error || undefined}
        className={cn(fieldVariants({ orientation }), className)}
        {...props}
      />
    </FieldContext.Provider>
  );
}

export function FieldContent({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="field-content"
      className={cn(
        "group/field-content flex flex-1 flex-col gap-1.5 leading-snug",
        className,
      )}
      {...props}
    />
  );
}

export function FieldLabel({
  className,
  htmlFor,
  ...props
}: ComponentProps<"label">): JSX.Element {
  const field = useContext(FieldContext);
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor comes from the Field or the caller
    <label
      data-slot="field-label"
      htmlFor={htmlFor ?? field?.controlId}
      className={cn(
        "group/field-label peer/field-label flex w-fit select-none items-center gap-2 font-medium text-sm leading-snug group-data-[disabled=true]/field:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        "has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-md has-[>[data-slot=field]]:border [&>*]:data-[slot=field]:p-4",
        "has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5",
        className,
      )}
      {...props}
    />
  );
}

export function FieldDescription({
  className,
  id,
  ...props
}: ComponentProps<"p">): JSX.Element {
  const fieldId = useRegisterPart("description");
  return (
    <p
      data-slot="field-description"
      id={id ?? fieldId}
      className={cn(
        "font-normal text-muted-foreground text-sm leading-normal group-has-[[data-orientation=horizontal]]/field:text-balance",
        "nth-last-2:-mt-1 last:mt-0 [[data-variant=legend]+&]:-mt-1.5",
        "[&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Renders nothing without children, so a form can always place it and only
 * fill it when there is an error; only a rendered error marks the control
 * invalid.
 */
export function FieldError({
  className,
  children,
  ...props
}: ComponentProps<"div">): JSX.Element | null {
  if (children === undefined || children === null || children === false) {
    return null;
  }
  return (
    <FieldErrorMessage className={className} {...props}>
      {children}
    </FieldErrorMessage>
  );
}

function FieldErrorMessage({
  className,
  id,
  ...props
}: ComponentProps<"div">): JSX.Element {
  const fieldId = useRegisterPart("error");
  return (
    <div
      role="alert"
      data-slot="field-error"
      id={id ?? fieldId}
      className={cn("font-normal text-destructive text-sm", className)}
      {...props}
    />
  );
}
