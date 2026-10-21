import {
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  useId,
  useState,
} from "react";

import { cn } from "../lib/cn.ts";
import { Button } from "../primitives/button.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../primitives/field.tsx";
import { Textarea } from "../primitives/textarea.tsx";

export interface ComposerQueuedMessage {
  readonly id: string;
  readonly text: string;
}

export interface ComposerMessages {
  readonly label: string;
  readonly send: string;
  /** Under the field, e.g. how to send from the keyboard. */
  readonly hint?: string | undefined;
  /** Names the list of messages waiting for the current turn to end. */
  readonly queued: string;
}

export interface ComposerProps {
  readonly messages: ComposerMessages;
  /**
   * Resolves once the server accepted the message; the field clears only
   * then. A rejection keeps the text so nothing typed is lost.
   */
  readonly onSend: (text: string) => unknown;
  readonly pending?: boolean | undefined;
  /** The session takes no messages now; `disabledReason` says why. */
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  readonly error?: string | undefined;
  readonly queued?: readonly ComposerQueuedMessage[] | undefined;
  readonly placeholder?: string | undefined;
  readonly className?: string | undefined;
}

export function Composer({
  messages,
  onSend,
  pending = false,
  disabled = false,
  disabledReason,
  error,
  queued = [],
  placeholder,
  className,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const queuedId = useId();
  const blocked = disabled || pending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || blocked) return;
    try {
      await onSend(message);
      setText("");
    } catch {
      // The screen shows why through `error`; the text stays for a retry.
    }
  };

  const sendFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <div
      data-slot="composer"
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      {queued.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p id={queuedId} className="text-muted-foreground text-xs">
            {messages.queued}
          </p>
          <ol aria-labelledby={queuedId} className="flex flex-col gap-1">
            {queued.map((message) => (
              <li
                key={message.id}
                className="rounded-md border border-dashed px-3 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
              >
                {message.text}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <form className="flex flex-col gap-2" onSubmit={submit}>
        <Field data-disabled={disabled || undefined}>
          <FieldLabel>{messages.label}</FieldLabel>
          <Textarea
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={sendFromKeyboard}
          />
          {disabled && disabledReason ? (
            <FieldDescription>{disabledReason}</FieldDescription>
          ) : messages.hint ? (
            <FieldDescription>{messages.hint}</FieldDescription>
          ) : null}
          <FieldError>{error}</FieldError>
        </Field>
        <Button
          type="submit"
          className="self-end"
          disabled={blocked || !text.trim()}
          aria-busy={pending || undefined}
        >
          {messages.send}
        </Button>
      </form>
    </div>
  );
}
