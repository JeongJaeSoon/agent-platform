import {
  type FormEvent,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from "react";

/**
 * A URL name (workspace or agent slug), with our sentence in place of the
 * browser's "match the requested format", which cannot say what it is.
 */
export function slugInput(message: string) {
  return {
    pattern: "[a-z0-9][a-z0-9\\-]*",
    maxLength: 64,
    onInvalid: (event: FormEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      if (input.validity.patternMismatch) input.setCustomValidity(message);
    },
    onInput: (event: FormEvent<HTMLInputElement>) =>
      event.currentTarget.setCustomValidity(""),
  };
}

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  /** Read after the label as a description, so it is not part of the name. */
  readonly hint?: string | undefined;
}

export function TextField({ label, hint, ...input }: TextFieldProps) {
  const hintId = useId();
  return (
    <div className="web-field">
      <label className="web-field">
        <span>{label}</span>
        <input
          className="ap-input"
          {...input}
          aria-describedby={hint ? hintId : input["aria-describedby"]}
        />
      </label>
      {hint ? (
        <span id={hintId} className="web-field__hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export interface TextAreaFieldProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly label: string;
  readonly hint?: string | undefined;
}

export function TextAreaField({ label, hint, ...area }: TextAreaFieldProps) {
  const hintId = useId();
  return (
    <div className="web-field">
      <label className="web-field">
        <span>{label}</span>
        <textarea
          className="ap-input web-field__area"
          {...area}
          aria-describedby={hint ? hintId : area["aria-describedby"]}
        />
      </label>
      {hint ? (
        <span id={hintId} className="web-field__hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
