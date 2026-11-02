import { describe, expect, test } from "bun:test";
import {
  DECISIONS_CHOICE_RESPONSE_FIXTURE,
  DECISIONS_ERROR_RESPONSE_FIXTURE,
  DECISIONS_REFUSAL_RESPONSE_FIXTURE,
  DECISIONS_REQUEST_FIXTURE,
} from "./decisions-api.fixture.ts";
import {
  createDecisionsClient,
  DecisionsCallError,
  type DecisionsRequest,
} from "./decisions-client.ts";

const REQUEST = DECISIONS_REQUEST_FIXTURE as unknown as DecisionsRequest;

function client(
  answer: (request: Request) => Response | Promise<Response>,
  timeoutMs?: number,
) {
  const seen: Request[] = [];
  const decisions = createDecisionsClient({
    egressUrl: "http://egress-proxy:3129/",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      return answer(request);
    }) as typeof fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { decisions, seen };
}

async function failure(promise: Promise<unknown>): Promise<DecisionsCallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DecisionsCallError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("decisions client", () => {
  test("posts the request to the proxy's judgment route with the judgment token, and parses the documented answer", async () => {
    const { decisions, seen } = client(() =>
      Response.json(DECISIONS_CHOICE_RESPONSE_FIXTURE),
    );
    const answer = await decisions.decide("wej_token", REQUEST);
    expect(answer.answers).toEqual([
      ...DECISIONS_CHOICE_RESPONSE_FIXTURE.answers,
    ] as never);
    const [request] = seen;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(
      "http://egress-proxy:3129/decisions/v1/decisions",
    );
    expect(request?.headers.get("authorization")).toBe("Bearer wej_token");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(await request?.json()).toEqual(DECISIONS_REQUEST_FIXTURE);
  });

  test("parses a refusal and tolerates fields the guide does not list", async () => {
    const { decisions } = client(() =>
      Response.json({ id: "dec_1", ...DECISIONS_REFUSAL_RESPONSE_FIXTURE }),
    );
    const answer = await decisions.decide("wej_token", REQUEST);
    expect(answer.answers).toEqual([{ type: "refusal", name: "achievement" }]);
  });

  test("an error answer fails with its status only: the body, which may name the key, is never kept", async () => {
    for (const status of [401, 429, 500, 503]) {
      const { decisions } = client(() =>
        Response.json(DECISIONS_ERROR_RESPONSE_FIXTURE, { status }),
      );
      const error = await failure(decisions.decide("wej_token", REQUEST));
      expect(error.reason).toBe("status");
      expect(error.status).toBe(status);
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain("wxyz");
    }
  });

  test("an answer slower than the timeout fails as a timeout", async () => {
    const { decisions } = client(
      (request) =>
        new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener("abort", () =>
            reject(request.signal.reason),
          ),
        ),
      20,
    );
    const error = await failure(decisions.decide("wej_token", REQUEST));
    expect(error.reason).toBe("timeout");
  });

  test("an unreachable proxy fails as unreachable", async () => {
    const { decisions } = client(() => {
      throw new TypeError("fetch failed");
    });
    expect((await failure(decisions.decide("wej_token", REQUEST))).reason).toBe(
      "unreachable",
    );
  });

  test("an answer of another shape fails as a bad response", async () => {
    for (const body of [
      "not json",
      JSON.stringify({ answers: "yes" }),
      JSON.stringify({ answers: [{ type: "ranking", name: "achievement" }] }),
      JSON.stringify({
        answers: [
          {
            type: "choice",
            name: "achievement",
            choice: "yes",
            probabilities: { yes: 0.94, no: 0.06 },
          },
        ],
      }),
      JSON.stringify({
        answers: [
          {
            type: "choice",
            name: "achievement",
            choice: "yes",
            probabilities: [{ value: "yes", probability: 1.5 }],
          },
        ],
      }),
    ]) {
      const { decisions } = client(
        () =>
          new Response(body, {
            headers: { "content-type": "application/json" },
          }),
      );
      expect(
        (await failure(decisions.decide("wej_token", REQUEST))).reason,
      ).toBe("bad_response");
    }
  });
});
