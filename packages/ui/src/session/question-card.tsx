import type { PendingRequest } from "@werft-ai/contracts";
import { Hourglass } from "lucide-react";
import { type FormEvent, type JSX, useId, useState } from "react";

import { cn } from "../foundations/cn.ts";
import {
  formatTimestamp,
  type TimestampLocale,
} from "../foundations/format-timestamp.ts";
import { Button } from "../primitives/button.tsx";
import { Checkbox } from "../primitives/checkbox.tsx";
import {
  Field,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../primitives/field.tsx";
import { RadioGroup, RadioGroupItem } from "../primitives/radio-group.tsx";
import { Textarea } from "../primitives/textarea.tsx";
import { useExpired, useExpiryFocus } from "./expiry.ts";

export type QuestionRequest = Extract<PendingRequest, { kind: "question" }>;
type Question = QuestionRequest["questions"][number];

/** One question's answer, as the answers endpoint takes it. */
export interface QuestionAnswer {
  readonly question_id: string;
  readonly selected_option_ids: string[];
  readonly free_text?: string;
}

export interface QuestionCardMessages {
  readonly title: string;
  /** Takes the formatted expiry time. */
  readonly expires: (at: string) => string;
  readonly expired: string;
  /** Labels the free-text field of a question that allows one. */
  readonly freeText: string;
  /** Shown under a question left without a choice or text. */
  readonly unanswered: string;
  readonly submit: string;
}

export interface QuestionCardProps {
  readonly request: QuestionRequest;
  readonly messages: QuestionCardMessages;
  /** Every question answered, in the order asked. */
  readonly onSubmit: (answers: QuestionAnswer[]) => void;
  /** An answer was sent and its receipt has not come back. */
  readonly pending?: boolean | undefined;
  /** The reader may not answer; the screen says why next to the card. */
  readonly disabled?: boolean | undefined;
  /** Why the last answer was refused. */
  readonly error?: string | undefined;
  /** Epoch ms the expiry is compared against; the screen's clock. */
  readonly now?: number | undefined;
  readonly locale?: TimestampLocale | undefined;
  readonly className?: string | undefined;
}

interface Draft {
  readonly selected: readonly string[];
  readonly text: string;
}

const EMPTY: Draft = { selected: [], text: "" };

function answerOf(question: Question, draft: Draft): QuestionAnswer | null {
  const text = question.allow_free_text ? draft.text.trim() : "";
  if (draft.selected.length === 0 && !text) return null;
  return {
    question_id: question.question_id,
    selected_option_ids: [...draft.selected],
    ...(text ? { free_text: text } : {}),
  };
}

export function QuestionCard({
  request,
  messages,
  onSubmit,
  pending = false,
  disabled = false,
  error,
  now = Date.now(),
  locale = "ko",
  className,
}: QuestionCardProps): JSX.Element {
  const titleId = useId();
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const [tried, setTried] = useState(false);
  const expired = useExpired(request.request_id, request.expires_at, now);
  const { noticeRef, within } = useExpiryFocus(expired);

  const draftOf = (question: Question) => drafts[question.question_id] ?? EMPTY;
  const edit = (question: Question, change: Partial<Draft>) =>
    setDrafts((current) => ({
      ...current,
      [question.question_id]: {
        ...(current[question.question_id] ?? EMPTY),
        ...change,
      },
    }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const answers = request.questions.map((question) =>
      answerOf(question, draftOf(question)),
    );
    if (answers.some((answer) => answer === null)) {
      setTried(true);
      return;
    }
    onSubmit(answers as QuestionAnswer[]);
  };

  return (
    <article
      aria-labelledby={titleId}
      aria-busy={pending || undefined}
      data-slot="question-card"
      data-expired={expired || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border border-[var(--ap-tone-attention-border)] bg-[var(--ap-tone-attention-bg)] p-4 text-control",
        className,
      )}
      {...within}
    >
      <div className="flex items-center gap-2">
        <Hourglass
          className="size-4 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {/* Not a heading: the level depends on the screen around the card. */}
        <p id={titleId} className="font-semibold text-body">
          {messages.title}
        </p>
        <p
          ref={noticeRef}
          tabIndex={expired ? -1 : undefined}
          className="ml-auto text-right text-muted-foreground text-caption"
        >
          {expired
            ? messages.expired
            : messages.expires(formatTimestamp(request.expires_at, locale))}
        </p>
      </div>
      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        {request.questions.map((question) => (
          <QuestionFields
            key={question.question_id}
            question={question}
            draft={draftOf(question)}
            onChange={(change) => edit(question, change)}
            disabled={expired || pending || disabled}
            freeTextLabel={messages.freeText}
            unanswered={
              tried && answerOf(question, draftOf(question)) === null
                ? messages.unanswered
                : undefined
            }
          />
        ))}
        <FieldError>{error}</FieldError>
        {expired ? null : (
          <Button
            type="submit"
            className="w-full"
            disabled={pending || disabled}
          >
            {messages.submit}
          </Button>
        )}
      </form>
    </article>
  );
}

function QuestionFields({
  question,
  draft,
  onChange,
  disabled,
  freeTextLabel,
  unanswered,
}: {
  readonly question: Question;
  readonly draft: Draft;
  readonly onChange: (change: Partial<Draft>) => void;
  readonly disabled: boolean;
  readonly freeTextLabel: string;
  readonly unanswered: string | undefined;
}) {
  const legendId = useId();
  const options = question.options;
  return (
    <FieldSet className="m-0 gap-3 border-0 p-0">
      <FieldLegend
        id={legendId}
        variant="label"
        className="mb-3 text-body [overflow-wrap:anywhere]"
      >
        {question.prompt}
      </FieldLegend>
      {options.length === 0 ? null : question.multi_select ? (
        <div className="flex flex-col gap-2">
          {options.map((option) => (
            <Field
              key={option.option_id}
              orientation="horizontal"
              className="min-h-8 text-control"
            >
              <Checkbox
                disabled={disabled}
                checked={draft.selected.includes(option.option_id)}
                onCheckedChange={(checked) =>
                  onChange({
                    selected:
                      checked === true
                        ? [...draft.selected, option.option_id]
                        : draft.selected.filter(
                            (id) => id !== option.option_id,
                          ),
                  })
                }
              />
              <FieldLabel className="text-control">{option.label}</FieldLabel>
            </Field>
          ))}
        </div>
      ) : (
        <RadioGroup
          aria-labelledby={legendId}
          className="gap-2"
          disabled={disabled}
          value={draft.selected[0] ?? ""}
          onValueChange={(value) => onChange({ selected: [value] })}
        >
          {options.map((option) => (
            <Field
              key={option.option_id}
              orientation="horizontal"
              className="min-h-8 text-control"
            >
              <RadioGroupItem value={option.option_id} />
              <FieldLabel className="text-control">{option.label}</FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      )}
      {question.allow_free_text ? (
        <Field>
          <FieldLabel>{freeTextLabel}</FieldLabel>
          <Textarea
            disabled={disabled}
            value={draft.text}
            onChange={(event) => onChange({ text: event.target.value })}
          />
        </Field>
      ) : null}
      <FieldError>{unanswered}</FieldError>
    </FieldSet>
  );
}
