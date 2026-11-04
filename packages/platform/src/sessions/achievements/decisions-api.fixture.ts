/**
 * The Decisions API as its guide documented it, read 2026-11-02:
 * https://developers.openai.com/api/docs/guides/decisions
 * `POST /v1/decisions`; Luna (`gpt-6-luna`) charges $0.10 per million
 * uncached input tokens and nothing for its answers. Prompt caching
 * (`prompt_cache_key`, `prompt_cache_options`) is not used.
 *
 * ASSUMPTION marks what the guide does not document; confirm each against
 * a real connection.
 */

/** One choice question, as the judge sends it per (rule, evidence) pair. */
export const DECISIONS_REQUEST_FIXTURE = {
  model: "gpt-6-luna",
  input:
    '<definition>A merged pull request that fixes a bug.</definition>\n<evidence kind="github_pull_request">\nrepository: acme/app\nnumber: 12\nstate: merged\nmerged_at: 2026-11-02T10:00:00.000Z\nadditions: 3\ndeletions: 1\ntitle: <untrusted>Fix the payment retry</untrusted>\n</evidence>',
  questions: [
    {
      type: "choice",
      name: "achievement",
      instructions: "…",
      choices: [
        { value: "yes", description: "…" },
        { value: "no", description: "…" },
      ],
    },
  ],
} as const;

export const DECISIONS_CHOICE_RESPONSE_FIXTURE = {
  // ASSUMPTION: whether the answer carries a top-level `id` is not
  // documented; the parser neither needs nor refuses one.
  answers: [
    {
      type: "choice",
      name: "achievement",
      choice: "yes",
      probabilities: [
        { value: "yes", probability: 0.94 },
        { value: "no", probability: 0.06 },
      ],
      confidence: 0.94,
    },
  ],
  // ASSUMPTION: no output token field is documented; output is not charged.
  usage: {
    input_tokens: 612,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  },
} as const;

export const DECISIONS_REFUSAL_RESPONSE_FIXTURE = {
  answers: [{ type: "refusal", name: "achievement" }],
  usage: {
    input_tokens: 598,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  },
} as const;

/**
 * ASSUMPTION: the error body and its codes are not documented; this is the
 * envelope OpenAI's other APIs use. The judge never reads or logs it.
 */
export const DECISIONS_ERROR_RESPONSE_FIXTURE = {
  error: {
    message: "Incorrect API key provided: sk-...wxyz.",
    type: "invalid_request_error",
    code: "invalid_api_key",
  },
} as const;
