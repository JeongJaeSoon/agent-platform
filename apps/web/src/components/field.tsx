import { type InputHTMLAttributes, useId } from "react";

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
