import { Check, Search } from "lucide-react";
import {
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";
import { Input } from "../primitives/input.tsx";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../primitives/popover.tsx";

/*
 * ARIA 1.2 combobox with a list popup, single select. Focus never leaves the
 * input: arrows move `aria-activedescendant` through the enabled options and,
 * last, the "load more" button. That button sits after the listbox because a
 * listbox may only own options. The list takes the v4 command palette's
 * values (`.cmd-list`, `.cmd-item`). The kit has no words of its own, so every
 * message is a prop.
 */

export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  /** Second line: an email, a channel's visibility. Strings are searched. */
  readonly description?: ReactNode;
  /** Shown but not choosable, e.g. someone already on the team. */
  readonly disabled?: boolean;
}

export interface ComboboxProps {
  readonly options: readonly ComboboxOption[];
  /** The chosen value; leave undefined to let the combobox keep it. */
  readonly value?: string | null | undefined;
  readonly onValueChange?:
    | ((value: string, option: ComboboxOption) => void)
    | undefined;
  /** Empty the input after a choice, for flows that add and move on. */
  readonly clearOnSelect?: boolean | undefined;
  readonly inputValue?: string | undefined;
  readonly defaultInputValue?: string | undefined;
  readonly onInputValueChange?: ((value: string) => void) | undefined;
  /**
   * `internal` matches the typed text inside each label and string
   * description, ignoring case and full-width forms. `none` shows `options`
   * as given: the caller searches, usually on the server, via `onQueryChange`.
   */
  readonly filter?: "internal" | "none" | undefined;
  /** Called once typing pauses for `debounceMs`; only with `filter="none"`. */
  readonly onQueryChange?: ((query: string) => void) | undefined;
  readonly debounceMs?: number | undefined;
  readonly loading?: boolean | undefined;
  readonly loadingMessage?: ReactNode;
  readonly hasMore?: boolean | undefined;
  readonly onLoadMore?: (() => void) | undefined;
  readonly loadMoreLabel?: ReactNode;
  readonly emptyMessage: ReactNode;
  /** Read out in a polite status region when the open list's size changes. */
  readonly resultCountMessage?: ((count: number) => string) | undefined;
  readonly "aria-label"?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
}

const LOAD_MORE = Symbol("load-more");
type ActiveKey = string | typeof LOAD_MORE | null;

function normalize(text: string, locale: string | undefined): string {
  return text.normalize("NFKC").toLocaleLowerCase(locale);
}

function filterOptions(
  options: readonly ComboboxOption[],
  query: string,
): readonly ComboboxOption[] {
  const locale = document.documentElement.lang || undefined;
  const needle = normalize(query.trim(), locale);
  if (!needle) return options;
  return options.filter((option) =>
    [option.label, option.description].some(
      (text) =>
        typeof text === "string" && normalize(text, locale).includes(needle),
    ),
  );
}

export function Combobox({
  options,
  value,
  onValueChange,
  clearOnSelect = false,
  inputValue: inputValueProp,
  defaultInputValue,
  onInputValueChange,
  filter = "internal",
  onQueryChange,
  debounceMs = 250,
  loading = false,
  loadingMessage,
  hasMore = false,
  onLoadMore,
  loadMoreLabel,
  emptyMessage,
  resultCountMessage,
  "aria-label": ariaLabel,
  placeholder,
  disabled = false,
  id,
  className,
}: ComboboxProps): JSX.Element {
  const baseId = useId();
  const contentId = `${baseId}-content`;
  const listboxId = `${baseId}-listbox`;
  const loadMoreId = `${baseId}-load-more`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const [ownValue, setOwnValue] = useState<string | null>(null);
  const selected = value === undefined ? ownValue : value;
  const [ownInput, setOwnInput] = useState(
    () =>
      defaultInputValue ??
      (clearOnSelect
        ? ""
        : (options.find((option) => option.value === selected)?.label ?? "")),
  );
  const inputValue = inputValueProp ?? ownInput;
  // What the list is filtered by: the typed text, reset by a choice so that
  // reopening after one shows every option again.
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ActiveKey>(null);

  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestOnQueryChange = useRef(onQueryChange);
  latestOnQueryChange.current = onQueryChange;
  useEffect(() => () => clearTimeout(timer.current), []);

  const visible =
    filter === "internal" ? filterOptions(options, query) : options;
  const showLoadMore = hasMore && !loading && onLoadMore !== undefined;
  const keys: ActiveKey[] = [
    ...visible.filter((option) => !option.disabled).map((o) => o.value),
    ...(showLoadMore ? [LOAD_MORE as ActiveKey] : []),
  ];
  const activeKey = keys.includes(active) ? active : null;
  const activeIndex = visible.findIndex((option) => option.value === activeKey);
  const activeId =
    activeKey === LOAD_MORE
      ? loadMoreId
      : activeIndex >= 0
        ? optionId(activeIndex)
        : undefined;
  const isOpen = open && !disabled;
  const hasListbox = visible.length > 0 || loading;

  useEffect(() => {
    if (!isOpen || !activeId) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [isOpen, activeId]);

  function changeInput(next: string) {
    if (inputValueProp === undefined) setOwnInput(next);
    onInputValueChange?.(next);
  }

  function close() {
    setOpen(false);
    setActive(null);
  }

  function choose(option: ComboboxOption) {
    if (option.disabled) return;
    if (value === undefined) setOwnValue(option.value);
    onValueChange?.(option.value, option);
    changeInput(clearOnSelect ? "" : option.label);
    setQuery("");
    close();
  }

  function type(next: string) {
    changeInput(next);
    setQuery(next);
    setActive(null);
    if (filter === "none" && latestOnQueryChange.current) {
      clearTimeout(timer.current);
      timer.current = setTimeout(
        () => latestOnQueryChange.current?.(next),
        debounceMs,
      );
    }
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    type(event.target.value);
    setOpen(true);
  }

  function move(to: ActiveKey) {
    setOpen(true);
    setActive(to);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const at = activeKey === null ? -1 : keys.indexOf(activeKey);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) move(keys[0] ?? null);
        else move(keys[Math.min(at + 1, keys.length - 1)] ?? null);
        return;
      case "ArrowUp":
        event.preventDefault();
        if (!isOpen || at < 0) move(keys.at(-1) ?? null);
        else move(keys[Math.max(at - 1, 0)] ?? null);
        return;
      case "Home":
      case "End":
        if (!isOpen) return;
        event.preventDefault();
        move((event.key === "Home" ? keys[0] : keys.at(-1)) ?? null);
        return;
      case "Enter": {
        if (!isOpen) return;
        event.preventDefault();
        if (activeKey === LOAD_MORE) onLoadMore?.();
        else {
          const option = visible[activeIndex];
          if (option) choose(option);
        }
        return;
      }
      case "Escape":
        if (isOpen) {
          event.preventDefault();
          close();
        } else if (inputValue) {
          event.preventDefault();
          type("");
        }
        return;
      case "Tab":
        close();
        return;
    }
  }

  const status = !isOpen
    ? ""
    : loading
      ? loadingMessage
      : visible.length === 0
        ? emptyMessage
        : (resultCountMessage?.(visible.length) ?? "");

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          data-slot="combobox"
          className={cn("relative w-full", className)}
        >
          <Search
            aria-hidden="true"
            strokeWidth={1.5}
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-subtle-foreground"
          />
          <Input
            ref={inputRef}
            id={id}
            type="text"
            role="combobox"
            autoComplete="off"
            aria-label={ariaLabel}
            aria-autocomplete="list"
            aria-expanded={isOpen}
            // With no options there is no listbox; the popup then holds the
            // empty message.
            aria-controls={
              isOpen ? (hasListbox ? listboxId : contentId) : undefined
            }
            aria-activedescendant={isOpen ? activeId : undefined}
            placeholder={placeholder}
            disabled={disabled}
            value={inputValue}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onClick={() => setOpen(true)}
            onBlur={close}
            className="pl-8"
          />
          {/* biome-ignore lint/a11y/useSemanticElements: <output> is not announced as a live region by every screen reader. */}
          <div role="status" className="sr-only">
            {status}
          </div>
        </div>
      </PopoverAnchor>
      {/* biome-ignore lint/a11y/useValidAriaRole: undefined drops the dialog role Radix sets; the box only holds the listbox and is never focused, since focus stays in the input. */}
      <PopoverContent
        align="start"
        data-slot="combobox-content"
        role={undefined}
        tabIndex={undefined}
        id={contentId}
        className="flex max-h-80 w-[var(--radix-popover-trigger-width)] max-w-none flex-col p-1 text-control"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) {
            event.preventDefault();
          }
        }}
        // Keep focus, and with it typing, in the input on a pointer press.
        onMouseDown={(event) => event.preventDefault()}
      >
        {hasListbox && (
          <div
            role="listbox"
            id={listboxId}
            // A FieldLabel names only the input; the list repeats its words.
            aria-label={
              ariaLabel ??
              inputRef.current?.labels?.[0]?.textContent ??
              undefined
            }
            aria-busy={loading || undefined}
            className="min-h-0 overflow-y-auto"
          >
            {visible.map((option, index) => {
              const isSelected = option.value === selected;
              return (
                // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: focus stays in the input, which handles the keys and points here with aria-activedescendant.
                <div
                  key={option.value}
                  role="option"
                  id={optionId(index)}
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  data-active={option.value === activeKey || undefined}
                  className={cn(
                    "flex min-h-10 cursor-default items-center gap-3 rounded-control px-3",
                    option.description !== undefined && "py-1.5",
                    "data-[active]:bg-hover aria-disabled:opacity-50",
                  )}
                  onPointerMove={() => {
                    if (!option.disabled) setActive(option.value);
                  }}
                  onClick={() => choose(option)}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.description !== undefined && (
                      <span className="truncate text-caption text-subtle-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                  <Check
                    aria-hidden="true"
                    strokeWidth={1.5}
                    className={cn(
                      "size-4 shrink-0",
                      !isSelected && "invisible",
                    )}
                  />
                </div>
              );
            })}
          </div>
        )}
        {loading && (
          <p className="p-3 text-caption text-subtle-foreground">
            {loadingMessage}
          </p>
        )}
        {!loading && visible.length === 0 && (
          <p className="p-3 text-caption text-subtle-foreground">
            {emptyMessage}
          </p>
        )}
        {showLoadMore && (
          <button
            type="button"
            id={loadMoreId}
            tabIndex={-1}
            data-active={activeKey === LOAD_MORE || undefined}
            className="flex h-10 w-full items-center gap-3 rounded-control px-3 text-left data-[active]:bg-hover"
            onPointerMove={() => setActive(LOAD_MORE)}
            onClick={onLoadMore}
          >
            {loadMoreLabel}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
